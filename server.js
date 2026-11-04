import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { GameError, RoomManager } from './src/game.js';
import { log, query } from './src/logger.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));
const MAX_WS_PER_IP = 10;
const BUCKET = { capacity: 40, perSecond: 20 };

const digest = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

export function createServer(opts = {}) {
  const trust = Number(process.env.TRUST_PROXY || 0);
  const lim = { api: 120, create: 20, join: 40, admin: 20, ...opts.limits };
  const manager = new RoomManager({ game: opts.game, limits: opts.limits });

  const limiter = (windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
    });

  const clientIp = (req) => {
    if (trust > 0) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - trust)];
    }
    return req.socket.remoteAddress;
  };

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    const host = (trust > 0 && req.headers['x-forwarded-host']) || req.headers.host;
    try {
      return new URL(origin).host === String(host).split(',')[0].trim();
    } catch {
      return false;
    }
  };

  // ---- HTTP --------------------------------------------------------------

  const app = express();
  app.set('trust proxy', trust);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          imgSrc: ["'self'", 'data:'],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  const admin = express.Router();
  admin.use(limiter(15 * 60_000, lim.admin));
  admin.use((req, res, next) => {
    const pass = process.env.ADMIN_PASS;
    if (!pass) return res.sendStatus(404);
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    const creds = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString() : '';
    const i = creds.indexOf(':');
    const userOk = same(i < 0 ? '' : creds.slice(0, i), process.env.ADMIN_USER || 'admin');
    const passOk = same(i < 0 ? '' : creds.slice(i + 1), pass);
    if (i >= 0 && userOk && passOk) return next();
    res.set('WWW-Authenticate', 'Basic realm="admin"').sendStatus(401);
  });
  admin.get('/logs', (req, res) => {
    const entries = query({ room: req.query.room || undefined, limit: Math.min(Number(req.query.limit) || 200, 5000) });
    if (req.query.format === 'json') return res.json(entries);
    res.type('text/plain').send(
      entries.map((e) => `${new Date(e.ts).toISOString()} [${e.room ?? '-'}] ${e.event} ${JSON.stringify(e.data)}`).join('\n'),
    );
  });
  admin.get('/rooms', (req, res) => res.json(manager.list()));
  app.use('/admin', admin);

  const joined = ({ room, player }, status) => ({ status, body: { code: room.code, playerId: player.id, token: player.token } });
  const api = express.Router();
  api.use(limiter(60_000, lim.api));
  api.use(express.json({ limit: '1kb' }));
  api.post('/rooms', limiter(3_600_000, lim.create), (req, res) => {
    const { status, body } = joined(manager.create(req.body?.name), 201);
    res.status(status).json(body);
  });
  api.post('/rooms/:code/join', limiter(600_000, lim.join), (req, res) => {
    const { status, body } = joined(manager.join(req.params.code, req.body?.name), 200);
    res.status(status).json(body);
  });
  app.use('/api', api);

  if (process.env.DEV) {
    // reloads on public/ edits, and on reconnect after `node --watch` restarts the server
    const clients = new Set();
    let timer;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => clients.forEach((res) => res.write('data: reload\n\n')), 100);
    };
    // ponytail: polling because inotify doesn't fire on /mnt/c under WSL; files added later need a restart
    for (const f of fs.readdirSync(PUBLIC_DIR, { recursive: true })) fs.watchFile(path.join(PUBLIC_DIR, f), { interval: 300 }, reload);
    app.get('/dev/reload', (req, res) => {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }).flushHeaders();
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
    app.get('/dev/reload.js', (req, res) =>
      res.type('js').send("let up=false;const es=new EventSource('/dev/reload');es.onmessage=()=>location.reload();es.onopen=()=>{if(up)location.reload();up=true;};"),
    );
    app.get(['/', '/index.html'], (req, res) =>
      res.type('html').send(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace('</body>', '<script src="/dev/reload.js"></script></body>')),
    );
  }

  app.use(express.static(PUBLIC_DIR));

  app.use((err, req, res, next) => {
    if (err instanceof GameError) return res.status(err.status).json({ error: err.code });
    if (err.status >= 400 && err.status < 500) return res.status(400).json({ error: 'bad_name' }); // bad/oversized JSON body
    log('http_error', { message: String(err.message) });
    res.status(500).json({ error: 'server_error' });
  });

  // ---- WebSocket ---------------------------------------------------------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.on('error', () => {});
    if (!sameOrigin(req)) return ws.close(4003, 'bad_origin');
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= MAX_WS_PER_IP) return ws.close(1008, 'too_many_connections');
    perIp.set(ip, (perIp.get(ip) || 0) + 1);

    let session = null;
    let tokens = BUCKET.capacity;
    let last = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const helloTimer = setTimeout(() => ws.close(4008, 'hello_timeout'), 5000);

    const sendError = (code) => ws.send(JSON.stringify({ t: 'error', code }));
    const badSession = () => {
      sendError('bad_session');
      ws.close(4003, 'bad_session');
    };

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(BUCKET.capacity, tokens + ((now - last) / 1000) * BUCKET.perSecond);
      last = now;
      if (tokens < 1) return ws.close(1008, 'rate_limited');
      tokens--;

      let msg;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(1007, 'bad_json');
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        return session ? sendError('bad_message') : badSession();
      }

      if (!session) {
        if (msg.t !== 'hello') return badSession();
        const room = manager.get(msg.code);
        const player = room?.authenticate(msg.token);
        if (!player) return badSession();
        clearTimeout(helloTimer);
        session = { room, player };
        room.attach(player.id, ws);
        return;
      }

      try {
        session.room.handle(session.player, msg);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        sendError(err.code);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const n = (perIp.get(ip) || 1) - 1;
      if (n) perIp.set(ip, n);
      else perIp.delete(ip);
      session?.room.detach(session.player.id, ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    app,
    server,
    manager,
    listen(port = opts.port ?? 0) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(heartbeat);
      manager.close(); // closes player sockets with 4000
      for (const ws of wss.clients) if (ws.readyState === 1) ws.terminate(); // sockets without a session
      const force = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        server.closeAllConnections?.();
      }, 1000);
      force.unref();
      return new Promise((resolve) => {
        wss.close();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createServer();
  const port = await app.listen(Number(process.env.PORT || 3000));
  log('server_listening', { port });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
