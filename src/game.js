import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GAME, LIMITS, cluesPerPlayer } from './config.js';
import { log } from './logger.js';

const SPECTRUMS = JSON.parse(readFileSync(new URL('./spectrums.json', import.meta.url), 'utf8'));
const CODE_ALPHABET = '0123456789';
const DEFAULT_GRACE_MS = 5 * 60_000;

export class GameError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Collapse whitespace, strip control/format chars, trim, cut by code points.
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return [...text].slice(0, max).join('').trim();
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const digest = (s) => createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));
const round1 = (x) => Math.round(x * 10) / 10;

function parseAngle(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new GameError('bad_angle');
  const angle = Math.round(v);
  if (angle < 0 || angle > 180) throw new GameError('bad_angle');
  return angle;
}

export class Room {
  constructor(code, cfg, onEmpty = () => {}) {
    this.code = code;
    this.cfg = cfg;
    this.onEmpty = onEmpty;
    this.players = new Map(); // insertion order = join order
    this.hostId = null;
    this.phase = 'lobby';
    this.tasks = [];
    this.roundIndex = 0;
    this.votes = new Map(); // playerId -> {angle, locked}
    this.ready = new Set(); // playerIds done discussing the reveal
    this.deadline = null;
    this.phaseTimer = null;
    this.joined = 0;
    this.createdAt = this.touched = Date.now();
  }

  touch() {
    this.touched = Date.now();
  }

  // ---- players -----------------------------------------------------------

  addPlayer(name) {
    const clean = cleanText(name, this.cfg.maxNameLength);
    if (!clean) throw new GameError('bad_name', 400);
    if (this.phase !== 'lobby') throw new GameError('game_started', 409);
    if (this.players.size >= this.cfg.maxPlayers) throw new GameError('room_full', 403);
    const lower = clean.toLowerCase();
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === lower)) {
      throw new GameError('name_taken', 409);
    }
    const p = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(16).toString('hex'),
      name: clean,
      color: this.joined++,
      connected: false,
      submitted: false,
      ws: null,
      timer: null,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.armTimer(p);
    this.touch();
    log('player_joined', { playerId: p.id, players: this.players.size }, this.code);
    if (this.phase === 'lobby') this.broadcast();
    return p;
  }

  authenticate(token) {
    if (typeof token !== 'string') return null;
    return [...this.players.values()].find((p) => !p.left && safeEqual(p.token, token)) ?? null;
  }

  armTimer(p) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.expire(p), this.cfg.graceMs ?? DEFAULT_GRACE_MS);
    p.timer.unref();
  }

  expire(p) {
    p.timer = null;
    if (p.connected || this.players.get(p.id) !== p) return;
    if (this.phase === 'lobby') {
      // Phones drop the socket on screen lock; if nobody is online, keep the room and retry later.
      // The idle sweep (IDLE_TTL_MIN) still closes abandoned rooms.
      if (![...this.players.values()].some((q) => q.connected)) return this.armTimer(p);
      return this.removePlayer(p.id);
    }
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((q) => q.connected);
      if (next) {
        this.hostId = next.id;
        log('host_migrated', { to: next.id }, this.code);
        this.broadcast();
      }
    }
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.players.delete(id);
    log('player_removed', { playerId: id }, this.code);
    if (!this.players.size) return this.onEmpty();
    if (this.hostId === id) {
      const all = [...this.players.values()];
      this.hostId = (all.find((q) => q.connected) ?? all[0]).id;
    }
    this.broadcast();
  }

  attach(id, ws) {
    const p = this.players.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    p.timer = null;
    if (p.ws && p.ws !== ws) p.ws.close(4001, 'replaced');
    p.ws = ws;
    p.connected = true;
    this.touch();
    this.broadcast();
    return true;
  }

  detach(id, ws) {
    const p = this.players.get(id);
    if (!p || p.ws !== ws) return; // already replaced or removed
    p.ws = null;
    p.connected = false;
    this.armTimer(p);
    if (!this.checkReveal() && !this.checkReady()) this.broadcast();
  }

  destroy() {
    clearTimeout(this.phaseTimer);
    for (const p of this.players.values()) {
      clearTimeout(p.timer);
      const ws = p.ws;
      p.ws = null;
      p.connected = false;
      ws?.close(4000, 'room_closed');
    }
  }

  // ---- messaging ---------------------------------------------------------

  send(p, msg) {
    if (p.ws?.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast() {
    for (const p of this.players.values()) this.send(p, this.snapshot(p));
  }

  handle(p, msg) {
    if (this.players.get(p.id) !== p) return;
    this.touch();
    switch (msg.t) {
      case 'ping': return this.send(p, { t: 'pong' });
      case 'start': return this.start(p);
      case 'draft': return this.saveClues(p, msg.clues, false);
      case 'submit': return this.saveClues(p, msg.clues, true);
      case 'vote': return this.vote(p, msg.angle);
      case 'lock': return this.lock(p, msg.locked, msg.angle);
      case 'advance': return this.advance(p, msg.force === true);
      case 'react': return this.react(p, msg.emoji);
      case 'new_game': return this.newGame(p);
      case 'leave': return this.leave(p);
      default: throw new GameError('bad_message');
    }
  }

  requireHost(p) {
    if (p.id !== this.hostId) throw new GameError('not_host');
  }

  // ---- lobby & writing ---------------------------------------------------

  start(p) {
    this.requireHost(p);
    if (this.phase !== 'lobby') throw new GameError('bad_phase');
    if (this.players.size < this.cfg.minPlayers) throw new GameError('not_enough_players');
    const per = cluesPerPlayer(this.players.size);
    const pool = shuffle(SPECTRUMS);
    this.tasks = [];
    for (const player of this.players.values()) {
      player.submitted = false;
      for (let i = 0; i < per; i++) {
        const [left, right] = pool.pop();
        this.tasks.push({
          id: `t${this.tasks.length}`,
          authorId: player.id,
          left,
          right,
          target: randomInt(this.cfg.targetMin, this.cfg.targetMax + 1),
          clue: '',
          result: null,
          reactions: [], // {playerId, emoji} sent after this task's reveal
        });
      }
    }
    this.phase = 'writing';
    this.setDeadline(this.cfg.writingSeconds, () => this.endWriting());
    log('game_started', { players: this.players.size, tasks: this.tasks.length }, this.code);
    this.broadcast();
  }

  saveClues(p, clues, final) {
    if (this.phase !== 'writing') throw new GameError('bad_phase');
    if (!Array.isArray(clues) || clues.length > 20 || !clues.every((c) => typeof c === 'string')) {
      throw new GameError('bad_message');
    }
    if (p.submitted) {
      if (final) throw new GameError('already_submitted');
      return;
    }
    this.tasks
      .filter((t) => t.authorId === p.id)
      .forEach((t, i) => (t.clue = cleanText(clues[i] ?? '', this.cfg.maxClueLength)));
    if (!final) return;
    p.submitted = true;
    log('clues_submitted', { playerId: p.id, lengths: this.tasks.filter((t) => t.authorId === p.id).map((t) => t.clue.length) }, this.code);
    if ([...this.players.values()].every((q) => q.submitted)) this.endWriting();
    else this.broadcast();
  }

  setDeadline(seconds, fn) {
    clearTimeout(this.phaseTimer);
    this.deadline = Date.now() + seconds * 1000;
    this.phaseTimer = setTimeout(fn, seconds * 1000);
    this.phaseTimer.unref();
  }

  clearDeadline() {
    clearTimeout(this.phaseTimer);
    this.deadline = null;
  }

  endWriting() {
    if (this.phase !== 'writing') return;
    this.clearDeadline();
    // Round-robin in join order: everyone's 1st clue, then everyone's 2nd, ...
    const byAuthor = [...this.players.keys()].map((id) => this.tasks.filter((t) => t.authorId === id && t.clue));
    const rounds = Math.max(0, ...byAuthor.map((a) => a.length));
    this.tasks = Array.from({ length: rounds }, (_, k) => byAuthor.map((a) => a[k]).filter(Boolean)).flat();
    this.roundIndex = 0;
    this.votes = new Map();
    this.phase = this.tasks.length ? 'voting' : 'summary';
    log('writing_ended', { rounds: this.tasks.length }, this.code);
    this.broadcast();
  }

  // ---- voting ------------------------------------------------------------

  get task() {
    return this.tasks[this.roundIndex];
  }

  voter(p) {
    if (this.phase !== 'voting') throw new GameError('bad_phase');
    if (p.id === this.task.authorId) throw new GameError('author_cannot_vote');
  }

  vote(p, angle) {
    this.voter(p);
    angle = parseAngle(angle);
    if (this.votes.get(p.id)?.locked) return;
    this.votes.set(p.id, { angle, locked: false });
    const relay = { t: 'vote', playerId: p.id, angle, locked: false };
    for (const q of this.players.values()) if (q !== p) this.send(q, relay);
  }

  lock(p, locked, angle) {
    this.voter(p);
    if (typeof locked !== 'boolean') throw new GameError('bad_message');
    if (locked) {
      this.votes.set(p.id, { angle: parseAngle(angle), locked: true });
    } else {
      const v = this.votes.get(p.id);
      if (!v) throw new GameError('no_vote');
      v.locked = false;
    }
    if (!this.checkReveal()) this.broadcast();
  }

  // Reveal automatically once every connected non-author voter has locked.
  checkReveal() {
    if (this.phase !== 'voting') return false;
    const required = [...this.players.values()].filter((p) => p.connected && p.id !== this.task.authorId);
    if (!required.length || !required.every((p) => this.votes.get(p.id)?.locked)) return false;
    this.reveal();
    return true;
  }

  reveal() {
    const task = this.task;
    const entries = [...this.votes.entries()];
    let result = { teamAngle: null, distance: null, points: 0, votes: {} };
    if (entries.length) {
      const teamAngle = round1(entries.reduce((s, [, v]) => s + v.angle, 0) / entries.length);
      const distance = round1(Math.abs(teamAngle - task.target));
      const zone = [...this.cfg.zones].sort((a, b) => a.halfWidth - b.halfWidth).find((z) => distance <= z.halfWidth);
      result = {
        teamAngle,
        distance,
        points: zone?.points ?? 0,
        votes: Object.fromEntries(entries.map(([id, v]) => [id, v.angle])),
      };
    }
    task.result = result;
    this.phase = 'reveal';
    this.ready = new Set();
    this.setDeadline(this.cfg.revealSeconds, () => this.nextRound());
    log('round_revealed', { round: this.roundIndex, points: result.points, voters: entries.length }, this.code);
    this.broadcast();
  }

  // ---- host controls -----------------------------------------------------

  advance(p, force) {
    if (this.phase === 'reveal' && !force) {
      this.ready.add(p.id);
      if (!this.checkReady()) this.broadcast();
      return;
    }
    this.requireHost(p);
    if (this.phase === 'writing') return this.endWriting();
    if (this.phase === 'voting') return this.reveal();
    if (this.phase === 'reveal') return this.nextRound();
    throw new GameError('bad_phase');
  }

  // Emoji set of the highest score bucket not above `points`.
  reactionsFor(points) {
    const { reactions } = this.cfg;
    const keys = Object.keys(reactions).map(Number).sort((a, b) => b - a);
    return reactions[keys.find((k) => k <= points) ?? keys.at(-1)];
  }

  react(p, emoji) {
    const allowed =
      this.phase === 'voting' ? this.cfg.votingReactions
      : this.phase === 'reveal' ? this.reactionsFor(this.task.result.points)
      : this.phase === 'summary' ? this.cfg.summaryReactions
      : null;
    if (!allowed) throw new GameError('bad_phase');
    if (!allowed.includes(emoji)) throw new GameError('bad_message');
    const now = Date.now();
    if (now - (p.lastReact ?? 0) < this.cfg.reactionGapMs) return;
    p.lastReact = now;
    // Store reactions sent after the round reveal so the summary replay can show them per clue.
    if (this.phase === 'reveal' && this.task.reactions.length < 24) this.task.reactions.push({ playerId: p.id, emoji });
    for (const q of this.players.values()) this.send(q, { t: 'react', playerId: p.id, emoji });
  }

  // Next round once every connected player is done discussing the reveal.
  checkReady() {
    if (this.phase !== 'reveal') return false;
    const connected = [...this.players.values()].filter((p) => p.connected);
    if (!connected.every((p) => this.ready.has(p.id))) return false;
    this.nextRound();
    return true;
  }

  nextRound() {
    if (this.phase !== 'reveal') return;
    this.clearDeadline();
    this.roundIndex++;
    this.votes = new Map();
    this.phase = this.roundIndex < this.tasks.length ? 'voting' : 'summary';
    if (this.phase === 'summary') log('game_finished', { score: this.score(this.tasks.length) }, this.code);
    this.broadcast();
  }

  newGame(p) {
    this.requireHost(p);
    if (this.phase !== 'summary') throw new GameError('bad_phase');
    for (const q of [...this.players.values()]) if (!q.connected) this.removePlayer(q.id);
    for (const q of this.players.values()) q.submitted = false;
    this.tasks = [];
    this.roundIndex = 0;
    this.votes = new Map();
    this.phase = 'lobby';
    this.broadcast();
  }

  // Mid-game the leaver stays in the map (marked `left`) so their clues keep a name and colour.
  leave(p) {
    const ws = p.ws;
    p.ws = null;
    p.connected = false;
    ws?.close(1000, 'left');
    if (this.phase === 'lobby') return this.removePlayer(p.id);
    clearTimeout(p.timer);
    p.left = true;
    p.submitted = true; // drafts typed so far still count
    this.votes.delete(p.id);
    this.ready.delete(p.id);
    log('player_left', { playerId: p.id, phase: this.phase }, this.code);
    const active = [...this.players.values()].filter((q) => !q.left);
    if (!active.length) return this.onEmpty();
    if (this.hostId === p.id) this.hostId = (active.find((q) => q.connected) ?? active[0]).id;
    if (active.length < this.cfg.minPlayers && this.phase !== 'summary') {
      this.clearDeadline();
      this.tasks = this.tasks.filter((t) => t.result);
      this.phase = 'summary';
      log('game_finished', { score: this.score(this.tasks.length), reason: 'not_enough_players' }, this.code);
      return this.broadcast();
    }
    if (this.phase === 'writing' && [...this.players.values()].every((q) => q.submitted)) return this.endWriting();
    if (!this.checkReveal() && !this.checkReady()) this.broadcast();
  }

  // ---- snapshot ----------------------------------------------------------

  score(count) {
    return this.tasks.slice(0, count).reduce((s, t) => s + (t.result?.points ?? 0), 0);
  }

  snapshot(viewer) {
    const { cfg, phase } = this;
    const s = {
      t: 'state',
      now: Date.now(),
      code: this.code,
      phase,
      hostId: this.hostId,
      you: viewer.id,
      deadline: phase === 'writing' || phase === 'reveal' ? this.deadline : null,
      config: {
        zones: cfg.zones,
        writingSeconds: cfg.writingSeconds,
        maxClueLength: cfg.maxClueLength,
        minPlayers: cfg.minPlayers,
        maxPlayers: cfg.maxPlayers,
        cluesPerPlayer: cluesPerPlayer(this.players.size),
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        isHost: p.id === this.hostId,
        submitted: p.submitted,
        left: !!p.left,
      })),
    };
    if (phase === 'writing') {
      s.myTasks = this.tasks
        .filter((t) => t.authorId === viewer.id)
        .map(({ id, left, right, target, clue }) => ({ id, left, right, target, clue }));
      s.readyClues = this.tasks.filter((t) => t.clue).length;
      s.totalClues = this.tasks.length;
    }
    if (phase === 'voting' || phase === 'reveal') {
      const t = this.task;
      const revealed = phase === 'reveal';
      s.round = {
        index: this.roundIndex,
        total: this.tasks.length,
        score: this.score(this.roundIndex + (revealed ? 1 : 0)),
        task: { id: t.id, authorId: t.authorId, left: t.left, right: t.right, clue: t.clue },
        votes: [...this.votes].map(([playerId, v]) => ({ playerId, angle: v.angle, locked: v.locked })),
        reactions: cfg.votingReactions,
      };
      if (revealed || viewer.id === t.authorId) s.round.task.target = t.target;
      if (revealed) {
        s.round.result = t.result;
        s.round.ready = [...this.ready];
        s.round.reactions = this.reactionsFor(t.result.points);
      }
    }
    if (phase === 'summary') {
      const max = Math.max(...cfg.zones.map((z) => z.points));
      const score = this.score(this.tasks.length);
      s.summary = {
        score,
        maxScore: max * this.tasks.length,
        reactions: cfg.summaryReactions,
        tasks: this.tasks.map(({ id, authorId, left, right, clue, target, result, reactions }) => ({
          id, authorId, left, right, clue, target, result,
          events: [...(reactions || [])],
          reactions: this.reactionsFor(result?.points ?? 0),
        })),
      };
    }
    return s;
  }
}

export class RoomManager {
  constructor({ game = {}, limits = {} } = {}) {
    this.cfg = { ...GAME, ...game };
    this.limits = { ...LIMITS, ...limits };
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get(code) {
    return this.rooms.get(String(code).toUpperCase());
  }

  create(name) {
    if (this.rooms.size >= this.limits.maxRooms) throw new GameError('too_many_rooms', 503);
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.cfg, () => this.destroy(code, 'empty'));
    const player = room.addPlayer(name); // throws bad_name before the room is stored
    this.rooms.set(code, room);
    log('room_created', { rooms: this.rooms.size }, code);
    return { room, player };
  }

  join(code, name) {
    const room = this.get(code);
    if (!room) throw new GameError('room_not_found', 404);
    return { room, player: room.addPlayer(name) };
  }

  destroy(code, reason) {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    room.destroy();
    log('room_destroyed', { reason }, code);
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (!room.players.size) this.destroy(code, 'empty');
      else if (now - room.touched > this.limits.idleTtlMs) this.destroy(code, 'idle');
      else if (now - room.createdAt > this.limits.maxAgeMs) this.destroy(code, 'age');
    }
  }

  list() {
    const now = Date.now();
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      phase: r.phase,
      players: r.players.size,
      ageSec: Math.round((now - r.createdAt) / 1000),
      idleSec: Math.round((now - r.touched) / 1000),
    }));
  }

  close() {
    clearInterval(this.sweeper);
    for (const code of [...this.rooms.keys()]) this.destroy(code, 'shutdown');
  }
}
