import {
  CONVENTIONS, compareConventions, actualDays,
  accrueSimple, accrueCompound, effectiveAnnualRate,
  billYields, bondMetrics, priceShock,
  levelPayment, amortisationSchedule, payoffWithExtra, rateFromPayment,
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

/* loan */
function renderLoan() {
  const principal = +$('l-principal').value;
  const rate = +$('l-rate').value / 100;
  const years = +$('l-years').value;
  const m = +$('l-freq').value;
  const extra = +$('l-extra').value;

  const s = amortisationSchedule({ principal, rate, years, periodsPerYear: m });
  $('l-payment').textContent = fmt(s.payment);
  kv($('l-kv'), [
    ['payments', s.periods],
    ['total paid', fmt(s.totalPaid)],
    ['total interest', fmt(s.totalInterest)],
    /* Safe: amortisationSchedule refuses a principal of zero before we reach here. */
    ['interest as % of principal', pct(s.totalInterest / principal, 1)],
  ]);

  /* The single most useful number in consumer finance, and almost nobody is
     shown it: what overpaying every period is worth. payoffWithExtra rejects a
     zero extra, so ask only when there is one, and say plainly when there isn't. */
  if (extra > 0) {
    const p = payoffWithExtra({ principal, rate, years, periodsPerYear: m, extraPayment: extra });
    $('l-save').textContent =
      `paying ${fmt(extra)} more each period clears it ${p.yearsSaved.toFixed(1)} years early ` +
      `and saves ${fmt(p.interestSaved)} in interest.`;
  } else {
    $('l-save').textContent = 'add an amount above to see what overpaying saves.';
  }

  /* The whole schedule is every period; showing all 360 rows buries the shape.
     The first year, the last year, and the halfway point tell the story: early
     payments are almost all interest, late payments almost all principal. */
  const rows = s.rows;
  const marks = new Set([
    ...[0, 1, 2, 3, 4, 5].filter((i) => i < rows.length),
    Math.floor(rows.length / 2),
    ...[rows.length - 2, rows.length - 1].filter((i) => i >= 0),
  ]);
  const picked = [...marks].sort((a, b) => a - b);
  let prev = -1;
  $('l-rows').innerHTML = picked.map((i) => {
    const row = rows[i];
    const gap = i - prev > 1 ? `<tr><td colspan="4" style="color:var(--dim);text-align:center">payment ${prev + 2} … ${i}</td></tr>` : '';
    prev = i;
    return gap +
      `<tr><td>${i + 1}</td><td class="n">${fmt(row.interest)}</td><td class="n">${fmt(row.principal)}</td><td class="n">${fmt(row.balance)}</td></tr>`;
  }).join('');
}

/* compare */
function renderCompare() {
  const freqLabel = { 1: 'annual', 2: 'semi-annual', 4: 'quarterly', 12: 'monthly', 365: 'daily', inf: 'continuous' };
  const read = (which) => {
    const nominal = +$(`c-${which}-rate`).value / 100;
    const sel = $(`c-${which}-freq`).value;
    const m = sel === 'inf' ? Infinity : +sel;
    return { label: `offer ${which.toUpperCase()}`, nominal, m, freq: freqLabel[sel], ear: effectiveAnnualRate(nominal, m) };
  };
  const a = read('a'), b = read('b');

  /* The whole point: rank on effective annual rate, not the nominal in the ad.
     A tie is real (same rate, same frequency) and must not be printed as a
     winner. */
  const tie = Math.abs(a.ear - b.ear) < 1e-12;
  const win = tie ? null : a.ear > b.ear ? a : b;
  const lose = win === a ? b : win === b ? a : null;

  $('c-winner').textContent = tie ? 'a tie' : `${win.label} wins`;

  $('c-rows').innerHTML = [a, b].map((o) => {
    const hit = !tie && o === win ? ' class="hit"' : '';
    return `<tr${hit}><td>${o.label}</td><td class="n">${pct(o.nominal, 3)}</td><td class="n">${o.freq}</td><td class="n">${pct(o.ear, 4)}</td></tr>`;
  }).join('');

  /* Only worth a headline when the higher effective rate has the LOWER nominal:
     that is the counterintuitive case the whole tab exists to surface. */
  if (tie) {
    $('c-note').textContent = 'identical effective rates. compounding makes no difference here.';
  } else if (win.nominal < lose.nominal) {
    const bp = (win.ear - lose.ear) * 10000;
    $('c-note').textContent =
      `${win.label} quotes the lower nominal rate and still pays more: compounded ${win.freq}, ` +
      `it earns ${bp.toFixed(1)} bp more per year. the rate in the ad is not the rate you get.`;
  } else {
    const bp = (win.ear - lose.ear) * 10000;
    $('c-note').textContent = `${win.label} pays ${bp.toFixed(1)} bp more per year on an effective basis.`;
  }
}

/* true rate: the offer states a payment, not a rate. Solve for the rate. */
function renderRate() {
  const principal = +$('r-principal').value;
  const payment = +$('r-payment').value;
  const years = +$('r-years').value;
  const m = +$('r-freq').value;

  const r = rateFromPayment({ principal, payment, years, periodsPerYear: m });
  $('r-rate').textContent = pct(r.rate, 3);

  /* "Flat" is how instalment offers are often quoted: interest on the full
     amount for the whole term, even though the balance falls every payment.
     Showing the flat figure beside the solved rate is the point of this tab. */
  const flat = r.totalInterest / (principal * years);
  kv($('r-kv'), [
    ['payments', Math.round(years * m)],
    ['total paid', fmt(r.totalPaid)],
    ['total interest', fmt(r.totalInterest)],
    ['nominal annual rate (APR)', pct(r.rate, 3)],
    ['effective annual rate', pct(effectiveAnnualRate(r.rate, m), 3)],
    ['same deal quoted "flat"', pct(flat, 3)],
  ]);

  $('r-note').textContent = r.rate === 0
    ? 'the payments repay exactly what was borrowed. this really is 0%.'
    : `quoted flat this is ${pct(flat, 2)}. the balance falls every payment but the interest does not, ` +
      `so the rate you pay is ${pct(r.rate, 2)}, ${(r.rate / flat).toFixed(2)}× the flat figure.`;
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
wire(['l-principal', 'l-rate', 'l-years', 'l-freq', 'l-extra'], renderLoan, $('l-payment'), [$('l-kv'), $('l-save'), $('l-rows')]);
wire(['c-a-rate', 'c-a-freq', 'c-b-rate', 'c-b-freq'], renderCompare, $('c-winner'), [$('c-rows'), $('c-note')]);
wire(['r-principal', 'r-payment', 'r-years', 'r-freq'], renderRate, $('r-rate'), [$('r-kv'), $('r-note')]);

/* Shareable permalinks. A calculation is only worth showing someone if they can
   see the same numbers, so the whole state — which tab, every field in it —
   rides in the URL hash. Nothing leaves the page: the hash is read and written
   locally and the copy uses the clipboard, so the "nothing is sent anywhere"
   promise above still holds. Values are only ever assigned to input.value, never
   to innerHTML, so a hand-edited link can change the numbers but cannot inject.*/
const DEFAULT_SHARE_MSG = 'every input above lives in the link, nothing is sent anywhere';
const paneOf = (tab) => $(tab.getAttribute('aria-controls'));
const fieldsIn = (pane) => [...pane.querySelectorAll('input[id], select[id]')];
const activeTab = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];

/* Only the active tab's fields are encoded: a link means "look at this", and the
   panes the sender never opened carry their defaults, so writing them would just
   make the URL longer without saying anything. */
function stateToHash() {
  const tab = activeTab();
  const p = new URLSearchParams();
  p.set('t', tab.id.replace(/^tab-/, ''));
  for (const el of fieldsIn(paneOf(tab))) p.set(el.id, el.value);
  return '#' + p.toString();
}

/* replaceState, not pushState: typing must not bury the back button under one
   history entry per keystroke. */
function syncUrl() {
  history.replaceState(null, '', stateToHash());
}

function applyHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return false;
  const p = new URLSearchParams(raw);
  const tab = p.get('t') && $('tab-' + p.get('t'));
  if (!tab) return false;
  tab.click(); // reuses the tab handler, so aria state and hidden panes stay correct
  let touched = null;
  for (const el of fieldsIn(paneOf(tab))) {
    if (p.has(el.id)) { el.value = p.get(el.id); touched = el; }
  }
  // One event is enough: each wired render re-reads every field its calculator owns.
  if (touched) touched.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

const calc = document.querySelector('.calc');
function onCalcChange() {
  syncUrl();
  $('share-msg').textContent = DEFAULT_SHARE_MSG;
}
calc.addEventListener('input', onCalcChange);
calc.addEventListener('change', onCalcChange);
tabs.forEach((t) => t.addEventListener('click', onCalcChange));

$('share-copy').addEventListener('click', async () => {
  syncUrl();
  const url = location.href;
  const msg = $('share-msg');
  try {
    await navigator.clipboard.writeText(url);
    msg.textContent = 'link copied. it reproduces exactly these inputs, offline.';
  } catch {
    // Clipboard blocked (no permission, or an insecure context): show the link
    // so it can still be copied by hand rather than failing silently.
    msg.textContent = url;
  }
});

// A pasted or hand-edited link should take effect; replaceState above never
// fires this, so there is no loop.
window.addEventListener('hashchange', applyHash);

// Restore last, after every calculator is wired, so the dispatched input lands
// on live listeners.
applyHash();
