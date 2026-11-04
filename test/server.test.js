import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../server.js';

process.env.LOG_SILENT = '1';

// ---- helpers ---------------------------------------------------------------

async function setup(opts) {
  const s = createServer(opts);
  const port = await s.listen(0);
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, port, post };
}

class Client {
  constructor(port, session) {
    this.session = session;
    this.id = session.playerId;
    this.state = null;
    this.msgs = [];
    this.closeCode = null;
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.msgs.push(m);
      if (m.t === 'state') this.state = m;
      this.flush();
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      this.flush();
    });
    this.open = new Promise((resolve) => this.ws.on('open', resolve));
  }

  async hello(token = this.session.token) {
    await this.open;
    this.send({ t: 'hello', code: this.session.code, token });
    return this;
  }

  send(m) {
    this.ws.send(JSON.stringify(m));
  }

  until(pred, ms = 4000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('timeout waiting for condition')), ms) };
      this.waiters.push(w);
      this.flush();
    });
  }

  flush() {
    for (const w of [...this.waiters]) {
      if (w.pred(this)) {
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this);
      }
    }
  }

  // Send a message and resolve with the error code the server answers with.
  async expectError(msg, code) {
    const n = this.msgs.length;
    this.send(msg);
    await this.until((c) => c.msgs.slice(n).some((m) => m.t === 'error' && m.code === code));
  }
}

const waitAll = (clients, pred) => Promise.all(clients.map((c) => c.until(pred)));

async function lobby(ctx, names) {
  const created = await ctx.post('/api/rooms', { name: names[0] });
  assert.equal(created.status, 201);
  const sessions = [created.body];
  for (const name of names.slice(1)) {
    const joined = await ctx.post(`/api/rooms/${created.body.code}/join`, { name });
    assert.equal(joined.status, 200);
    sessions.push(joined.body);
  }
  const clients = await Promise.all(sessions.map((s) => new Client(ctx.port, s).hello()));
  await waitAll(clients, (c) => c.state?.players.filter((p) => p.connected).length === names.length);
  return clients;
}

const closeAll = async (ctx, clients) => {
  clients.forEach((c) => c.ws.close());
  await ctx.s.close();
};

// ---- tests -----------------------------------------------------------------

test('http validation and errors', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.post('/api/rooms', { name: '   ' })).body.error, 'bad_name');
    assert.equal((await ctx.post('/api/rooms', {})).status, 400);
    const { body } = await ctx.post('/api/rooms', { name: 'Anna' });
    assert.match(body.code, /^\d{4}$/);
    const dup = await ctx.post(`/api/rooms/${body.code}/join`, { name: 'ANNA' });
    assert.deepEqual([dup.status, dup.body.error], [409, 'name_taken']);
    const missing = await ctx.post('/api/rooms/ZZZZ/join', { name: 'Bob' });
    assert.deepEqual([missing.status, missing.body.error], [404, 'room_not_found']);
    assert.equal(await (await fetch(`http://127.0.0.1:${ctx.port}/healthz`)).text(), 'ok');
  } finally {
    await ctx.s.close();
  }
});

test('rate limit and room cap', async () => {
  const ctx = await setup({ limits: { create: 2, maxRooms: 1 } });
  try {
    assert.equal((await ctx.post('/api/rooms', { name: 'A' })).status, 201);
    const full = await ctx.post('/api/rooms', { name: 'B' });
    assert.deepEqual([full.status, full.body.error], [503, 'too_many_rooms']);
    await ctx.post('/api/rooms', { name: 'C' });
    const limited = await ctx.post('/api/rooms', { name: 'D' });
    assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  } finally {
    await ctx.s.close();
  }
});

test('bad session is rejected', async () => {
  const ctx = await setup();
  try {
    const { body } = await ctx.post('/api/rooms', { name: 'Anna' });
    const c = await new Client(ctx.port, body).hello('nope');
    await c.until((x) => x.closeCode !== null);
    assert.equal(c.closeCode, 4003);
    assert.ok(c.msgs.some((m) => m.t === 'error' && m.code === 'bad_session'));
  } finally {
    await ctx.s.close();
  }
});

test('full game flow with scoring, hidden target and shared advance', async () => {
  const ctx = await setup();
  const clients = await lobby(ctx, ['Anna', 'Bob', 'Cleo']);
  const [host, bob] = clients;
  try {
    await bob.expectError({ t: 'start' }, 'not_host');
    host.send({ t: 'start' });
    await waitAll(clients, (c) => c.state.phase === 'writing');

    for (const c of clients) {
      assert.equal(c.state.myTasks.length, 3);
      assert.ok(c.state.myTasks.every((t) => Number.isInteger(t.target)));
      assert.equal(c.state.round, undefined);
    }
    const spectrums = clients.flatMap((c) => c.state.myTasks.map((t) => t.left + t.right));
    assert.equal(new Set(spectrums).size, 9);
    await bob.expectError({ t: 'vote', angle: 10 }, 'bad_phase');

    for (const [i, c] of clients.entries()) {
      c.send({ t: 'submit', clues: [`clue ${i} a`, `clue ${i} b`, `clue ${i} c`] });
    }
    await waitAll(clients, (c) => c.state.phase === 'voting');
    await host.expectError({ t: 'submit', clues: ['x'] }, 'bad_phase');

    const offsets = [0, 8, 15, 30]; // -> 4, 3, 2, 0 points
    const expected = [4, 3, 2, 0];
    let total = 0;
    for (let i = 0; i < 9; i++) {
      await waitAll(clients, (c) => c.state.phase === 'voting' && c.state.round.index === i);
      const { authorId } = host.state.round.task;
      assert.equal(authorId, clients[i % 3].id); // round-robin in join order
      assert.equal(host.state.round.task.clue, `clue ${i % 3} ${'abc'[Math.floor(i / 3)]}`);
      const author = clients.find((c) => c.id === authorId);
      const voters = clients.filter((c) => c !== author);
      const target = author.state.round.task.target;
      assert.ok(Number.isInteger(target));
      for (const v of voters) {
        assert.equal(v.state.round.task.target, undefined);
        assert.ok(!JSON.stringify(v.state).includes('"target"'));
      }
      await author.expectError({ t: 'lock', locked: true, angle: 90 }, 'author_cannot_vote');
      await voters[0].expectError({ t: 'lock', locked: false }, 'no_vote');
      await voters[0].expectError({ t: 'vote', angle: 999 }, 'bad_angle');

      if (i < offsets.length) {
        const angle = target + (target <= 90 ? 1 : -1) * offsets[i];
        voters[0].send({ t: 'lock', locked: true, angle });
        await host.until((c) => c.state.round.votes.some((v) => v.locked)); // not everyone locked yet
        assert.equal(host.state.phase, 'voting');
        voters[1].send({ t: 'lock', locked: true, angle });
      } else if (i === offsets.length) {
        // live relay goes to everyone except the sender
        const [a, b] = voters;
        const mark = [author.msgs.length, b.msgs.length];
        a.send({ t: 'vote', angle: 77.4 });
        await author.until((c) => c.msgs.slice(mark[0]).some((m) => m.t === 'vote'));
        await b.until((c) => c.msgs.slice(mark[1]).some((m) => m.t === 'vote'));
        const relay = b.msgs.slice(mark[1]).find((m) => m.t === 'vote');
        assert.deepEqual(relay, { t: 'vote', playerId: a.id, angle: 77, locked: false });
        const n = a.msgs.length;
        a.send({ t: 'ping' });
        await a.until((c) => c.msgs.slice(n).some((m) => m.t === 'pong'));
        assert.ok(!a.msgs.slice(n).some((m) => m.t === 'vote'));
        await bob.expectError({ t: 'advance' }, 'not_host');
        host.send({ t: 'advance' }); // force reveal
      } else {
        host.send({ t: 'advance' }); // force reveal without any votes
      }

      await waitAll(clients, (c) => c.state.phase === 'reveal' && c.state.round.index === i);
      const { result } = host.state.round;
      assert.equal(host.state.round.task.target, target);
      if (i < offsets.length) {
        assert.equal(result.points, expected[i]);
        assert.equal(result.distance, offsets[i]);
        assert.equal(result.teamAngle, target + (target <= 90 ? 1 : -1) * offsets[i]);
        assert.equal(Object.keys(result.votes).length, 2);
      } else if (i > offsets.length) {
        assert.deepEqual(result, { teamAngle: null, distance: null, points: 0, votes: {} });
      } else {
        assert.equal(result.teamAngle, 77);
      }
      total += result.points;
      if (i === 0) {
        assert.ok(host.state.round.reactions.includes('🎯')); // 4 points -> great set
        await bob.expectError({ t: 'react', emoji: '🍕' }, 'bad_message');
        const mark = host.msgs.length;
        bob.send({ t: 'react', emoji: '🎯' });
        await host.until((c) => c.msgs.slice(mark).some((m) => m.t === 'react' && m.emoji === '🎯' && m.playerId === bob.id));
      } else if (i > offsets.length) {
        assert.ok(host.state.round.reactions.includes('🤡')); // miss -> nasty set
      }
      for (const c of clients) assert.equal(c.state.round.score, total);

      bob.send({ t: 'advance' });
      await host.until((c) => c.state.round.ready?.includes(bob.id));
      assert.equal(host.state.phase, 'reveal');
      for (const c of clients) if (c !== bob) c.send({ t: 'advance' });
    }

    await waitAll(clients, (c) => c.state.phase === 'summary');
    const { summary } = host.state;
    assert.equal(summary.maxScore, 36);
    assert.equal(summary.score, total);
    assert.equal(summary.tasks.length, 9);
    assert.ok(summary.tasks.every((t) => t.clue && Number.isInteger(t.target) && t.result && t.reactions.length));
    assert.ok(summary.reactions.length);
    const mark = host.msgs.length;
    clients[2].send({ t: 'react', emoji: '🤡' }); // any known emoji is fine on the summary; not bob, who may still be throttled
    await host.until((c) => c.msgs.slice(mark).some((m) => m.t === 'react' && m.emoji === '🤡'));

    await bob.expectError({ t: 'new_game' }, 'not_host');
    host.send({ t: 'new_game' });
    await waitAll(clients, (c) => c.state.phase === 'lobby' && c.state.summary === undefined);
    assert.equal(host.state.players.length, 3);
  } finally {
    await closeAll(ctx, clients);
  }
});

test('auto-reveal when all required voters locked; reveal timer moves on', async () => {
  const ctx = await setup({ game: { revealSeconds: 1 } });
  const clients = await lobby(ctx, ['Anna', 'Bob']);
  try {
    clients[0].send({ t: 'start' });
    await waitAll(clients, (c) => c.state.phase === 'writing');
    clients[0].send({ t: 'submit', clues: ['one', 'two', 'three'] });
    clients[1].send({ t: 'draft', clues: ['draft only'] });
    await clients[1].until((c) => c.state.phase === 'writing');
    clients[1].send({ t: 'submit', clues: ['a', '', ''] });
    await waitAll(clients, (c) => c.state.phase === 'voting');
    assert.equal(clients[0].state.round.total, 4); // 3 + 1, empty clues dropped

    const { authorId } = clients[0].state.round.task;
    const voter = clients.find((c) => c.id !== authorId);
    voter.send({ t: 'lock', locked: true, angle: 100 });
    await waitAll(clients, (c) => c.state.phase === 'reveal');
    assert.equal(voter.state.round.result.teamAngle, 100);
    assert.ok(voter.state.deadline > voter.state.now);
    await waitAll(clients, (c) => c.state.phase === 'voting' && c.state.round.index === 1);
    assert.equal(voter.state.deadline, null);
  } finally {
    await closeAll(ctx, clients);
  }
});

test('join after start is rejected', async () => {
  const ctx = await setup();
  const clients = await lobby(ctx, ['Anna', 'Bob']);
  try {
    clients[0].send({ t: 'start' });
    await waitAll(clients, (c) => c.state.phase === 'writing');
    const late = await ctx.post(`/api/rooms/${clients[0].session.code}/join`, { name: 'Late' });
    assert.deepEqual([late.status, late.body.error], [409, 'game_started']);
  } finally {
    await closeAll(ctx, clients);
  }
});

test('reconnect with hello replaces the old socket', async () => {
  const ctx = await setup();
  const clients = await lobby(ctx, ['Anna', 'Bob']);
  const again = await new Client(ctx.port, clients[1].session).hello();
  try {
    await clients[1].until((c) => c.closeCode === 4001);
    await again.until((c) => c.state?.you === clients[1].id);
    await clients[0].until((c) => c.state.players.every((p) => p.connected));
  } finally {
    await closeAll(ctx, [...clients, again]);
  }
});

test('lobby leave migrates host', async () => {
  const ctx = await setup();
  const clients = await lobby(ctx, ['Anna', 'Bob']);
  try {
    clients[0].send({ t: 'leave' });
    await clients[1].until((c) => c.state.players.length === 1 && c.state.hostId === clients[1].id);
  } finally {
    await closeAll(ctx, clients);
  }
});

test('writing deadline ends the phase and counts drafts', async () => {
  const ctx = await setup({ game: { writingSeconds: 1 } });
  const clients = await lobby(ctx, ['Anna', 'Bob']);
  try {
    clients[0].send({ t: 'start' });
    await waitAll(clients, (c) => c.state.phase === 'writing');
    assert.ok(clients[0].state.deadline > clients[0].state.now);
    clients[0].send({ t: 'submit', clues: ['x', '', ''] });
    clients[1].send({ t: 'draft', clues: ['y'] });
    await waitAll(clients, (c) => c.state.phase === 'voting');
    assert.equal(clients[0].state.round.total, 2);
    assert.equal(clients[0].state.deadline, null);
  } finally {
    await closeAll(ctx, clients);
  }
});
