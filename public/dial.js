// Dial: SVG semicircle with zones, needles and helpers.
import { html, useRef } from './vendor/preact-htm.js';

export const CX = 200;
export const CY = 200;
export const R = 170;
export const FACE_R = 156;
export const VB_W = 400;
export const VB_H = 215;

export const PALETTE = [
  '#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b',
  '#20c997', '#f783ac', '#74c0fc', '#a9e34b', '#9775fa', '#e8590c',
];

export function colorOf(i) {
  const n = Number.isFinite(i) ? Math.trunc(i) : 0;
  return PALETTE[((n % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function pointsWord(n) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return 'бал';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'бали';
  return 'балів';
}

export function clampAngle(a) {
  const n = Math.round(Number(a));
  if (!Number.isFinite(n)) return 90;
  return Math.max(0, Math.min(180, n));
}

// angle -> point (0 = far left, 180 = far right)
export function pointAt(angle, r) {
  const a = (angle * Math.PI) / 180;
  return [CX - r * Math.cos(a), CY - r * Math.sin(a)];
}

// viewBox point -> integer angle, clamped below the horizon
export function angleFromPoint(x, y) {
  const dy = CY - y;
  const dx = x - CX;
  if (dy < 0) return dx < 0 ? 0 : 180;
  const deg = 180 - (Math.atan2(dy, dx) * 180) / Math.PI;
  return clampAngle(deg);
}

export function wedgePath(lo, hi, r) {
  const [x1, y1] = pointAt(lo, r);
  const [x2, y2] = pointAt(hi, r);
  const large = hi - lo > 180 ? 1 : 0;
  return `M ${CX} ${CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

export function zoneColor(points) {
  if (points >= 4) return '#d62839';
  if (points === 3) return '#f77f00';
  if (points === 2) return '#fcbf49';
  return '#fde8a8';
}

const RING_PATH = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY} L ${CX + FACE_R} ${CY} A ${FACE_R} ${FACE_R} 0 0 0 ${CX - FACE_R} ${CY} Z`;
const FACE_PATH = `M ${CX - FACE_R} ${CY} A ${FACE_R} ${FACE_R} 0 0 1 ${CX + FACE_R} ${CY} Z`;

const TICKS = [];
for (let a = 0; a <= 180; a += 10) {
  const major = a % 90 === 0;
  const [x1, y1] = pointAt(a, major ? 136 : 143);
  const [x2, y2] = pointAt(a, 152);
  TICKS.push({ a, major, x1, y1, x2, y2 });
}

let uid = 0;

function renderNeedle(n) {
  const [tx, ty] = pointAt(n.angle, 146);
  const color = n.color || '#ffffff';
  return html`<g key=${'n' + n.id} class=${'needle' + (n.mine ? ' mine' : '') + (n.locked ? ' locked' : '')} opacity=${n.mine ? 1 : 0.5}>
    <line x1=${CX} y1=${CY} x2=${tx} y2=${ty} stroke=${color} stroke-width=${n.mine ? 4 : 3} stroke-linecap="round" />
    <circle cx=${tx} cy=${ty} r="10" fill=${color} stroke=${n.locked ? '#ffffff' : 'rgba(0,0,0,0.35)'} stroke-width=${n.locked ? 3 : 1} />
    <text x=${tx} y=${ty} text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="#15132b">${n.initial || ''}</text>
  </g>`;
}

export function Dial(props) {
  const {
    zones = [],
    target = null,
    needles = [],
    teamAngle = null,
    interactive = false,
    angle = 90,
    onChange,
    disabled = false,
    label = 'Шкала',
  } = props;
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = 'dg' + ++uid;
  const gid = idRef.current;
  const svgRef = useRef(null);
  const drag = useRef(false);
  const active = interactive && !disabled;

  const update = (e) => {
    const svg = svgRef.current;
    if (!svg || !onChange) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((e.clientX - rect.left) * VB_W) / rect.width;
    const y = ((e.clientY - rect.top) * VB_H) / rect.height;
    onChange(angleFromPoint(x, y));
  };

  const onDown = (e) => {
    if (!active) return;
    drag.current = true;
    try {
      svgRef.current.setPointerCapture(e.pointerId);
    } catch (_) {}
    if (e.preventDefault) e.preventDefault();
    update(e);
  };
  const onMove = (e) => {
    if (active && drag.current) update(e);
  };
  const onUp = (e) => {
    if (!drag.current) return;
    drag.current = false;
    try {
      svgRef.current.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };
  const onKey = (e) => {
    if (!active || !onChange) return;
    const step = e.shiftKey ? 5 : 1;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = angle - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = angle + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 180;
    if (next === null) return;
    e.preventDefault();
    onChange(clampAngle(next));
  };

  const zs = [...zones].sort((a, b) => b.halfWidth - a.halfWidth);
  const sorted = [...needles].sort((a, b) => (a.mine ? 1 : 0) - (b.mine ? 1 : 0));
  const showTarget = typeof target === 'number';
  const showTeam = typeof teamAngle === 'number';
  const sliderProps = interactive
    ? {
        role: 'slider',
        tabindex: 0,
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 180,
        'aria-valuenow': angle,
        'aria-disabled': disabled ? 'true' : 'false',
      }
    : { role: 'img', 'aria-label': label };

  return html`<svg
    ref=${svgRef}
    class=${'dial' + (interactive ? ' interactive' : '') + (active ? ' active' : '')}
    viewBox="0 0 400 215"
    onpointerdown=${active ? onDown : undefined}
    onpointermove=${active ? onMove : undefined}
    onpointerup=${active ? onUp : undefined}
    onpointercancel=${active ? onUp : undefined}
    onkeydown=${active ? onKey : undefined}
    ...${sliderProps}
  >
    <defs>
      <linearGradient id=${gid} gradientUnits="userSpaceOnUse" x1=${CX - R} y1="0" x2=${CX + R} y2="0">
        <stop offset="0" stop-color="#8e6bff" />
        <stop offset="1" stop-color="#2ec4b6" />
      </linearGradient>
    </defs>
    <path d=${FACE_PATH} fill="#f3ead7" />
    ${showTarget &&
    zs.map((z) => {
      const lo = Math.max(0, target - z.halfWidth);
      const hi = Math.min(180, target + z.halfWidth);
      return html`<path key=${'z' + z.points + '-' + z.halfWidth} class="zone-wedge" d=${wedgePath(lo, hi, FACE_R)} fill=${zoneColor(z.points)} />`;
    })}
    ${TICKS.map(
      (t) => html`<line key=${'t' + t.a} x1=${t.x1} y1=${t.y1} x2=${t.x2} y2=${t.y2} stroke="#15132b" stroke-opacity=${t.major ? 0.55 : 0.3} stroke-width=${t.major ? 2 : 1.2} />`
    )}
    <path d=${RING_PATH} fill=${'url(#' + gid + ')'} />
    ${showTeam &&
    html`<g class="team-needle" style=${{ transform: `rotate(${teamAngle - 90}deg)` }}>
      <line x1=${CX} y1=${CY} x2=${CX} y2=${CY - 138} stroke="#6b6590" stroke-opacity="0.45" stroke-width="9" stroke-linecap="round" />
      <circle cx=${CX} cy=${CY - 138} r="7" fill="#f3ead7" stroke="#6b6590" stroke-opacity="0.7" stroke-width="3" />
    </g>`}
    ${sorted.map(renderNeedle)}
    <circle cx=${CX} cy=${CY} r="11" fill="#2b2850" stroke="#f3ead7" stroke-width="3" />
  </svg>`;
}

export function SpectrumLabels({ left, right }) {
  return html`<div class="spectrum">
    <span class="spectrum-end"><i class="dot dot-left"></i><span>${left}</span></span>
    <span class="spectrum-end spectrum-right"><span>${right}</span><i class="dot dot-right"></i></span>
  </div>`;
}

export function ZoneLegend({ zones = [] }) {
  const zs = [...zones].sort((a, b) => b.points - a.points);
  return html`<ul class="zone-legend">
    ${zs.map(
      (z) => html`<li key=${z.points + '-' + z.halfWidth}>
        <i class=${'swatch zone-p' + z.points}></i>
        <span>${z.points} ${pointsWord(z.points)}</span>
      </li>`
    )}
  </ul>`;
}
