import { html, render } from './vendor/preact-htm.js';
import { useStore, reconnectNow, clearNotice } from './net.js';
import { views } from './views.js';

function pickView(g) {
  const V = views[g.phase];
  if (!V) return null;
  if ((g.phase === 'voting' || g.phase === 'reveal') && !(g.round && g.round.task)) return null;
  if (g.phase === 'summary' && !g.summary) return null;
  if (g.phase === 'writing' && !g.config) return null;
  return V;
}

export function App() {
  const s = useStore();
  const g = s.game;
  let body;
  if (!s.session) {
    body = html`<${views.Home} s=${s} />`;
  } else if (!g) {
    body = html`<${views.Connecting} s=${s} />`;
  } else {
    const V = pickView(g);
    const key = g.phase + ':' + (g.round ? g.round.index : '');
    body = V ? html`<${V} key=${key} g=${g} s=${s} />` : html`<${views.Connecting} s=${s} />`;
  }
  const showBanner = s.session && g && s.conn !== 'open' && s.conn !== 'replaced';
  return html`<div class="app">
    ${showBanner && html`<div class="banner" role="status">Відновлюємо з’єднання…</div>`}
    ${s.notice &&
    html`<div class="notice" role="alert">
      <span>${s.notice.text}</span>
      ${s.notice.reconnect
        ? html`<button class="btn btn-small" onClick=${reconnectNow}>Підключитися знову</button>`
        : html`<button class="btn btn-small btn-ghost" onClick=${clearNotice} aria-label="Закрити">OK</button>`}
    </div>`}
    ${body}
    <div class="fly-layer" aria-hidden="true">
      ${s.flying.map((f) => html`<span key=${f.id} class="fly" style=${{ left: f.left + '%' }}>${f.emoji}</span>`)}
    </div>
    <div class="toast-area" aria-live="polite">
      ${s.toast && html`<div class="toast" key=${s.toast.id}>${s.toast.text}</div>`}
    </div>
  </div>`;
}

if (typeof document !== 'undefined') {
  const el = document.getElementById('app');
  if (el) render(html`<${App} />`, el);
}
