// Builds the frames for the "compare two offers" demo video. Every number
// rendered comes out of the library at build time; nothing is typed by hand.
//
// The story: offer A quotes a higher nominal rate than offer B, so A looks
// better. Convert both to an effective annual rate — the only fair basis when
// the compounding frequency differs — and B wins. The rate in the ad is not
// the rate you get.
//
// Output is a sequence of PNGs at 1280x720, 30 fps, muxed by ffmpeg. No audio.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { effectiveAnnualRate } from '../src/index.mjs';

const W = 1280;
const H = 720;
const FPS = 30;
const OUT = '/tmp/cmpvid';

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

const A = { nominal: 0.05, m: 1, freq: 'annual' };
const B = { nominal: 0.0495, m: 12, freq: 'monthly' };
const PRINCIPAL = 100000;

const F = {
  aNominal: A.nominal,
  bNominal: B.nominal,
  aEar: effectiveAnnualRate(A.nominal, A.m),
  bEar: effectiveAnnualRate(B.nominal, B.m),
};
F.gapBp = (F.bEar - F.aEar) * 10000;
F.aEarns = F.aEar * PRINCIPAL;
F.bEarns = F.bEar * PRINCIPAL;
F.extra = F.bEarns - F.aEarns;

// Sanity: the story the video tells must actually be true.
const assert = (cond, msg) => {
  if (!cond) throw new Error('figure check failed: ' + msg);
};
assert(A.nominal > B.nominal, 'A must quote the higher nominal, or there is no surprise');
assert(F.bEar > F.aEar, 'B must win on effective rate, or the whole pitch is wrong');
assert(F.gapBp > 0, 'the gap must be positive in B favour');
assert(Math.abs(F.extra - (F.bEarns - F.aEarns)) < 1e-6, 'extra must equal the earnings difference');

// ---- helpers --------------------------------------------------------------

const money = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => Math.round(n).toLocaleString('en-US');
const pct = (v, dp = 4) => `${(v * 100).toFixed(dp)}%`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const seg = (frame, start, dur) => ease(clamp01((frame - start) / dur));

const txt = (x, y, s, { size = 24, fill = C.dim, anchor = 'start', weight = 'normal', op = 1 } = {}) =>
  op <= 0.001
    ? ''
    : `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" opacity="${op.toFixed(3)}">${esc(s)}</text>`;

// A card for one offer. highlight paints the border in the accent colour.
const card = (x, y, w, h, { op = 1, highlight = false } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.panel}" stroke="${highlight ? C.acid : C.line}" stroke-width="${highlight ? 3 : 2}" opacity="${op.toFixed(3)}"/>`;

// ---- scenes ---------------------------------------------------------------

const S = [];
let cursor = 0;
const scene = (dur, draw) => { S.push({ start: cursor, dur, draw }); cursor += dur; };

// 1. title
scene(78, (f) => {
  const a = seg(f, 0, 30);
  const b = seg(f, 22, 34);
  return `
    ${txt(90, 300, 'two savings offers', { size: 76, fill: C.ink, weight: 'bold', op: a })}
    ${txt(90, 380, 'which one pays more', { size: 76, fill: C.ink, weight: 'bold', op: b })}
    ${txt(90, 452, 'the answer is not the bigger number', { size: 30, op: seg(f, 48, 26) })}
  `;
});

// 2. the two offers, as advertised
scene(108, (f) => {
  const a = seg(f, 0, 24);
  const b = seg(f, 20, 26);
  return `
    ${txt(90, 140, 'as advertised', { size: 30, op: a })}
    ${card(90, 190, 520, 210, { op: a })}
    ${txt(120, 250, 'offer A', { size: 30, fill: C.dim, op: a })}
    ${txt(120, 336, pct(F.aNominal, 2), { size: 84, fill: C.ink, weight: 'bold', op: a })}
    ${txt(120, 380, 'compounded annually', { size: 24, op: seg(f, 30, 22) })}
    ${card(660, 190, 520, 210, { op: b })}
    ${txt(690, 250, 'offer B', { size: 30, fill: C.dim, op: b })}
    ${txt(690, 336, pct(F.bNominal, 2), { size: 84, fill: C.ink, weight: 'bold', op: b })}
    ${txt(690, 380, 'compounded monthly', { size: 24, op: seg(f, 44, 22) })}
    ${txt(90, 470, 'A quotes the higher rate, so A wins. right?', { size: 34, fill: C.amber, op: seg(f, 62, 28) })}
    ${txt(90, 520, 'that is the number the marketing wants you to read', { size: 24, op: seg(f, 78, 26) })}
  `;
});

// 3. the catch: frequency
scene(96, (f) => {
  const a = seg(f, 0, 26);
  return `
    ${txt(90, 180, 'but they compound at different speeds', { size: 40, fill: C.ink, weight: 'bold', op: a })}
    ${txt(90, 270, 'A adds interest once a year', { size: 30, fill: C.amber, op: seg(f, 22, 26) })}
    ${txt(90, 320, 'B adds it twelve times, and each month earns on the last', { size: 30, fill: C.acid, op: seg(f, 40, 28) })}
    ${txt(90, 430, 'a nominal rate hides that. the effective annual rate does not.', { size: 30, fill: C.dim, op: seg(f, 62, 30) })}
    ${txt(90, 486, 'it is the one number that makes them comparable.', { size: 30, fill: C.dim, op: seg(f, 78, 26) })}
  `;
});

// 4. convert both to EAR, count up
scene(126, (f) => {
  const a = seg(f, 0, 22);
  const va = F.aEar * seg(f, 12, 40);
  const vb = F.bEar * seg(f, 12, 40);
  const flip = seg(f, 70, 30);
  const bWins = F.bEar > F.aEar;
  return `
    ${txt(90, 140, 'effective annual rate', { size: 30, op: a })}
    ${card(90, 190, 520, 220, { op: a, highlight: false })}
    ${txt(120, 250, 'offer A', { size: 26, fill: C.dim, op: a })}
    ${txt(120, 340, pct(va, 4), { size: 76, fill: C.ink, weight: 'bold', op: a })}
    ${txt(120, 388, `nominal ${pct(F.aNominal, 2)}, annual`, { size: 22, op: seg(f, 30, 22) })}
    ${card(660, 190, 520, 220, { op: a, highlight: bWins && flip > 0.5 })}
    ${txt(690, 250, 'offer B', { size: 26, fill: C.dim, op: a })}
    ${txt(690, 340, pct(vb, 4), { size: 76, fill: bWins && flip > 0.5 ? C.acid : C.ink, weight: 'bold', op: a })}
    ${txt(690, 388, `nominal ${pct(F.bNominal, 2)}, monthly`, { size: 22, op: seg(f, 30, 22) })}
    ${txt(90, 490, 'B has the lower advertised rate', { size: 30, fill: C.amber, op: flip })}
    ${txt(90, 540, 'and the higher real one', { size: 44, fill: C.acid, weight: 'bold', op: seg(f, 84, 26) })}
  `;
});

// 5. what the gap is worth on real money
scene(120, (f) => {
  const a = seg(f, 0, 24);
  const g = F.gapBp * seg(f, 12, 40);
  return `
    ${txt(90, 160, 'the gap', { size: 34, op: a })}
    ${txt(90, 300, `${g.toFixed(1)} bp`, { size: 104, fill: C.acid, weight: 'bold', op: a })}
    ${txt(90, 372, 'more per year, in B favour', { size: 30, op: seg(f, 40, 24) })}
    ${txt(90, 470, `on ${money0(PRINCIPAL)} that is ${money(F.extra)} a year`, { size: 40, fill: C.acid, op: seg(f, 58, 28) })}
    ${txt(90, 528, 'the higher nominal rate simply loses', { size: 28, fill: C.dim, op: seg(f, 76, 26) })}
  `;
});

// 6. one call
scene(120, (f) => {
  const a = seg(f, 0, 22);
  const lines = [
    ['{', C.dim, 22],
    [`  "higher": "offer B",`, C.acid, 22],
    [`  "a": { "nominalRate": ${F.aNominal}, "effectiveAnnualRate": ${F.aEar.toFixed(6)} },`, C.ink, 20],
    [`  "b": { "nominalRate": ${F.bNominal}, "effectiveAnnualRate": ${F.bEar.toFixed(6)} },`, C.ink, 20],
    [`  "differenceBp": ${F.gapBp.toFixed(4)}`, C.amber, 22],
    ['}', C.dim, 22],
  ];
  const rows = lines
    .map((l, i) => txt(120, 290 + i * 38, l[0], { size: l[2], fill: l[1], op: seg(f, 24 + i * 8, 20) }))
    .join('');
  return `
    ${txt(90, 150, 'one MCP tool your agent can call', { size: 34, fill: C.ink, op: a })}
    <rect x="90" y="200" width="1100" height="330" rx="12" fill="${C.panel}" stroke="${C.line}" stroke-width="2" opacity="${a.toFixed(3)}"/>
    ${txt(120, 250, 'compare_products  { a: 5% annual, b: 4.95% monthly }', { size: 22, fill: C.acid, op: a })}
    ${rows}
  `;
});

// 7. close
scene(96, (f) => {
  const a = seg(f, 0, 24);
  return `
    ${txt(90, 250, 'accrual', { size: 86, fill: C.ink, weight: 'bold', op: a })}
    ${txt(90, 312, 'day counts, bills, bonds, loans, and honest comparisons', { size: 28, op: seg(f, 16, 24) })}
    ${txt(90, 356, 'library, CLI, 13-tool MCP server, zero dependencies', { size: 28, op: seg(f, 28, 24) })}
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
  console.log('  ' + k.padEnd(12) + (typeof v === 'number' ? v.toFixed(6) : v));
}

execFileSync('/bin/sh', [
  '-c',
  `cd ${OUT} && ls f*.svg | xargs -P "$(nproc)" -I{} sh -c 'rsvg-convert -w ${W} -h ${H} "{}" -o "$(basename {} .svg).png"'`,
]);
console.log('rasterised to png');
