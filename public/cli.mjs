#!/usr/bin/env node
// cli.mjs — served verbatim from src/. accrual is MIT licensed.
// No network calls, no key material, no signing. Read it before you run it.

// accrual CLI. Read only. Takes numbers, prints numbers.

import {
  CONVENTIONS,
  CONVENTION_NOTES,
  compareConventions,
  actualDays,
  accrueSimple,
  accrueCompound,
  effectiveAnnualRate,
  presentValue,
  billYields,
  bondMetrics,
  priceShock,
  levelPayment,
  amortisationSchedule,
  payoffWithExtra,
  bulletSchedule,
  rateFromPayment,
  affordablePrincipal,
} from './accrual.mjs';

const C = process.stdout.isTTY
  ? { d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[38;5;36m', y: '\x1b[38;5;179m', r: '\x1b[0m' }
  : { d: '', b: '', g: '', y: '', r: '' };

const num = (v, dp = 6) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (v, dp = 4) => `${(v * 100).toFixed(dp)}%`;

// Share of a total that can legitimately be zero: an interest-free loan, or two
// conventions that both return a year fraction of 0. toFixed on 0/0 prints the
// literal string "NaN%", which looks like the tool broke rather than like there
// being nothing to divide by.
const share = (part, whole, dp = 1) =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(dp)}%`;

/** Parse --key value and --key=value into an object. */
function parseArgs(argv) {
  // A null prototype, not {}. With a normal object literal, args.constructor
  // and args.toString are inherited and never undefined, so need() below would
  // treat a flag named after any Object.prototype member as already supplied.
  // No flag is named that today, which is luck rather than design.
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return out;
}

function need(args, keys) {
  const missing = keys.filter((k) => args[k] === undefined);
  if (missing.length) {
    console.error(`${C.y}missing required: ${missing.map((m) => '--' + m).join(' ')}${C.r}`);
    process.exit(2);
  }
}

/**
 * Accept 4.25 or 0.0425 for a rate. Over 1 is read as a percentage.
 *
 * An explicit trailing % is honoured exactly, which is the only unambiguous
 * form: the bare-number heuristic has to guess, and it guesses wrong for a rate
 * of 1% or less, reading `--rate 1` as 100%. Writing `--rate 1%` says which one
 * you meant. Humans type the sign, so accepting it costs nothing.
 */
function rate(v, label) {
  const raw = String(v).trim();
  const isPercent = raw.endsWith('%');
  const n = Number(isPercent ? raw.slice(0, -1).replace(/[_,]/g, '') : raw);
  if (!Number.isFinite(n)) {
    console.error(`${C.y}${label} is not a number: ${v}${C.r}`);
    process.exit(2);
  }
  if (isPercent) return n / 100;
  return Math.abs(n) > 1 ? n / 100 : n;
}

function money(v, label) {
  const n = Number(String(v).replace(/[_,]/g, ''));
  if (!Number.isFinite(n)) {
    console.error(`${C.y}${label} is not a number: ${v}${C.r}`);
    process.exit(2);
  }
  return n;
}

// --years abc and --freq abc used to reach the library as NaN and surface as
// "years must be a finite number, got null", which blames the wrong thing and
// names a value the user never typed. Reject at the boundary instead.
function count(v, label, fallback) {
  if (v === undefined || v === 'true') {
    if (fallback !== undefined) return fallback;
    console.error(`${C.y}missing required: --${label}${C.r}`);
    process.exit(2);
  }
  const n = Number(String(v).replace(/[_,]/g, ''));
  if (!Number.isFinite(n)) {
    console.error(`${C.y}${label} is not a number: ${v}${C.r}`);
    process.exit(2);
  }
  if (n <= 0) {
    console.error(`${C.y}${label} must be greater than zero, got ${v}${C.r}`);
    process.exit(2);
  }
  return n;
}

function row(label, value, note = '') {
  const pad = label.padEnd(22);
  console.log(`  ${C.d}${pad}${C.r}${value}${note ? ` ${C.d}${note}${C.r}` : ''}`);
}

function head(t) {
  console.log(`\n${C.b}${t}${C.r}`);
}

const commands = {
  days(args) {
    need(args, ['from', 'to']);
    head(`day count  ${args.from} -> ${args.to}`);
    row('actual days', actualDays(args.from, args.to));
    const spread = compareConventions(args.from, args.to);
    const vals = Object.values(spread);
    console.log();
    for (const [name, v] of Object.entries(spread)) {
      // Show the numerator each convention believes in, using its own denominator.
      const denom = name.endsWith('/360') ? 360 : 365;
      row(name, num(v, 8), `${(v * denom).toFixed(2)}d / ${denom}`);
    }
    const gap = Math.max(...vals) - Math.min(...vals);
    const low = Math.abs(Math.min(...vals));
    console.log();
    row('widest disagreement', num(gap, 8), 'years, between the extremes');
    row(
      'as a percentage',
      low === 0 ? 'n/a' : `${((gap / low) * 100).toFixed(3)}%`,
      low === 0 ? 'the lowest convention returns zero' : 'of the lowest convention'
    );
  },

  accrue(args) {
    need(args, ['principal', 'rate', 'from', 'to']);
    const principal = money(args.principal, 'principal');
    const r = rate(args.rate, 'rate');
    const conv = args.convention || 'ACT/360';

    head(`accrual  ${args.from} -> ${args.to}`);
    row('principal', num(principal, 2));
    row('rate', pct(r));
    row('convention', conv, CONVENTION_NOTES[conv] ? '' : '(unknown)');

    if (args.compound) {
      const m = args.compound === 'continuous' ? Infinity : count(args.compound, 'compound');
      const res = accrueCompound({ principal, rate: r, from: args.from, to: args.to, periodsPerYear: m, convention: conv });
      console.log();
      row('days', res.days);
      row('year fraction', num(res.years, 8));
      row('compounding', m === Infinity ? 'continuous' : `${m}x / year`);
      row('interest', num(res.interest, 2));
      row('future value', `${C.g}${num(res.future, 2)}${C.r}`);
      row('effective annual', pct(effectiveAnnualRate(r, m)));
    } else {
      const res = accrueSimple({ principal, rate: r, from: args.from, to: args.to, convention: conv });
      console.log();
      row('days', res.days);
      row('year fraction', num(res.years, 8));
      row('interest', `${C.g}${num(res.interest, 2)}${C.r}`);
      row('total', num(principal + res.interest, 2));
      console.log();
      console.log(`  ${C.d}same position, every convention${C.r}`);
      for (const c of CONVENTIONS) {
        const alt = accrueSimple({ principal, rate: r, from: args.from, to: args.to, convention: c });
        const delta = alt.interest - res.interest;
        const tag = c === conv ? `${C.g} <- chosen${C.r}` : delta === 0 ? '' : `${C.d}${delta > 0 ? '+' : ''}${num(delta, 2)}${C.r}`;
        row(`  ${c}`, num(alt.interest, 2), tag);
      }
    }
  },

  bill(args) {
    need(args, ['face', 'price', 'settle', 'maturity']);
    const res = billYields({
      face: money(args.face, 'face'),
      price: money(args.price, 'price'),
      settle: args.settle,
      maturity: args.maturity,
    });
    head(`bill  ${args.settle} -> ${args.maturity}`);
    row('face', num(money(args.face), 4));
    row('price', num(money(args.price), 4));
    row('days to maturity', res.days);
    row('gain', num(res.gain, 4));
    console.log();
    row('discount yield', pct(res.discountYield), 'how it is quoted, gain / face, 360d');
    row('investment yield', `${C.g}${pct(res.investmentYield)}${C.r}`, 'what you earn, gain / price, 365d');
    row('gap', `${((res.investmentYield - res.discountYield) * 10000).toFixed(1)} bp`);
  },

  bond(args) {
    need(args, ['face', 'coupon', 'yield', 'years']);
    const face = money(args.face, 'face');
    const m = count(args.freq, 'freq', 2);
    const res = bondMetrics({
      face,
      couponRate: rate(args.coupon, 'coupon'),
      yield: rate(args.yield, 'yield'),
      years: count(args.years, 'years'),
      periodsPerYear: m,
    });

    head(`bond  ${args.years}y, ${pct(rate(args.coupon))} coupon, ${m}x / year`);
    row('yield to maturity', pct(rate(args.yield)));
    row('price', `${C.g}${num(res.price, 4)}${C.r}`, res.price > face ? 'premium' : res.price < face ? 'discount' : 'par');
    row('per 100 face', num((res.price / face) * 100, 4));
    console.log();
    row('macaulay duration', `${num(res.macaulay, 4)} y`);
    row('modified duration', `${num(res.modified, 4)}`, 'price % move per 100bp');
    row('convexity', num(res.convexity, 4));
    console.log();
    console.log(`  ${C.d}yield shock${C.r}`);
    for (const bp of [-100, -50, 50, 100, 200]) {
      const s = priceShock(res.price, res.modified, res.convexity, bp / 10000);
      const sign = bp > 0 ? '+' : '';
      row(`  ${sign}${bp} bp`, num(s.withConvexity, 4), share(s.withConvexity - res.price, res.price, 3));
    }
  },

  pv(args) {
    need(args, ['amount', 'rate', 'from', 'to']);
    const res = presentValue({
      amount: money(args.amount, 'amount'),
      rate: rate(args.rate, 'rate'),
      from: args.from,
      to: args.to,
      periodsPerYear: args.compound === 'continuous' ? Infinity : count(args.compound, 'compound', 1),
      convention: args.convention || 'ACT/365F',
    });
    head(`present value  ${args.from} -> ${args.to}`);
    row('future amount', num(money(args.amount), 2));
    row('discount rate', pct(rate(args.rate)));
    row('year fraction', num(res.years, 8));
    row('discount factor', num(res.discountFactor, 8));
    row('present value', `${C.g}${num(res.pv, 2)}${C.r}`);
  },

  loan(args) {
    need(args, ['years']);
    const m = count(args.freq, 'freq', 12);
    const yearsIn = count(args.years, 'years');

    // Three ways in: solve the payment, solve the rate, or solve the principal.
    if (args.payment !== undefined && args.principal !== undefined) {
      need(args, ['principal', 'payment', 'years']);
      const res = rateFromPayment({
        principal: money(args.principal, 'principal'),
        payment: money(args.payment, 'payment'),
        years: yearsIn,
        periodsPerYear: m,
      });
      head(`implied rate  ${yearsIn}y, ${m}x / year`);
      row('principal', num(money(args.principal), 2));
      row('payment', num(money(args.payment), 2), 'per period');
      console.log();
      row('nominal rate', `${C.g}${pct(res.rate)}${C.r}`, 'how it gets quoted');
      row('effective annual', pct(Math.pow(1 + res.periodicRate, m) - 1), 'what you actually pay');
      row('total paid', num(res.totalPaid, 2));
      row('total interest', `${C.y}${num(res.totalInterest, 2)}${C.r}`);
      return;
    }

    if (args.payment !== undefined) {
      need(args, ['payment', 'rate', 'years']);
      const res = affordablePrincipal({
        payment: money(args.payment, 'payment'),
        rate: rate(args.rate, 'rate'),
        years: yearsIn,
        periodsPerYear: m,
      });
      head(`what that payment buys  ${yearsIn}y, ${m}x / year`);
      row('payment', num(money(args.payment), 2), 'per period');
      row('rate', pct(rate(args.rate)));
      console.log();
      row('you can borrow', `${C.g}${num(res.principal, 2)}${C.r}`);
      row('total paid', num(res.totalPaid, 2));
      row('total interest', `${C.y}${num(res.totalInterest, 2)}${C.r}`);
      return;
    }

    need(args, ['principal', 'rate', 'years']);
    const principal = money(args.principal, 'principal');
    const r = rate(args.rate, 'rate');
    const opts = { principal, rate: r, years: yearsIn, periodsPerYear: m };

    if (args.bullet) {
      const b = bulletSchedule(opts);
      const l = levelPayment(opts);
      head(`interest-only loan  ${num(principal, 2)} at ${pct(r)}, ${yearsIn}y`);
      row('payment', `${C.g}${num(b.payment, 2)}${C.r}`, 'interest only');
      row('balloon at maturity', `${C.y}${num(b.balloon, 2)}${C.r}`, 'the whole principal, still owed');
      row('periods', b.periods);
      console.log();
      row('total interest', num(b.totalInterest, 2));
      row('total paid', num(b.totalPaid, 2));
      console.log();
      console.log(`  ${C.d}the same loan, amortised instead${C.r}`);
      row('  payment', num(l.payment, 2), `${num(l.payment - b.payment, 2)} more per period`);
      row('  total interest', num(l.totalInterest, 2), `${C.g}${num(b.totalInterest - l.totalInterest, 2)} less${C.r}`);
      return;
    }

    const s = amortisationSchedule(opts);
    head(`loan  ${num(principal, 2)} at ${pct(r)}, ${yearsIn}y, ${m}x / year`);
    row('payment', `${C.g}${num(s.payment, 2)}${C.r}`, 'per period');
    row('periods', s.periods);
    row('total paid', num(s.totalPaid, 2));
    row('total interest', `${C.y}${num(s.totalInterest, 2)}${C.r}`, `${share(s.totalInterest, principal)} of what you borrowed`);

    const first = s.rows[0];
    console.log();
    console.log(`  ${C.d}first payment splits${C.r}`);
    row('  interest', num(first.interest, 2), `${share(first.interest, first.payment)} of it`);
    row('  principal', num(first.principal, 2), `${share(first.principal, first.payment)} of it`);

    if (args.schedule) {
      // Validated before the header is printed, so a rejected value does not
      // leave a table heading with nothing under it.
      // `--schedule abc` made this NaN, and `period % NaN` is never 0, so the
      // table silently collapsed to the first and last rows as if the loan had
      // two periods. Refuse the input rather than print a misleading schedule.
      const every = args.schedule === 'true' ? 1 : Math.floor(count(args.schedule, 'schedule'));
      console.log();
      console.log(`  ${C.d}period      payment     interest    principal      balance${C.r}`);
      for (const rw of s.rows) {
        if (rw.period % every !== 0 && rw.period !== 1 && rw.period !== s.periods) continue;
        console.log(
          `  ${String(rw.period).padStart(6)}  ${num(rw.payment, 2).padStart(11)}  ${num(rw.interest, 2).padStart(10)}  ${num(rw.principal, 2).padStart(11)}  ${num(rw.balance, 2).padStart(11)}`
        );
      }
      if (s.finalAdjusted !== 0) {
        console.log(`  ${C.d}final payment adjusted by ${num(s.finalAdjusted, 6)} to close at exactly zero${C.r}`);
      }
    } else {
      console.log(`\n  ${C.d}--schedule for every row, --schedule 12 for every 12th${C.r}`);
    }
  },

  payoff(args) {
    need(args, ['principal', 'rate', 'years', 'extra']);
    const m = count(args.freq, 'freq', 12);
    const principal = money(args.principal, 'principal');
    const r = rate(args.rate, 'rate');
    const extra = money(args.extra, 'extra');

    const p = payoffWithExtra({
      principal,
      rate: r,
      years: count(args.years, 'years'),
      periodsPerYear: m,
      extraPayment: extra,
    });

    head(`overpaying  ${num(principal, 2)} at ${pct(r)}, ${args.years}y`);
    row('scheduled payment', num(p.payment, 2));
    row('paying instead', `${C.g}${num(p.newPayment, 2)}${C.r}`, `${num(extra, 2)} extra per period`);
    console.log();
    row('interest as scheduled', num(p.baseInterest, 2));
    row('interest if overpaid', num(p.newInterest, 2));
    row(
      'you save',
      `${C.g}${num(p.interestSaved, 2)}${C.r}`,
      p.baseInterest === 0
        ? 'there is no interest to save at a zero rate'
        : `${share(p.interestSaved, p.baseInterest)} of the interest`
    );
    console.log();
    row('periods', `${p.basePeriods} -> ${p.newPeriods}`);
    row('paid off earlier by', `${C.g}${num(p.yearsSaved, 2)} years${C.r}`, `${p.periodsSaved} periods`);
    console.log();
    row('extra paid in total', num(extra * p.newPeriods, 2));
    row('net benefit', `${C.g}${num(p.interestSaved, 2)}${C.r}`, 'interest you never owe');
  },

  conventions() {
    head('day-count conventions');
    for (const c of CONVENTIONS) row(c, CONVENTION_NOTES[c] || '');
    console.log(
      `\n  ${C.y}the three 30/360 variants are not interchangeable.${C.r}\n  ${C.d}accrual days --from 2025-02-28 --to 2025-03-31   shows them disagreeing${C.r}`
    );
  },

  help() {
    console.log(`
${C.b}accrual${C.r} ${C.d}— yield math for tokenized real-world assets${C.r}

  ${C.b}days${C.r}         every convention for one date pair, and the spread
    ${C.d}--from --to${C.r}

  ${C.b}accrue${C.r}       interest over a period, simple or compound
    ${C.d}--principal --rate --from --to [--convention] [--compound N|continuous]${C.r}

  ${C.b}bill${C.r}         discount yield vs the yield you actually earn
    ${C.d}--face --price --settle --maturity${C.r}

  ${C.b}bond${C.r}         price, duration, convexity, and a yield shock table
    ${C.d}--face --coupon --yield --years [--freq 2]${C.r}

  ${C.b}pv${C.r}           present value of one future cashflow
    ${C.d}--amount --rate --from --to [--compound N] [--convention]${C.r}

  ${C.b}loan${C.r}         payment, total interest, and the full schedule
    ${C.d}--principal --rate --years [--freq 12] [--schedule N] [--bullet]${C.r}
    ${C.d}--principal --payment --years   solves the rate you are really paying${C.r}
    ${C.d}--payment --rate --years        solves what you can afford to borrow${C.r}

  ${C.b}payoff${C.r}       what overpaying saves you, in money and in years
    ${C.d}--principal --rate --years --extra [--freq 12]${C.r}

  ${C.b}conventions${C.r}  what each convention means and which market uses it

${C.d}rates accept 4.25 or 0.0425. dates are YYYY-MM-DD.
no network, no keys, no signing. it reads nothing and moves nothing.${C.r}

  accrual days   --from 2025-02-28 --to 2025-03-31
  accrual accrue --principal 1000000 --rate 4.25 --from 2025-01-01 --to 2025-04-01
  accrual bill   --face 100 --price 97.80 --settle 2025-01-02 --maturity 2025-07-03
  accrual bond   --face 1000 --coupon 4 --yield 5 --years 10
  accrual loan   --principal 200000 --rate 6 --years 30
  accrual loan   --principal 1000 --payment 150 --years 1
  accrual payoff --principal 200000 --rate 6 --years 30 --extra 200
`);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = commands[cmd];

if (!cmd || cmd === '--help' || cmd === '-h') {
  commands.help();
  process.exit(0);
}
if (!fn) {
  console.error(`${C.y}unknown command ${JSON.stringify(cmd)}${C.r}`);
  commands.help();
  process.exit(2);
}

try {
  fn(parseArgs(rest));
  console.log();
} catch (err) {
  console.error(`${C.y}${err.name}: ${err.message}${C.r}`);
  process.exit(1);
}
