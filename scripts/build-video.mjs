// Builds the frames for the loan demo video. Every number rendered comes out of
// the library at build time; nothing is typed by hand into a template.
//
// Output is a sequence of PNGs at 1280x720, 30 fps, which ffmpeg then muxes.
// The video has no audio, because it plays muted in a timeline anyway.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { amortisationSchedule, payoffWithExtra, levelPayment } from '../src/index.mjs';

const W = 1280;
const H = 720;
const FPS = 30;
const OUT = '/tmp/loanvid';

const C = {
  bg: '#0B0F0E',
  panel: '#111716',
  line: '#1E2826',
  ink: '#D8E0DD',
  dim: '#7B8B87',
  acid: '#B8FF3C',
  amber: '#FFB238',
};

// ---- the figures, all read from the library -------------------------------

const P = 200000;
const R = 0.06;
const Y = 30;
const X = 200;

const base = amortisationSchedule({ principal: P, rate: R, years: Y });
const fast = amortisationSchedule({ principal: P, rate: R, years: Y, extraPayment: X });
const payoff = payoffWithExtra({ principal: P, rate: R, years: Y, extraPayment: X });

const F = {
  payment: base.payment,
  periods: base.periods,
  totalInterest: base.totalInterest,
  totalPaid: base.totalPaid,
  sharePct: (base.totalInterest / P) * 100,
  firstInterest: base.rows[0].interest,
  firstPrincipal: base.rows[0].principal,
  firstInterestPct: (base.rows[0].interest / base.payment) * 100,
  newPayment: payoff.newPayment,
  newPeriods: payoff.newPeriods,
  newInterest: payoff.newInterest,
  newTotalPaid: P + payoff.newInterest,
  saved: payoff.interestSaved,
  savedPct: (payoff.interestSaved / base.totalInterest) * 100,
  yearsSaved: payoff.yearsSaved,
  periodsSaved: payoff.periodsSaved,
  extraTotal: X * payoff.newPeriods,
};

// Sanity: the story the video tells must actually be true.
const assert = (cond, msg) => {
  if (!cond) throw new Error('figure check failed: ' + msg);
};
assert(Math.abs(base.totalInterest - payoff.newInterest - F.saved) < 1e-6, 'saving must equal interest difference');
assert(Math.abs(F.totalPaid - (P + F.totalInterest)) < 1e-6, 'total paid must be principal plus interest');
assert(F.newPeriods < F.periods, 'overpaying must shorten the term');
assert(F.saved > F.extraTotal, 'the saving must exceed the extra paid, or the pitch is a lie');
assert(Math.abs(levelPayment({ principal: P, rate: R, years: Y }).payment - F.payment) < 1e-9, 'payment must agree');

// ---- helpers --------------------------------------------------------------

const money = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => Math.round(n).toLocaleString('en-US');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ease in and out, so nothing snaps
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

/** Progress of a segment within the whole timeline, eased. */
const seg = (frame, start, dur) => ease(clamp01((frame - start) / dur));

const txt = (x, y, s, { size = 24, fill = C.dim, anchor = 'start', weight = 'normal', op = 1 } = {}) =>
  op <= 0.001
    ? ''
    : `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" opacity="${op.toFixed(3)}">${esc(s)}</text>`;

// ---- the balance curve ----------------------------------------------------

const PLOT = { x: 90, y: 250, w: 820, h: 330 };

const curvePath = (rows, reveal) => {
  const n = Math.max(2, Math.floor(rows.length * reveal));
  const pts = [];
  // sample at most ~420 points; the eye cannot see more and the SVG stays small
  const stride = Math.max(1, Math.floor(rows.length / 420));
  for (let i = 0; i < n; i += stride) {
    const r = rows[i];
    // x is scaled to the BASE term so the shorter curve visibly stops early
    const px = PLOT.x + (r.period / base.periods) * PLOT.w;
    const py = PLOT.y + PLOT.h - (r.balance / P) * PLOT.h;
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return pts.length < 2 ? '' : 'M ' + pts.join(' L ');
};

const axes = () => `
  <line x1="${PLOT.x}" y1="${PLOT.y + PLOT.h}" x2="${PLOT.x + PLOT.w}" y2="${PLOT.y + PLOT.h}" stroke="${C.line}" stroke-width="2"/>
  <line x1="${PLOT.x}" y1="${PLOT.y}" x2="${PLOT.x}" y2="${PLOT.y + PLOT.h}" stroke="${C.line}" stroke-width="2"/>
  ${txt(PLOT.x - 12, PLOT.y + 8, money0(P), { size: 18, anchor: 'end' })}
  ${txt(PLOT.x - 12, PLOT.y + PLOT.h + 6, '0', { size: 18, anchor: 'end' })}
  ${txt(PLOT.x, PLOT.y + PLOT.h + 34, 'year 0', { size: 18 })}
  ${txt(PLOT.x + PLOT.w, PLOT.y + PLOT.h + 34, 'year 30', { size: 18, anchor: 'end' })}
  ${txt(PLOT.x - 58, PLOT.y + PLOT.h / 2, 'balance', { size: 18 })}
`;

// ---- scenes ---------------------------------------------------------------
// Timeline in frames at 30 fps. Total is SCENES-driven so it cannot drift.

const S = [];
let cursor = 0;
const scene = (dur, draw) => { S.push({ start: cursor, dur, draw }); cursor += dur; };

// 1. title
scene(72, (f) => {
  const a = seg(f, 0, 30);
  const b = seg(f, 22, 34);
  return `
    ${txt(90, 300, 'a 200,000 loan', { size: 76, fill: C.ink, weight: 'bold', op: a })}
    ${txt(90, 380, 'at 6% over 30 years', { size: 76, fill: C.ink, weight: 'bold', op: b })}
    ${txt(90, 452, 'what does it actually cost', { size: 30, op: seg(f, 46, 26) })}
  `;
});

// 2. the payment appears
scene(78, (f) => {
  const a = seg(f, 0, 26);
  const v = F.payment * seg(f, 8, 34); // count up
  return `
    ${txt(90, 170, 'the monthly payment', { size: 30, op: a })}
    ${txt(90, 300, money(v), { size: 96, fill: C.acid, weight: 'bold', op: a })}
    ${txt(90, 372, `${F.periods} payments`, { size: 30, op: seg(f, 34, 24) })}
    ${txt(90, 460, 'every bank calculator stops here', { size: 28, fill: C.dim, op: seg(f, 48, 26) })}
  `;
});

// 3. the first payment is mostly interest
scene(96, (f) => {
  const a = seg(f, 0, 24);
  const bar = seg(f, 18, 40);
  const iw = (F.firstInterest / F.payment) * 700 * bar;
  const pw = (F.firstPrincipal / F.payment) * 700 * bar;
  return `
    ${txt(90, 150, 'your first payment, split', { size: 34, fill: C.ink, op: a })}
    <rect x="90" y="220" width="${iw.toFixed(1)}" height="64" fill="${C.amber}" opacity="${a.toFixed(3)}"/>
    <rect x="${(90 + iw).toFixed(1)}" y="220" width="${pw.toFixed(1)}" height="64" fill="${C.acid}" opacity="${a.toFixed(3)}"/>
    ${txt(90, 330, `interest  ${money(F.firstInterest)}`, { size: 28, fill: C.amber, op: seg(f, 34, 24) })}
    ${txt(90, 372, `principal  ${money(F.firstPrincipal)}`, { size: 28, fill: C.acid, op: seg(f, 42, 24) })}
    ${txt(90, 470, `${F.firstInterestPct.toFixed(1)}% of it is interest`, { size: 44, fill: C.amber, weight: 'bold', op: seg(f, 56, 28) })}
    ${txt(90, 520, 'you barely touch what you borrowed', { size: 26, op: seg(f, 64, 26) })}
  `;
});

// 4. the balance curve draws, slowly at first
scene(132, (f) => {
  const a = seg(f, 0, 20);
  const reveal = seg(f, 10, 104);
  const d = curvePath(base.rows, reveal);
  const idx = Math.min(base.rows.length - 1, Math.floor(base.rows.length * reveal));
  const r = base.rows[idx];
  const hx = PLOT.x + (r.period / base.periods) * PLOT.w;
  const hy = PLOT.y + PLOT.h - (r.balance / P) * PLOT.h;
  return `
    ${txt(90, 150, 'the balance over 30 years', { size: 34, fill: C.ink, op: a })}
    ${txt(90, 196, 'it hardly moves for years, then falls off a cliff', { size: 24, op: seg(f, 26, 26) })}
    <g opacity="${a.toFixed(3)}">${axes()}</g>
    <path d="${d}" fill="none" stroke="${C.amber}" stroke-width="4" opacity="${a.toFixed(3)}"/>
    <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="7" fill="${C.amber}" opacity="${a.toFixed(3)}"/>
    ${txt(960, 300, `year ${(r.period / 12).toFixed(1)}`, { size: 26, fill: C.dim, op: a })}
    ${txt(960, 348, money0(r.balance), { size: 40, fill: C.amber, weight: 'bold', op: a })}
    ${txt(960, 386, 'still owed', { size: 22, op: a })}
  `;
});

// 5. the total cost lands
scene(108, (f) => {
  const a = seg(f, 0, 24);
  const v = F.totalInterest * seg(f, 10, 44);
  return `
    ${txt(90, 160, 'total interest over the full term', { size: 32, op: a })}
    ${txt(90, 300, money(v), { size: 104, fill: C.amber, weight: 'bold', op: a })}
    ${txt(90, 396, `${F.sharePct.toFixed(1)}% of what you borrowed`, { size: 44, fill: C.amber, op: seg(f, 46, 28) })}
    ${txt(90, 470, `you repay ${money0(F.totalPaid)} in total`, { size: 30, fill: C.ink, op: seg(f, 60, 26) })}
    ${txt(90, 540, 'so what changes it', { size: 30, fill: C.dim, op: seg(f, 78, 24) })}
  `;
});

// 6. add 200 a month, both curves, side by side
scene(150, (f) => {
  const a = seg(f, 0, 20);
  const reveal = seg(f, 12, 92);
  const dBase = curvePath(base.rows, 1);
  const dFast = curvePath(fast.rows, reveal);
  const endX = PLOT.x + (fast.periods / base.periods) * PLOT.w;
  const gap = seg(f, 100, 34);
  return `
    ${txt(90, 150, 'now pay 200 more each month', { size: 34, fill: C.acid, op: a })}
    ${txt(90, 196, 'same loan, same rate, one extra line on the transfer', { size: 24, op: seg(f, 20, 24) })}
    <g opacity="${a.toFixed(3)}">${axes()}</g>
    <path d="${dBase}" fill="none" stroke="${C.amber}" stroke-width="4" opacity="${(a * 0.45).toFixed(3)}"/>
    <path d="${dFast}" fill="none" stroke="${C.acid}" stroke-width="4" opacity="${a.toFixed(3)}"/>
    <line x1="${endX.toFixed(1)}" y1="${PLOT.y}" x2="${endX.toFixed(1)}" y2="${PLOT.y + PLOT.h}" stroke="${C.acid}" stroke-width="2" stroke-dasharray="6 6" opacity="${gap.toFixed(3)}"/>
    ${txt(endX + 14, PLOT.y + 30, 'clear here', { size: 22, fill: C.acid, op: gap })}
    ${txt(endX + 14, PLOT.y + 60, `year ${(fast.periods / 12).toFixed(1)}`, { size: 22, fill: C.acid, op: gap })}
    ${txt(960, 470, `${F.yearsSaved.toFixed(0)} years earlier`, { size: 34, fill: C.acid, weight: 'bold', op: gap })}
  `;
});

// 7. the trade, stated plainly
scene(126, (f) => {
  const a = seg(f, 0, 22);
  const b = seg(f, 26, 26);
  const c = seg(f, 58, 30);
  return `
    ${txt(90, 150, 'the trade', { size: 34, fill: C.ink, op: a })}
    <rect x="90" y="210" width="520" height="150" rx="12" fill="${C.panel}" stroke="${C.line}" stroke-width="2" opacity="${a.toFixed(3)}"/>
    ${txt(120, 262, 'you hand over', { size: 24, op: a })}
    ${txt(120, 322, money(F.extraTotal), { size: 52, fill: C.ink, weight: 'bold', op: a })}
    <rect x="660" y="210" width="530" height="150" rx="12" fill="${C.panel}" stroke="${C.line}" stroke-width="2" opacity="${b.toFixed(3)}"/>
    ${txt(690, 262, 'you save', { size: 24, op: b })}
    ${txt(690, 322, money(F.saved), { size: 52, fill: C.acid, weight: 'bold', op: b })}
    ${txt(90, 452, `${F.savedPct.toFixed(1)}% of the interest, gone`, { size: 46, fill: C.acid, weight: 'bold', op: c })}
    ${txt(90, 516, 'every extra unit is principal, so it kills all the interest that principal carried', { size: 25, op: seg(f, 76, 28) })}
    ${txt(90, 560, `${F.periodsSaved} payments removed from the end of the loan`, { size: 25, op: seg(f, 88, 26) })}
  `;
});

// 8. it is one command
scene(114, (f) => {
  const a = seg(f, 0, 22);
  const lines = [
    ['loan  200,000.00 at 6.0000%, 30y, 12x / year', C.dim, 22],
    [`  payment               ${money(F.payment)} per period`, C.ink, 22],
    [`  periods               ${F.periods}`, C.ink, 22],
    [`  total paid            ${money(F.totalPaid)}`, C.ink, 22],
    [`  total interest        ${money(F.totalInterest)} ${F.sharePct.toFixed(1)}% of what you borrowed`, C.amber, 22],
  ];
  const rows = lines
    .map((l, i) => txt(120, 300 + i * 40, l[0], { size: l[2], fill: l[1], op: seg(f, 24 + i * 9, 20) }))
    .join('');
  return `
    ${txt(90, 150, 'one command', { size: 34, fill: C.ink, op: a })}
    <rect x="90" y="200" width="1100" height="300" rx="12" fill="${C.panel}" stroke="${C.line}" stroke-width="2" opacity="${a.toFixed(3)}"/>
    ${txt(120, 250, '$ accrual loan --principal 200000 --rate 6 --years 30', { size: 24, fill: C.acid, op: a })}
    ${rows}
  `;
});

// 9. close
scene(96, (f) => {
  const a = seg(f, 0, 24);
  return `
    ${txt(90, 250, 'accrual', { size: 86, fill: C.ink, weight: 'bold', op: a })}
    ${txt(90, 312, 'day counts, bills, bonds, loans', { size: 30, op: seg(f, 16, 24) })}
    ${txt(90, 356, 'library, CLI, 13-tool MCP server, zero dependencies', { size: 30, op: seg(f, 28, 24) })}
    ${txt(90, 452, 'accrual.tools', { size: 44, fill: C.acid, weight: 'bold', op: seg(f, 44, 26) })}
    ${txt(90, 520, '$ACCR', { size: 28, fill: C.acid, op: seg(f, 58, 24) })}
  `;
});

const TOTAL = cursor;

// ---- render ---------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (let f = 0; f < TOTAL; f++) {
  const s = S.find((x) => f >= x.start && f < x.start + x.dur);
  const local = f - s.start;
  // fade the whole scene out over its last 8 frames, so cuts are soft
  const tail = s.dur - local;
  const fade = tail < 9 ? tail / 9 : 1;
  const body = s.draw(local);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>text { font-family: "DejaVu Sans Mono", monospace; }</style>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g opacity="${fade.toFixed(3)}">${body}</g>
<text x="${W - 40}" y="${H - 34}" font-size="20" fill="${C.dim}" text-anchor="end" opacity="0.8">accrual.tools</text>
</svg>`;
  const n = String(f).padStart(4, '0');
  writeFileSync(`${OUT}/f${n}.svg`, svg);
}

console.log(`wrote ${TOTAL} frames (${(TOTAL / FPS).toFixed(1)}s at ${FPS} fps)`);
console.log('figures used, all from the library:');
for (const [k, v] of Object.entries(F)) {
  console.log('  ' + k.padEnd(18) + (typeof v === 'number' ? v.toFixed(4) : v));
}
// Rasterise in parallel. One rsvg-convert process per frame in series takes
// minutes for a thousand frames; xargs -P uses every core instead.
execFileSync('/bin/sh', [
  '-c',
  `cd ${OUT} && ls f*.svg | xargs -P "$(nproc)" -I{} sh -c 'rsvg-convert -w ${W} -h ${H} "{}" -o "$(basename {} .svg).png"'`,
]);
console.log('rasterised to png');
