// All screens of the game.
import { html, useState, useEffect, useRef } from './vendor/preact-htm.js';
import { Dial, SpectrumLabels, ZoneLegend, colorOf, pointsWord } from './dial.js';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  startGame,
  saveDraft,
  submitClues,
  sendVote,
  lockVote,
  advance,
  forceAdvance,
  react,
  newGame,
  showToast,
  serverNow,
} from './net.js';

// ---------- helpers ----------

export function verdictFor(pct) {
  if (pct >= 90) return '🤯🤯🤯';
  if (pct >= 70) return 'Відмінно!';
  if (pct >= 50) return 'Добре!';
  if (pct >= 25) return 'Слабенько';
  return 'Повз!';
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function player(g, id) {
  return (g.players || []).find((p) => p.id === id) || null;
}
function nameOf(g, id) {
  const p = player(g, id);
  return p ? p.name : '???';
}
function initialOf(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}
function needleFor(g, id, angle, locked, mine) {
  const p = player(g, id);
  return {
    id,
    angle,
    color: colorOf(p ? p.color : 0),
    initial: initialOf(p ? p.name : '?'),
    mine: !!mine,
    locked: !!locked,
  };
}
function isHost(g) {
  return g.hostId === g.you;
}
function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function useTick(ms) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Timer({ deadline }) {
  useTick(500);
  if (typeof deadline !== 'number') return null;
  const left = Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
  return html`<span class=${'timer' + (left <= 10 ? ' timer-low' : '')} aria-label="Залишилось часу">${formatTime(left)}</span>`;
}

function Avatar({ name, color, small }) {
  return html`<i class=${'avatar' + (small ? ' small-av' : '')} style=${{ background: colorOf(color) }}>${initialOf(name)}</i>`;
}

function LeaveButton({ ask }) {
  const onClick = () => (!ask || confirm('Вийти з гри? Повернутися вже не вийде.')) && leaveRoom();
  return html`<button class="btn btn-ghost" onClick=${onClick}>Вийти з гри</button>`;
}

function ForceButton({ g, label }) {
  return isHost(g) && html`<button class="btn force-btn" onClick=${forceAdvance}>${label}</button>`;
}

// ---------- Home ----------

function Home({ s }) {
  const [name, setName] = useState(s.name || '');
  const [code, setCode] = useState(s.prefill || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (fn) => {
    setErr('');
    setBusy(true);
    let r = null;
    try {
      r = await fn();
    } finally {
      setBusy(false);
    }
    if (r && r.error) setErr(r.message);
  };

  const create = () => {
    if (!name.trim()) return setErr('Введіть своє ім’я.');
    run(() => createRoom(name));
  };
  const join = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!name.trim()) return setErr('Введіть своє ім’я.');
    if (code.length !== 4) return setErr('Код кімнати має містити 4 символи.');
    run(() => joinRoom(code, name));
  };

  return html`<main class="screen home">
    <header class="hero">
      <h1>На одній хвилі</h1>
      <p class="muted">Вгадайте, куди вказує підказка на шкалі.</p>
      <p class="muted">Граємо разом, рахунок спільний.</p>
    </header>
    <section class="card">
      <label class="field">
        <span>Ваше ім’я</span>
        <input
          type="text"
          value=${name}
          maxlength="20"
          autocomplete="nickname"
          onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key !== 'Enter' && e.key !== 'NumpadEnter') return;
            e.preventDefault();
            if (name.trim()) create();
          }}
        />
      </label>
    </section>
    <section class="card">
      <button class="btn btn-primary" disabled=${busy} onClick=${create}>Створити гру</button>
      <div class="divider"><span>або приєднатися</span></div>
      <form class="join-row" onSubmit=${join}>
        <input
          class="code-input"
          type="text"
          value=${code}
          maxlength="4"
          autocomplete="off"
          inputmode="numeric"
          pattern="[0-9]*"
          placeholder="КОД"
          aria-label="Код кімнати"
          onInput=${(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        <button class="btn btn-secondary" type="submit" disabled=${busy}>Приєднатися</button>
      </form>
      ${err && html`<p class="error" role="alert">${err}</p>`}
    </section>
  </main>`;
}

function Connecting({ s }) {
  return html`<main class="screen">
    <section class="card center">
      <p class="big-text">${s.conn === 'replaced' ? 'З’єднання закрито' : 'Підключення…'}</p>
      <button class="btn btn-ghost" onClick=${leaveRoom}>Скасувати</button>
    </section>
  </main>`;
}

// ---------- Lobby ----------

function Lobby({ g }) {
  const cfg = g.config;
  const players = g.players || [];
  const enough = players.length >= cfg.minPlayers;
  const copy = async () => {
    let link = '';
    try {
      link = location.origin + '/#' + g.code;
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(link);
      showToast('Посилання скопійовано');
    } catch (_) {
      showToast(link || g.code);
    }
  };
  return html`<main class="screen lobby">
    <section class="card center">
      <p class="muted">Код кімнати</p>
      <div class="room-code" aria-label="Код кімнати">${g.code}</div>
      <button class="btn btn-secondary" onClick=${copy}>Скопіювати посилання</button>
    </section>
    <section class="card">
      <h2>Гравці <span class="muted">${players.length}</span></h2>
      <ul class="players">
        ${players.map(
          (p) => html`<li key=${p.id} class="player-row">
            <${Avatar} name=${p.name} color=${p.color} />
            <span class="pname">${p.name}${p.id === g.you ? ' (ви)' : ''}</span>
            ${p.isHost && html`<span class="badge">Ведучий</span>`}
            <i class=${'conn-dot ' + (p.connected ? 'on' : 'off')} title=${p.connected ? 'на зв’язку' : 'немає зв’язку'}></i>
          </li>`
        )}
      </ul>
      <p class="muted small">Кожен гравець придумує ${cfg.cluesPerPlayer} підказки. Потім разом вгадуєте чужі.</p>
    </section>
    <section class="actions">
      ${isHost(g)
        ? html`<button class="btn btn-primary" disabled=${!enough} onClick=${startGame}>Почати гру</button>
            ${!enough && html`<p class="muted small center-text">Потрібно щонайменше ${cfg.minPlayers} гравці</p>`}`
        : html`<p class="muted center-text">Чекаємо, поки хост почне гру…</p>`}
      <${LeaveButton} />
    </section>
  </main>`;
}

// ---------- Writing ----------

function Writing({ g }) {
  const cfg = g.config;
  const tasks = g.myTasks || [];
  const me = player(g, g.you);
  const [clues, setClues] = useState(() => tasks.map((t) => t.clue || ''));
  const [sent, setSent] = useState(false);
  const [step, setStep] = useState(0);
  const init = useRef(tasks.length > 0);
  const latest = useRef(clues);
  const timer = useRef(null);
  const sentRef = useRef(false);

  useEffect(() => {
    if (!init.current && tasks.length) {
      init.current = true;
      const c = tasks.map((t) => t.clue || '');
      latest.current = c;
      setClues(c);
    }
  }, [tasks.length]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        if (!sentRef.current) saveDraft(latest.current);
      }
    },
    []
  );

  const locked = sent || !!(me && me.submitted);

  const onInput = (i, v) => {
    const next = tasks.map((_, k) => (k === i ? v : latest.current[k] || ''));
    latest.current = next;
    setClues(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!sentRef.current) saveDraft(latest.current);
    }, 700);
  };

  const filled = (i) => String(clues[i] || '').trim().length > 0;
  const allFilled = tasks.length > 0 && tasks.every((_, i) => filled(i));
  const i = Math.min(step, tasks.length - 1);
  const t = tasks[i];
  const last = i === tasks.length - 1;

  const submit = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const final = tasks.map((_, i) => String(clues[i] || '').trim());
    sentRef.current = true;
    if (submitClues(final)) setSent(true);
    else sentRef.current = false;
  };

  // Enter in the clue field advances to the next clue (or submits on the last).
  const enterProceeds = () => {
    if (locked) return;
    if (last) {
      if (allFilled) submit();
    } else if (filled(i)) {
      setStep(i + 1);
    }
  };

  return html`<main class="screen writing">
    <header class="topbar">
      <div>
        <h2>Придумайте підказки</h2>
        <span class="muted small">Готово підказок: ${g.readyClues ?? 0}/${g.totalClues ?? 0}</span>
      </div>
      <${Timer} deadline=${g.deadline} />
    </header>
    ${t &&
    html`<section class="card task" key=${t.id}>
      <h3>${i + 1}${tasks.length > 1 ? ' / ' + tasks.length : ''}</h3>
      ${!locked && html`<${Dial} zones=${cfg.zones} target=${t.target} label="Ціль на шкалі" />`}
      <${SpectrumLabels} left=${t.left} right=${t.right} />
      <input
        type="text"
        class="clue-input"
        value=${clues[i] || ''}
        maxlength=${cfg.maxClueLength}
        disabled=${locked}
        placeholder="Ваша підказка для цього місця"
        aria-label=${'Підказка ' + (i + 1)}
        onInput=${(e) => onInput(i, e.target.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter' && e.key !== 'NumpadEnter') return;
          e.preventDefault();
          enterProceeds();
        }}
      />
    </section>`}
    <section class="actions">
      ${locked
        ? html`<p class="waiting center-text">Підказки надіслано. Чекаємо на інших…</p>`
        : last
          ? html`<button class="btn btn-primary" disabled=${!allFilled} onClick=${submit}>Надіслати підказки</button>`
          : html`<button class="btn btn-primary" disabled=${!filled(i)} onClick=${() => setStep(i + 1)}>Далі</button>`}
      ${i > 0 && html`<button class="btn btn-ghost" onClick=${() => setStep(i - 1)}>Назад</button>`}
      <${LeaveButton} ask />
      <${ForceButton} g=${g} label="Продовжити, ігноруючи тих, хто ще не готовий" />
    </section>
  </main>`;
}

// ---------- Voting ----------

function Voting({ g }) {
  const cfg = g.config;
  const r = g.round;
  const task = r.task;
  const isAuthor = task.authorId === g.you;
  const myVote = (r.votes || []).find((v) => v.playerId === g.you);
  const [angle, setAngle] = useState(myVote ? myVote.angle : 90);
  const latest = useRef(angle);
  const lastSent = useRef(0);
  const timer = useRef(null);
  const locked = !!(myVote && myVote.locked);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const onChange = (a) => {
    setAngle(a);
    latest.current = a;
    const wait = 80 - (Date.now() - lastSent.current);
    if (wait <= 0) {
      lastSent.current = Date.now();
      sendVote(a);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        lastSent.current = Date.now();
        sendVote(latest.current);
      }, wait);
    }
  };

  const toggleLock = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    lockVote(!locked, latest.current);
  };

  const needles = (r.votes || [])
    .filter((v) => isAuthor || v.playerId !== g.you)
    .map((v) => needleFor(g, v.playerId, v.angle, v.locked, false));
  if (!isAuthor) needles.push(needleFor(g, g.you, angle, locked, true));
  const counted = (r.votes || []).filter((v) => v.playerId !== g.you).map((v) => v.angle);
  if (!isAuthor && (myVote || lastSent.current)) counted.push(angle);
  const teamAngle = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : null;

  const guessers = (g.players || []).filter((p) => p.id !== task.authorId && !p.left);
  const lockedCount = guessers.filter((p) => {
    if (p.id === g.you) return locked;
    const v = (r.votes || []).find((x) => x.playerId === p.id);
    return v && v.locked;
  }).length;

  return html`<main class="screen voting">
    <header class="topbar">
      <div>
        <h2>${r.index + 1} / ${r.total}</h2>
        <span class="muted small">Автор: ${nameOf(g, task.authorId)}</span>
      </div>
      <${Timer} deadline=${g.deadline} />
    </header>
    <section class="card">
      <p class="clue-text">${task.clue}</p>
      <${Dial}
        zones=${cfg.zones}
        target=${isAuthor ? task.target : null}
        needles=${needles}
        teamAngle=${teamAngle}
        interactive=${!isAuthor}
        angle=${angle}
        onChange=${onChange}
        disabled=${isAuthor || locked}
        label="Ваш варіант на шкалі"
      />
      <${SpectrumLabels} left=${task.left} right=${task.right} />
      ${isAuthor
        ? html``
        : html`<p class="muted small center-text">Тягніть стрілку</p>`}
      ${!isAuthor && html`<${Reactions} list=${r.reactions} />`}
    </section>
    <section class="actions">
      ${!isAuthor &&
      html`<button class=${'btn ' + (locked ? 'btn-secondary' : 'btn-primary')} onClick=${toggleLock}>${locked ? 'Змінити' : 'Готово'}</button>`}
      <p class="muted small center-text">Готово: ${lockedCount}/${guessers.length}</p>
      <${LeaveButton} ask />
      <${ForceButton} g=${g} label="Продовжити, ігноруючи тих, хто ще не готовий" />
    </section>
  </main>`;
}

// ---------- Reveal ----------

const Flames = () =>
  html`<div class="flames" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => html`<i style=${{ '--i': i }}></i>`)}</div>`;

function Reveal({ g }) {
  const cfg = g.config;
  const r = g.round;
  const task = r.task;
  const res = r.result || null;
  const entries = res ? Object.entries(res.votes || {}) : [];
  const needles = entries.map(([id, a]) => needleFor(g, id, a, false, id === g.you));
  const target = typeof task.target === 'number' ? task.target : null;
  const ready = r.ready || [];
  const connected = (g.players || []).filter((p) => p.connected);
  const readyCount = connected.filter((p) => ready.includes(p.id)).length;

  return html`<main class="screen reveal">
    <header class="topbar">
      <div>
        <h2>${r.index + 1} / ${r.total}</h2>
        <span class="muted small">Автор: ${nameOf(g, task.authorId)}</span>
      </div>
      <${Timer} deadline=${g.deadline} />
    </header>
    <section class="card">
      <p class="clue-text">${task.clue}</p>
      <${Dial}
        zones=${cfg.zones}
        target=${target}
        needles=${needles}
        teamAngle=${res ? res.teamAngle : null}
        label="Результат"
      />
      <${SpectrumLabels} left=${task.left} right=${task.right} />
      ${res && res.points === 4 && html`<${Flames} key=${task.id} />`}
      ${res &&
      html`<div class="result">
        <div class="points pop">+${res.points} <span>${pointsWord(res.points)}</span></div>
      </div>`}
      <${Reactions} list=${r.reactions} />
    </section>
    
    <section class="actions">
      ${ready.includes(g.you)
        ? html`<p class="waiting center-text">Чекаємо на інших…</p>`
        : html`<button class="btn btn-primary" onClick=${advance}>${'Далі'}</button>`}
      <p class="muted small center-text">Готові: ${readyCount}/${connected.length}</p>
      <${LeaveButton} ask />
      <${ForceButton} g=${g} label="Продовжити, ігноруючи тих, хто ще не готовий" />
    </section>
  </main>`;
}

// ---------- Summary ----------

const REPLAY_STEP_MS = 4000;
const REPLAY_FADE_MS = 450;
const VERDICT_MARKS = [25, 50, 70, 90];

function Reactions({ list }) {
  if (!list || !list.length) return null;
  return html`<div class="reactions" role="group" aria-label="Реакції">
    ${list.map((e) => html`<button key=${e} class="reaction" onClick=${() => react(e)}>${e}</button>`)}
  </div>`;
}

const CLUE_FLY_MAX = 20; // reactions replayed per clue during the summary replay
const CLUE_FLY_SPAN_MS = 1200; // first→last emoji start window inside the 4 s step
// Each clue replays the reactions that flew live on its reveal card: the
// emojis pop out across the card one after another, like they did live.
function ClueReactions({ events }) {
  const list = (events || []).slice(0, CLUE_FLY_MAX);
  if (!list.length) return null;
  const n = list.length;
  return html`<div class="clue-fly" aria-hidden="true">
    ${list.map((e, i) => html`<i
      key=${i}
      style=${{
        left: (8 + ((i * 41) % 84)) + '%',
        animationDelay: (n > 1 ? (i * CLUE_FLY_SPAN_MS) / (n - 1) : 0).toFixed(0) + 'ms',
      }}
    >${e.emoji}</i>`)}
  </div>`;
}

function Summary({ g }) {
  const cfg = g.config;
  const sm = g.summary || { score: 0, maxScore: 0, tasks: [] };
  const tasks = sm.tasks || [];
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const done = step >= tasks.length;
  const t = done ? null : tasks[step];

  useEffect(() => {
    if (done) return;
    setLeaving(false);
    const out = setTimeout(() => setLeaving(true), REPLAY_STEP_MS - REPLAY_FADE_MS);
    const next = setTimeout(() => setStep(step + 1), REPLAY_STEP_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(next);
    };
  }, [step]);

  const pointsOf = (x) => (x.result ? x.result.points : 0);
  const shown = tasks.slice(0, step + 1);
  const score = shown.reduce((s, x) => s + pointsOf(x), 0);
  const pct = sm.maxScore ? Math.round((sm.score / sm.maxScore) * 100) : 0;
  const res = t && t.result;

  return html`<main class="screen summary">
    <section class="card center">
      <p class="muted">${done ? 'Підсумок гри' : step + 1 + ' / ' + tasks.length}</p>
      <div class="score big">${score}<span class="of">/${sm.maxScore}</span></div>
    </section>
    <div class="replay">
      <div class="vgauge" role="progressbar" aria-valuemin="0" aria-valuemax=${sm.maxScore} aria-valuenow=${score}>
        <i class="vgauge-bands dim"></i>
        <i class="vgauge-bands" style=${{ '--fill': (sm.maxScore ? (score / sm.maxScore) * 100 : 0) + '%' }}></i>
        ${sm.maxScore > 0 &&
        shown.map((x) => html`<i key=${x.id} class="vgauge-seg" style=${{ height: (pointsOf(x) / sm.maxScore) * 100 + '%' }}></i>`)}
        ${VERDICT_MARKS.map((m) => html`<span key=${m} class="vgauge-mark" style=${{ bottom: m + '%' }}>${verdictFor(m)}</span>`)}
      </div>
      ${t &&
      html`<section class=${'card task-sum fade-in' + (leaving ? ' fade-away' : '')} key=${t.id}>
        <${ClueReactions} events=${t.events} />
        <${Dial}
          zones=${cfg.zones}
          target=${typeof t.target === 'number' ? t.target : null}
          needles=${res ? Object.entries(res.votes || {}).map(([id, a]) => needleFor(g, id, a, false, false)) : []}
          teamAngle=${res ? res.teamAngle : null}
          label=${'Підказка ' + (step + 1)}
        />
        <${SpectrumLabels} left=${t.left} right=${t.right} />
        <p class="clue-text small-clue">${t.clue}</p>
        <p class="muted small center-text">${nameOf(g, t.authorId)} · <b class="pop step-points">+${pointsOf(t)}</b> ${pointsWord(pointsOf(t))}</p>
      </section>`}
      ${done &&
      html`<section class="card center final fade-in">
        <p class="verdict big-verdict pop">${verdictFor(pct)}</p>
        <p class="muted small">${pct}% від максимуму</p>
      </section>`}
    </div>
    <${Reactions} list=${sm.reactions} />
    <section class="actions">
      ${isHost(g) && html`<button class="btn btn-primary" onClick=${newGame}>Нова гра</button>`}
      <${LeaveButton} />
    </section>
  </main>`;
}

export const views = {
  Home,
  Connecting,
  lobby: Lobby,
  writing: Writing,
  voting: Voting,
  reveal: Reveal,
  summary: Summary,
};
