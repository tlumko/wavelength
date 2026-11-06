// Network layer + tiny store.
import { useState, useEffect } from './vendor/preact-htm.js';

const SESSION_KEY = 'wl-session';
const NAME_KEY = 'wl-name';

function store_() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_) {
    return null;
  }
}
function lsGet(k) {
  try {
    const l = store_();
    return l ? l.getItem(k) : null;
  } catch (_) {
    return null;
  }
}
function lsSet(k, v) {
  try {
    const l = store_();
    if (l) l.setItem(k, v);
  } catch (_) {}
}
function lsDel(k) {
  try {
    const l = store_();
    if (l) l.removeItem(k);
  } catch (_) {}
}

function loadSession() {
  try {
    const raw = lsGet(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && typeof s.code === 'string' && typeof s.token === 'string' && typeof s.playerId === 'string') return s;
  } catch (_) {}
  return null;
}

export function readHashCode() {
  try {
    if (typeof location === 'undefined') return '';
    const m = /^#([A-Za-z0-9]{3,8})$/.exec(location.hash || '');
    return m ? m[1].toUpperCase() : '';
  } catch (_) {
    return '';
  }
}

export const ERROR_TEXT = {
  bad_name: 'Некоректне ім’я. Спробуйте інше.',
  name_taken: 'Таке ім’я вже є в кімнаті.',
  room_not_found: 'Кімнату не знайдено.',
  game_started: 'Гра вже почалася.',
  room_full: 'Кімната заповнена.',
  too_many_rooms: 'Зараз забагато активних кімнат. Спробуйте пізніше.',
  rate_limited: 'Забагато спроб. Зачекайте трохи.',
  network: 'Немає зв’язку із сервером.',
  not_host: 'Це може зробити лише ведучий.',
  bad_phase: 'Зараз це неможливо.',
  not_enough_players: 'Замало гравців для старту.',
  already_submitted: 'Підказки вже надіслано.',
  author_cannot_vote: 'Автор не може голосувати за свою підказку.',
  author_cannot_react: 'Автор не може надсилати реакції до розкриття підказки.',
  bad_message: 'Помилка повідомлення.',
  bad_angle: 'Некоректне положення стрілки.',
  no_vote: 'Спочатку виберіть положення стрілки.',
};

export function errorText(code) {
  return ERROR_TEXT[code] || 'Щось пішло не так. Спробуйте ще раз.';
}

let state = {
  conn: 'idle', // idle | connecting | open | reconnecting | replaced
  session: loadSession(),
  game: null,
  offset: 0,
  toast: null,
  notice: null,
  flying: [], // reaction emojis currently floating up
  name: lsGet(NAME_KEY) || '',
  prefill: readHashCode(),
};
const listeners = new Set();

export function getState() {
  return state;
}
function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((f) => {
    try {
      f(state);
    } catch (_) {}
  });
}
export function subscribe(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function useStore() {
  const [s, set] = useState(state);
  useEffect(() => {
    const f = (n) => set(n);
    listeners.add(f);
    set(state);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return s;
}

export function serverNow() {
  return Date.now() + state.offset;
}

// ---- toast / notice ----
let toastTimer = null;
let toastId = 0;
export function showToast(text) {
  if (toastTimer) clearTimeout(toastTimer);
  setState({ toast: { id: ++toastId, text } });
  toastTimer = setTimeout(() => {
    toastTimer = null;
    setState({ toast: null });
  }, 3500);
}
export function clearNotice() {
  setState({ notice: null });
}

// ---- socket ----
let ws = null;
let attempt = 0;
let retryTimer = null;
let hbTimer = null;
let lastMsg = 0;
let lastPing = 0;

function rawSend(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {}
  }
  return false;
}

function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
}

function detach() {
  stopHeartbeat();
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close();
    } catch (_) {}
  }
}

function startHeartbeat() {
  stopHeartbeat();
  lastPing = Date.now();
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (now - lastMsg > 40000) {
      detach();
      scheduleReconnect();
      return;
    }
    if (now - lastPing >= 15000) {
      lastPing = now;
      rawSend({ t: 'ping' });
    }
  }, 5000);
}

function scheduleReconnect() {
  if (!state.session) return;
  if (retryTimer) clearTimeout(retryTimer);
  const delay = Math.min(8000, 1000 * Math.pow(2, attempt));
  attempt += 1;
  setState({ conn: 'reconnecting' });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function clearSession(noticeText) {
  detach();
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  attempt = 0;
  lsDel(SESSION_KEY);
  setState({ session: null, game: null, conn: 'idle', offset: 0, notice: noticeText ? { text: noticeText } : null });
}

function handleClose(code) {
  if (code === 4000) return clearSession('Кімнату закрито: гру завершено через неактивність.');
  if (code === 4003) return clearSession('Кімнату не знайдено або гру завершено.');
  if (code === 4001) {
    setState({
      conn: 'replaced',
      notice: { text: 'Гру відкрито в іншій вкладці. Тут з’єднання закрито.', reconnect: true },
    });
    return;
  }
  scheduleReconnect();
}

let flyId = 0;
export function flyEmoji(emoji) {
  const f = { id: ++flyId, emoji, left: 10 + Math.random() * 80 };
  setState({ flying: [...state.flying.slice(-30), f] });
  setTimeout(() => setState({ flying: state.flying.filter((x) => x !== f) }), 2000);
}

function handleMessage(m) {
  if (!m || typeof m.t !== 'string') return;
  switch (m.t) {
    case 'state': {
      attempt = 0;
      const offset = typeof m.now === 'number' ? m.now - Date.now() : state.offset;
      setState({ game: m, offset, conn: 'open' });
      break;
    }
    case 'vote': {
      const g = state.game;
      if (!g || !g.round) return;
      const entry = { playerId: m.playerId, angle: m.angle, locked: !!m.locked };
      const votes = (g.round.votes || []).slice();
      const i = votes.findIndex((v) => v.playerId === m.playerId);
      if (i >= 0) votes[i] = entry;
      else votes.push(entry);
      setState({ game: { ...g, round: { ...g.round, votes } } });
      break;
    }
    case 'react':
      flyEmoji(m.emoji);
      break;
    case 'error':
      showToast(errorText(m.code));
      break;
    default:
      break; // pong etc.
  }
}

export function connect() {
  if (!state.session || typeof WebSocket === 'undefined' || typeof location === 'undefined') return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  detach();
  setState({ conn: attempt > 0 ? 'reconnecting' : 'connecting' });
  const { code, token } = state.session;
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (_) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  lastMsg = Date.now();
  sock.onopen = () => {
    if (ws !== sock) return;
    lastMsg = Date.now();
    rawSend({ t: 'hello', code, token });
    startHeartbeat();
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastMsg = Date.now();
    let m = null;
    try {
      m = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    handleMessage(m);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    stopHeartbeat();
    handleClose(ev && ev.code);
  };
  sock.onerror = () => {};
}

// user pressed "reconnect" after being replaced
export function reconnectNow() {
  attempt = 0;
  setState({ notice: null });
  connect();
}

// ---- HTTP ----
async function post(path, body) {
  if (typeof fetch === 'undefined') return { error: 'network' };
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return { error: 'network' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data || data.error) return { error: (data && data.error) || 'network' };
  return { data };
}

function startSession(data, name) {
  const session = { code: data.code, token: data.token, playerId: data.playerId };
  lsSet(SESSION_KEY, JSON.stringify(session));
  lsSet(NAME_KEY, name);
  attempt = 0;
  setState({ session, game: null, offset: 0, notice: null, name });
  connect();
}

export async function createRoom(name) {
  const n = String(name || '').trim();
  const r = await post('/api/rooms', { name: n });
  if (r.error) return { error: r.error, message: errorText(r.error) };
  startSession(r.data, n);
  return { ok: true };
}

export async function joinRoom(code, name) {
  const n = String(name || '').trim();
  const c = String(code || '').trim().toUpperCase();
  const r = await post('/api/rooms/' + encodeURIComponent(c) + '/join', { name: n });
  if (r.error) return { error: r.error, message: errorText(r.error) };
  startSession(r.data, n);
  return { ok: true };
}

export function rememberName(name) {
  lsSet(NAME_KEY, name);
  setState({ name });
}

// ---- actions ----
function act(obj) {
  const ok = rawSend(obj);
  if (!ok) showToast('Немає з’єднання. Спробуйте за мить.');
  return ok;
}
export const startGame = () => act({ t: 'start' });
export const saveDraft = (clues) => rawSend({ t: 'draft', clues });
export const submitClues = (clues) => act({ t: 'submit', clues });
export const sendVote = (angle) => rawSend({ t: 'vote', angle });
export const lockVote = (locked, angle) => act({ t: 'lock', locked: !!locked, angle });
export const advance = () => act({ t: 'advance' });
export const forceAdvance = () => act({ t: 'advance', force: true });
export const react = (emoji) => rawSend({ t: 'react', emoji });
export const newGame = () => act({ t: 'new_game' });
export function leaveRoom() {
  rawSend({ t: 'leave' });
  clearSession(null);
}

// ---- lifecycle (guarded) ----
try {
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!state.session || state.conn === 'replaced') return;
      if (Date.now() - lastMsg > 20000) {
        attempt = 0;
        connect();
      }
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', () => setState({ prefill: readHashCode() }));
  }
  if (state.session) connect();
} catch (_) {}
