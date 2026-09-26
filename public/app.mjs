import {
  CONVENTIONS, compareConventions, actualDays,
  accrueSimple, accrueCompound, effectiveAnnualRate,
  billYields, bondMetrics, priceShock,
} from '/accrual.mjs';

const $ = (id) => document.getElementById(id);
const fmt = (v, dp = 2) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (v, dp = 4) => `${(v * 100).toFixed(dp)}%`;

function kv(host, pairs) {
  host.innerHTML = pairs
    .map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`)
    .join('');
}

/* tabs */
const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach((t) => {
  t.addEventListener('click', () => {
    tabs.forEach((o) => {
      const on = o === t;
      o.setAttribute('aria-selected', String(on));
      $(o.getAttribute('aria-controls')).hidden = !on;
    });
  });
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const next = e.key === 'ArrowRight' ? tabs[i + 1] : e.key === 'ArrowLeft' ? tabs[i - 1] : null;
    if (next) { next.focus(); next.click(); }
  });
});

/* Guard: a calculator shows the reason instead of throwing into the console.
   It used to say "check the dates" for every failure, including a face value of
   zero or a negative principal, which sent people looking in the wrong place.

   The stale regions have to be emptied too. A calculator writes its headline
   figure and its detail tables in separate steps, so a throw part-way through
   left the tables holding the last good render: "face must be > 0" sat directly
   above a duration of 8.2556 years, which reads as a working number rather than
   as a leftover. Blank them, so the only thing on screen is the reason. */
function safely(fn, message, stale = []) {
  try {
    fn();
  } catch (err) {
    if (message) {
      message.textContent = /date/i.test(err.message) ? 'check the dates' : err.message;
    }
    for (const el of stale) if (el) el.innerHTML = '';
  }
}

/* A share whose denominator can legitimately be zero prints "NaN%" via toFixed,
   which reads as a broken page rather than as nothing to divide by. */
const share = (part, whole, dp = 3) =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(dp)}%`;

/* day count */
function renderDays() {
  const spread = compareConventions($('d-from').value, $('d-to').value);
  const vals = Object.values(spread);
  const max = Math.max(...vals), min = Math.min(...vals);
  $('d-rows').innerHTML = Object.entries(spread).map(([name, v]) => {
    const denom = name.endsWith('/360') ? 360 : 365;
    const hit = v === max && max !== min ? ' class="hit"' : '';
    return `<tr${hit}><td>${name}</td><td class="n">${v.toFixed(8)}</td><td class="n">${(v * denom).toFixed(2)} / ${denom}</td></tr>`;
  }).join('');
  const days = actualDays($('d-from').value, $('d-to').value);
  /* min is 0 whenever a convention decides no time passed: identical dates, or a
     pair like 2025-01-30 to 2025-01-31 that the 30/360 family collapses to zero.
     Reporting 0% there claimed the conventions agreed when they do not. */
  $('d-spread').textContent =
    Math.abs(min) === 0
      ? `${days} actual days. widest disagreement ${(max - min).toFixed(8)} years; no percentage, the lowest convention returns zero.`
      : `${days} actual days. widest disagreement ${(((max - min) / Math.abs(min)) * 100).toFixed(3)}% between conventions.`;
}

/* accrual */
function renderAccrue() {
  const principal = +$('a-principal').value;
  const rate = +$('a-rate').value / 100;
  const from = $('a-from').value, to = $('a-to').value;
  const comp = $('a-comp').value;

  if (comp === '0') {
    const base = accrueSimple({ principal, rate, from, to, convention: 'ACT/360' });
    $('a-interest').textContent = fmt(base.interest);
    kv($('a-kv'), [
      ['days', base.days],
      ['year fraction (ACT/360)', base.years.toFixed(8)],
      ['principal + interest', fmt(principal + base.interest)],
    ]);
    $('a-rows').innerHTML = CONVENTIONS.map((c) => {
      const alt = accrueSimple({ principal, rate, from, to, convention: c });
      const d = alt.interest - base.interest;
      const hit = c === 'ACT/360' ? ' class="hit"' : '';
      return `<tr${hit}><td>${c}</td><td class="n">${fmt(alt.interest)}</td><td class="n">${d === 0 ? '—' : (d > 0 ? '+' : '') + fmt(d)}</td></tr>`;
    }).join('');
  } else {
    const m = comp === 'inf' ? Infinity : +comp;
    const res = accrueCompound({ principal, rate, from, to, periodsPerYear: m, convention: 'ACT/365F' });
    $('a-interest').textContent = fmt(res.interest);
    kv($('a-kv'), [
      ['days', res.days],
      ['year fraction (ACT/365F)', res.years.toFixed(8)],
      ['compounding', m === Infinity ? 'continuous' : `${m}× / year`],
      ['effective annual rate', pct(effectiveAnnualRate(rate, m))],
      ['future value', fmt(res.future)],
    ]);
    $('a-rows').innerHTML = CONVENTIONS.map((c) => {
      const alt = accrueCompound({ principal, rate, from, to, periodsPerYear: m, convention: c });
      const d = alt.interest - res.interest;
      return `<tr><td>${c}</td><td class="n">${fmt(alt.interest)}</td><td class="n">${d === 0 ? '—' : (d > 0 ? '+' : '') + fmt(d)}</td></tr>`;
    }).join('');
  }
}

/* bill */
function renderBill() {
  const face = +$('b-face').value, price = +$('b-price').value;
  const r = billYields({ face, price, settle: $('b-settle').value, maturity: $('b-mat').value });
  $('b-inv').textContent = pct(r.investmentYield);
  kv($('b-kv'), [
    ['days to maturity', r.days],
    ['gain', fmt(r.gain, 4)],
    ['discount yield (as quoted)', pct(r.discountYield)],
    ['investment yield (earned)', pct(r.investmentYield)],
    ['gap', `${((r.investmentYield - r.discountYield) * 10000).toFixed(1)} bp`],
  ]);
}

/* bond */
function renderBond() {
  const face = +$('n-face').value;
  const r = bondMetrics({
    face,
    couponRate: +$('n-coupon').value / 100,
    yield: +$('n-yield').value / 100,
    years: +$('n-years').value,
    periodsPerYear: +$('n-freq').value,
  });
  $('n-price').textContent = fmt(r.price, 4);
  kv($('n-kv'), [
    /* Safe to divide: bondMetrics refuses a face of zero before we get here. */
    ['per 100 face', fmt((r.price / face) * 100, 4)],
    ['vs par', r.price > face ? 'premium' : r.price < face ? 'discount' : 'par'],
    ['macaulay duration', `${r.macaulay.toFixed(4)} y`],
    ['modified duration', r.modified.toFixed(4)],
    ['convexity', r.convexity.toFixed(4)],
  ]);
  $('n-rows').innerHTML = [-200, -100, -50, 50, 100, 200].map((bp) => {
    const s = priceShock(r.price, r.modified, r.convexity, bp / 10000);
    return `<tr><td>${bp > 0 ? '+' : ''}${bp} bp</td><td class="n">${fmt(s.withConvexity, 4)}</td><td class="n">${share(s.withConvexity - r.price, r.price)}</td></tr>`;
  }).join('');
}

/* ids: what re-renders on change. message: where the reason goes. stale: the
   regions that must be cleared so no superseded number survives an error. */
const wire = (ids, fn, message, stale = []) => {
  const run = () => safely(fn, message, stale);
  ids.forEach((id) => { $(id).addEventListener('input', run); $(id).addEventListener('change', run); });
  run();
};

wire(['d-from', 'd-to'], renderDays, $('d-spread'), [$('d-rows')]);
wire(['a-principal', 'a-rate', 'a-from', 'a-to', 'a-comp'], renderAccrue, $('a-interest'), [$('a-kv'), $('a-rows')]);
wire(['b-face', 'b-price', 'b-settle', 'b-mat'], renderBill, $('b-inv'), [$('b-kv')]);
wire(['n-face', 'n-coupon', 'n-yield', 'n-years', 'n-freq'], renderBond, $('n-price'), [$('n-kv'), $('n-rows')]);
