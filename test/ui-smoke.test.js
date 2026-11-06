// UI smoke tests: render every view under jsdom with fake snapshots.
// Requires devDependency "jsdom" and public/vendor/preact-htm.js (npm run vendor).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let dom;
let P; // preact
let dial;
let views;
let viewsMod;

before(async () => {
  const { JSDOM } = await import('jsdom');
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost:3000/' });
  const w = dom.window;
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('window', w);
  def('document', w.document);
  def('localStorage', w.localStorage);
  def('location', w.location);
  def('navigator', w.navigator);
  for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Event']) def(k, w[k]);
  P = await import('../public/vendor/preact-htm.js');
  dial = await import('../public/dial.js');
  viewsMod = await import('../public/views.js');
  views = viewsMod.views;
});

after(() => {
  if (dom) dom.window.close();
});

// ---------- fixtures ----------
const zones = [
  { points: 4, halfWidth: 4 },
  { points: 3, halfWidth: 10 },
  { points: 2, halfWidth: 18 },
];
const config = { zones, writingSeconds: 120, maxClueLength: 60, minPlayers: 3, maxPlayers: 8, cluesPerPlayer: 2 };
const players = [
  { id: 'p1', name: 'Оля', color: 0, connected: true, isHost: true, submitted: true },
  { id: 'p2', name: 'Богдан', color: 1, connected: true, isHost: false, submitted: false },
  { id: 'p3', name: 'Ірина', color: 2, connected: false, isHost: false, submitted: false },
];
function snap(extra) {
  return { t: 'state', now: Date.now(), code: '1234', phase: 'lobby', hostId: 'p1', you: 'p1', deadline: null, config, players, ...extra };
}
const task = { id: 't1', authorId: 'p2', left: 'Гаряче', right: 'Холодне', clue: 'Борщ' };
const result = { teamAngle: 80, distance: 7.5, points: 3, votes: { p1: 78, p3: 90 } };

async function mount(V, props, check) {
  const c = document.createElement('div');
  document.body.appendChild(c);
  P.render(P.html`<${V} ...${props} />`, c);
  await new Promise((r) => setTimeout(r, 30));
  try {
    await check(c, c.textContent);
  } finally {
    P.render(null, c);
    c.remove();
  }
}

// ---------- pure helpers ----------
test('pointsWord plural forms', () => {
  const w = dial.pointsWord;
  assert.equal(w(1), 'бал');
  assert.equal(w(21), 'бал');
  assert.equal(w(2), 'бали');
  assert.equal(w(4), 'бали');
  assert.equal(w(22), 'бали');
  assert.equal(w(0), 'балів');
  assert.equal(w(5), 'балів');
  assert.equal(w(11), 'балів');
  assert.equal(w(12), 'балів');
  assert.equal(w(14), 'балів');
  assert.equal(w(25), 'балів');
});

test('angleFromPoint and pointAt are consistent', () => {
  assert.equal(dial.angleFromPoint(30, 200), 0);
  assert.equal(dial.angleFromPoint(370, 200), 180);
  assert.equal(dial.angleFromPoint(200, 30), 90);
  assert.equal(dial.angleFromPoint(100, 215), 0); // below horizon, left
  assert.equal(dial.angleFromPoint(300, 215), 180); // below horizon, right
  for (let a = 0; a <= 180; a += 1) {
    const [x, y] = dial.pointAt(a, 100);
    assert.equal(dial.angleFromPoint(x, y), a);
  }
  const [x0, y0] = dial.pointAt(0, 170);
  assert.ok(Math.abs(x0 - 30) < 1e-9 && Math.abs(y0 - 200) < 1e-9);
});

test('clampAngle and colorOf', () => {
  assert.equal(dial.clampAngle(-5), 0);
  assert.equal(dial.clampAngle(300), 180);
  assert.equal(dial.clampAngle(90.6), 91);
  assert.equal(dial.colorOf(0), dial.colorOf(12));
  assert.equal(dial.colorOf(-1), dial.colorOf(11));
  assert.match(dial.colorOf(3), /^#[0-9a-f]{6}$/i);
});

test('verdict and time formatting', () => {
  assert.ok(viewsMod.verdictFor(100).length > 5);
  assert.notEqual(viewsMod.verdictFor(100), viewsMod.verdictFor(0));
  assert.equal(viewsMod.formatTime(75), '1:15');
  assert.equal(viewsMod.formatTime(-3), '0:00');
});

// ---------- views ----------
test('Home renders and prefills code', async () => {
  await mount(views.Home, { s: { name: 'Оля', prefill: '1234' } }, (c, text) => {
    assert.match(text, /Створити гру/);
    assert.match(text, /Приєднатися/);
    assert.equal(c.querySelector('.code-input').value, '1234');
  });
});

test('Lobby (host) renders', async () => {
  await mount(views.lobby, { g: snap({}) }, (c, text) => {
    assert.match(text, /1234/);
    assert.match(text, /Ведучий/);
    assert.match(text, /Почати гру/);
    assert.match(text, /Скопіювати посилання/);
    assert.match(text, /Оля \(ви\)/);
  });
});

test('Lobby (guest, too few players) shows waiting text', async () => {
  await mount(views.lobby, { g: snap({ you: 'p2' }) }, (c, text) => {
    assert.match(text, /Чекаємо, поки хост/);
    assert.doesNotMatch(text, /Почати гру/);
  });
  await mount(views.lobby, { g: snap({ players: players.slice(0, 2) }) }, (c) => {
    const btn = [...c.querySelectorAll('button')].find((b) => /Почати гру/.test(b.textContent));
    assert.ok(btn && btn.disabled);
  });
});

test('Writing renders tasks, dials and limits', async () => {
  const g = snap({
    phase: 'writing',
    you: 'p2',
    deadline: Date.now() + 90000,
    myTasks: [
      { id: 'a', left: 'Гаряче', right: 'Холодне', target: 42, clue: 'чернетка' },
      { id: 'b', left: 'Добре', right: 'Погано', target: 120, clue: '' },
    ],
    readyClues: 2,
    totalClues: 6,
  });
  await mount(views.writing, { g }, (c, text) => {
    assert.match(text, /Придумайте підказки/);
    assert.match(text, /Готово підказок: 2\/6/);
    assert.match(text, /1 \/ 2/);
    assert.match(text, /1:\d\d/);
    assert.equal(c.querySelectorAll('svg.dial').length, 1);
    const inputs = c.querySelectorAll('input.clue-input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].value, 'чернетка');
    assert.equal(inputs[0].getAttribute('maxlength'), '60');
    assert.doesNotMatch(text, /Надіслати/);
  });
  await mount(views.writing, { g }, async (c) => {
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'Далі').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.match(c.textContent, /2 \/ 2/);
    assert.match(c.textContent, /Назад/);
    const btn = [...c.querySelectorAll('button')].find((b) => /Надіслати/.test(b.textContent));
    assert.ok(btn.disabled, 'submit disabled while a clue is empty');
  });
});

test('Writing after submit shows waiting message', async () => {
  const me = { ...players[0], submitted: true };
  const g = snap({
    phase: 'writing',
    deadline: Date.now() + 5000,
    players: [me, players[1], players[2]],
    myTasks: [{ id: 'a', left: 'Л', right: 'П', target: 42, clue: 'готово' }],
    readyClues: 1,
    totalClues: 6,
  });
  await mount(views.writing, { g }, (c, text) => {
    assert.match(text, /Підказки надіслано/);
    assert.ok(c.querySelector('input.clue-input').disabled);
    assert.equal(c.querySelectorAll('svg.dial').length, 0);
  });
});

test('Voting as guesser: interactive dial and lock button', async () => {
  const g = snap({
    phase: 'voting',
    round: { index: 0, total: 3, score: 0, task, votes: [{ playerId: 'p3', angle: 100, locked: true }] },
  });
  await mount(views.voting, { g }, (c, text) => {
    assert.match(text, /1 \/ 3/);
    assert.match(text, /Борщ/);
    assert.match(text, /Готово/);
    assert.match(text, /Продовжити, ігноруючи тих, хто ще не готовий/);
    assert.ok(c.querySelector('.team-needle'), 'live team arrow from other votes');
    const slider = c.querySelector('[role="slider"]');
    assert.ok(slider);
    assert.equal(slider.getAttribute('aria-valuenow'), '90');
    assert.equal(c.querySelectorAll('.needle').length, 2);
  });
});

test('Voting as locked guesser shows "Змінити"', async () => {
  const g = snap({
    phase: 'voting',
    you: 'p3',
    round: { index: 1, total: 3, score: 3, task, votes: [{ playerId: 'p3', angle: 61, locked: true }] },
  });
  await mount(views.voting, { g }, (c, text) => {
    assert.match(text, /Змінити/);
    assert.doesNotMatch(text, /Продовжити, ігноруючи тих, хто ще не готовий/);
    assert.equal(c.querySelector('[role="slider"]').getAttribute('aria-valuenow'), '61');
  });
});

test('Voting as author: sees target, no lock button', async () => {
  const g = snap({
    phase: 'voting',
    you: 'p2',
    hostId: 'p1',
    round: {
      index: 0,
      total: 3,
      score: 0,
      task: { ...task, target: 70 },
      votes: [{ playerId: 'p1', angle: 60, locked: false }],
    },
  });
  await mount(views.voting, { g }, (c, text) => {
    assert.ok(![...c.querySelectorAll('button')].some((b) => b.textContent === 'Готово'));
    assert.ok(c.querySelectorAll('.zone-wedge').length >= 3);
    assert.equal(c.querySelectorAll('.needle').length, 1);
  });
});

test('Reveal renders points, team needle and next button', async () => {
  const g = snap({
    phase: 'reveal',
    round: {
      index: 0,
      total: 3,
      score: 3,
      task: { ...task, target: 75 },
      votes: [],
      result,
      reactions: ['🔥', '😎', '👏'],
    },
  });
  await mount(views.reveal, { g }, (c, text) => {
    assert.match(text, /\+3/);
    assert.match(text, /бали/);
    assert.match(text, /Далі/);
    assert.ok(c.querySelector('.team-needle'));
    assert.ok(c.querySelector('.pop'));
    assert.equal(c.querySelectorAll('button.reaction').length, 3); // live palette for players
  });
});

test('Reveal last round / already ready', async () => {
  const round = { index: 2, total: 3, score: 9, task: { ...task, target: 75 }, votes: [], result };
  await mount(views.reveal, { g: snap({ phase: 'reveal', round }) }, (c, text) => {
    assert.match(text, /Далі/);
  });
  await mount(views.reveal, { g: snap({ phase: 'reveal', round: { ...round, ready: ['p2'] }, you: 'p2' }) }, (c, text) => {
    assert.match(text, /Чекаємо на інших/);
    assert.match(text, /Готові: 1\/2/);
    assert.doesNotMatch(text, /Далі/);
  });
});

test('Summary replays clues one by one, then shows the verdict', async () => {
  const g = snap({
    phase: 'summary',
    summary: {
      score: 20,
      maxScore: 24,
      tasks: [
        { ...task, id: 'a', target: 75, result, events: [{ playerId: 'p1', emoji: '🔥' }, { playerId: 'p3', emoji: '🎉' }] },
        { ...task, id: 'b', target: 20, clue: 'Сніг', result: { ...result, points: 1 }, events: [{ playerId: 'p1', emoji: '🤡' }] },
      ],
      reactions: ['😂', '👏'],
    },
  });
  await mount(views.summary, { g }, (c, text) => {
    assert.match(text, /1 \/ 2/);
    assert.match(text, /3\/24/); // gauge counts only the first clue so far
    assert.match(text, /\+3 бали/);
    assert.match(text, /Нова гра/);
    assert.match(text, /Вийти/);
    assert.equal(c.querySelectorAll('svg.dial').length, 1);
    assert.equal(c.querySelectorAll('.vgauge-seg').length, 1);
    assert.deepEqual([...c.querySelectorAll('button.reaction')].map((b) => b.textContent), ['😂', '👏']);
    // the first clue replays its own reveal reactions (2), not the verdict card's
    assert.deepEqual([...c.querySelectorAll('.clue-fly i')].map((i) => i.textContent), ['🔥', '🎉']);
  });
  const empty = snap({ phase: 'summary', summary: { score: 0, maxScore: 0, tasks: [], reactions: ['🤡'] } });
  await mount(views.summary, { g: empty }, (c, text) => {
    assert.match(text, /Підсумок гри/);
    assert.ok(text.includes(viewsMod.verdictFor(0)));
    assert.equal(c.querySelectorAll('svg.dial').length, 0);
    assert.equal(c.querySelectorAll('button.reaction').length, 1);
  });
});
