// Amortisation. Loan payments, schedules, payoff and the true rate.
//
// This is the part of the library anyone can use without knowing what a
// day-count convention is. A mortgage, a car loan, a credit line, a tokenized
// debt position: same arithmetic. Pure functions over numbers, no network,
// no keys, no dependencies.
//
// Everything here uses periodic compounding at `periodsPerYear`. That is how
// consumer loans are actually quoted and amortised. If you need day-count
// accrual on an irregular period, use accrueSimple from accrue.mjs instead.

// Guards are named distinctly from the ones in accrue.mjs because the browser
// bundle concatenates these modules into one scope. Two functions called
// `finite` in one file is legal JavaScript and a genuinely bad idea.

// See the note in accrue.mjs: JSON.stringify turns both NaN and Infinity into
// the string "null", which misreports the input the caller actually passed.
function loanDescribe(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return `${v}n`;
  return JSON.stringify(v) ?? String(v);
}

/** Guard for inputs that would silently produce nonsense. */
function loanFinite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${name} must be a finite number, got ${loanDescribe(v)}`);
  }
  return v;
}

function loanPositive(name, v) {
  loanFinite(name, v);
  if (v <= 0) throw new RangeError(`${name} must be > 0, got ${v}`);
  return v;
}

function loanNonNegative(name, v) {
  loanFinite(name, v);
  if (v < 0) throw new RangeError(`${name} must be >= 0, got ${v}`);
  return v;
}

// Every schedule builder below loops once per period and, in the schedule case,
// allocates a row per period. Without a ceiling, `years: 1e9` is a denial of
// service: the process climbs to gigabytes and never returns an answer. This
// matters because the MCP server hands these functions straight to an agent,
// which may pass a number no human would type. 100,000 periods is 8,333 years
// of monthly payments, or 273 years of daily ones, so no real loan comes close.
const MAX_LOAN_PERIODS = 100000;

function loanWholePeriods(n) {
  if (!Number.isInteger(n)) {
    throw new RangeError(
      `years * periodsPerYear must be a whole number of periods, got ${n}`,
    );
  }
  if (n < 1) throw new RangeError(`need at least one period, got ${n}`);
  if (n > MAX_LOAN_PERIODS) {
    throw new RangeError(
      `years * periodsPerYear is ${n} periods, above the ${MAX_LOAN_PERIODS} limit`,
    );
  }
  return n;
}

// A periodic rate of exactly -100% makes the annuity denominator infinite and
// the payment silently zero; below -100% the base of the power goes negative
// and the result oscillates into garbage. Both are nonsense worth refusing.
// Rates between -100% and 0 are left alone: negative-rate lending is real.
function loanPeriodicRate(rate, periodsPerYear) {
  const i = rate / periodsPerYear;
  if (i <= -1) {
    throw new RangeError(
      `rate / periodsPerYear must be > -1, got ${i} (rate ${rate} over ${periodsPerYear} periods)`,
    );
  }
  return i;
}

/**
 * The level payment that retires a loan exactly over n periods.
 *
 * This is the standard annuity formula. A zero rate is handled separately
 * because the general form divides by zero there.
 *
 *   pmt = P * i / (1 - (1 + i)^-n)
 *
 * @param {object} p
 * @param {number} p.principal amount borrowed
 * @param {number} p.rate annual nominal rate as a decimal, 0.0625 for 6.25%
 * @param {number} p.years term in years
 * @param {number} [p.periodsPerYear] 12 for monthly, the consumer default
 * @returns {{payment:number, periods:number, periodicRate:number,
 *            totalPaid:number, totalInterest:number}}
 */
export function levelPayment({ principal, rate, years, periodsPerYear = 12 }) {
  loanPositive('principal', principal);
  loanFinite('rate', rate);
  loanPositive('years', years);
  loanPositive('periodsPerYear', periodsPerYear);

  const n = loanWholePeriods(Math.round(years * periodsPerYear * 1e8) / 1e8);
  const i = loanPeriodicRate(rate, periodsPerYear);

  const payment = i === 0 ? principal / n : (principal * i) / (1 - Math.pow(1 + i, -n));

  const totalPaid = payment * n;
  return {
    payment,
    periods: n,
    periodicRate: i,
    totalPaid,
    totalInterest: totalPaid - principal,
  };
}

/**
 * Full amortisation schedule, one row per period.
 *
 * The final row is adjusted so the closing balance is exactly zero rather
 * than a floating-point crumb. That adjustment is reported as `finalAdjusted`
 * so it is never silent.
 *
 * `extraPayment` is applied to principal every period, which is how overpaying
 * actually works: the payment does not change, the term shortens. The schedule
 * stops early when the balance clears.
 *
 * @param {object} p
 * @param {number} p.principal
 * @param {number} p.rate annual nominal rate as a decimal
 * @param {number} p.years
 * @param {number} [p.periodsPerYear]
 * @param {number} [p.extraPayment] additional principal each period
 * @returns {{payment:number, rows:Array<{period:number, payment:number,
 *            interest:number, principal:number, balance:number}>,
 *            totalPaid:number, totalInterest:number, periods:number,
 *            finalAdjusted:number}}
 */
export function amortisationSchedule({
  principal,
  rate,
  years,
  periodsPerYear = 12,
  extraPayment = 0,
}) {
  loanNonNegative('extraPayment', extraPayment);
  const base = levelPayment({ principal, rate, years, periodsPerYear });
  const i = base.periodicRate;

  const rows = [];
  let balance = principal;
  let totalInterest = 0;
  let totalPaid = 0;
  let finalAdjusted = 0;

  for (let period = 1; period <= base.periods; period++) {
    const interest = balance * i;
    let pay = base.payment + extraPayment;
    let principalPart = pay - interest;

    // Never pay past the balance. Happens on the last row, and earlier when
    // extraPayment is large enough to clear the loan ahead of schedule.
    if (principalPart >= balance) {
      principalPart = balance;
      const exact = interest + principalPart;
      finalAdjusted = exact - pay;
      pay = exact;
    }

    balance -= principalPart;
    totalInterest += interest;
    totalPaid += pay;

    rows.push({ period, payment: pay, interest, principal: principalPart, balance });

    if (balance <= 0) break;
  }

  return {
    payment: base.payment,
    rows,
    totalPaid,
    totalInterest,
    periods: rows.length,
    finalAdjusted,
  };
}

/**
 * What overpaying is worth: interest saved and periods removed.
 *
 * Compares the scheduled loan against the same loan with `extraPayment` added
 * to every payment. This is the single most useful number in consumer finance
 * and almost nobody is shown it.
 *
 * @param {object} p
 * @param {number} p.principal
 * @param {number} p.rate
 * @param {number} p.years
 * @param {number} [p.periodsPerYear]
 * @param {number} p.extraPayment
 * @returns {{interestSaved:number, periodsSaved:number, yearsSaved:number,
 *            baseInterest:number, newInterest:number, basePeriods:number,
 *            newPeriods:number, payment:number, newPayment:number}}
 */
export function payoffWithExtra({
  principal,
  rate,
  years,
  periodsPerYear = 12,
  extraPayment,
}) {
  loanPositive('extraPayment', extraPayment);
  const a = amortisationSchedule({ principal, rate, years, periodsPerYear });
  const b = amortisationSchedule({ principal, rate, years, periodsPerYear, extraPayment });

  return {
    interestSaved: a.totalInterest - b.totalInterest,
    periodsSaved: a.periods - b.periods,
    yearsSaved: (a.periods - b.periods) / periodsPerYear,
    baseInterest: a.totalInterest,
    newInterest: b.totalInterest,
    basePeriods: a.periods,
    newPeriods: b.periods,
    payment: a.payment,
    newPayment: a.payment + extraPayment,
  };
}

/**
 * Interest-only loan with the principal repaid in full at maturity.
 *
 * Bonds work this way, and so do a lot of tokenized credit deals that describe
 * themselves as loans. The periodic cost looks small; the whole principal is
 * still owed on the last day.
 *
 * @param {object} p
 * @param {number} p.principal
 * @param {number} p.rate
 * @param {number} p.years
 * @param {number} [p.periodsPerYear]
 * @returns {{payment:number, balloon:number, periods:number, totalPaid:number,
 *            totalInterest:number, rows:Array<object>}}
 */
export function bulletSchedule({ principal, rate, years, periodsPerYear = 12 }) {
  loanPositive('principal', principal);
  loanFinite('rate', rate);
  loanPositive('years', years);
  loanPositive('periodsPerYear', periodsPerYear);

  const n = loanWholePeriods(Math.round(years * periodsPerYear * 1e8) / 1e8);
  const i = loanPeriodicRate(rate, periodsPerYear);
  const coupon = principal * i;

  const rows = [];
  for (let period = 1; period <= n; period++) {
    const last = period === n;
    rows.push({
      period,
      payment: last ? coupon + principal : coupon,
      interest: coupon,
      principal: last ? principal : 0,
      balance: last ? 0 : principal,
    });
  }

  return {
    payment: coupon,
    balloon: principal,
    periods: n,
    totalPaid: coupon * n + principal,
    totalInterest: coupon * n,
    rows,
  };
}

/**
 * The rate you are actually paying, solved from the payment.
 *
 * Given a principal, a payment and a term, recover the nominal annual rate.
 * Use this to check a quoted rate, or to price a loan that was only ever
 * described to you as "X per month".
 *
 * Solved by bisection. Slower than Newton but it cannot diverge, and a wrong
 * rate here is worse than a few extra iterations.
 *
 * @param {object} p
 * @param {number} p.principal
 * @param {number} p.payment per-period payment
 * @param {number} p.years
 * @param {number} [p.periodsPerYear]
 * @param {number} [p.tolerance]
 * @returns {{rate:number, periodicRate:number, iterations:number,
 *            totalPaid:number, totalInterest:number}}
 */
export function rateFromPayment({
  principal,
  payment,
  years,
  periodsPerYear = 12,
  tolerance = 1e-12,
}) {
  loanPositive('principal', principal);
  loanPositive('payment', payment);
  loanPositive('years', years);
  loanPositive('periodsPerYear', periodsPerYear);

  const n = loanWholePeriods(Math.round(years * periodsPerYear * 1e8) / 1e8);

  // Payments that exactly retire the principal are a 0% loan ("0% financing"),
  // a real and common offer. This used to fall into the refusal below and tell
  // the borrower it "cannot repay", which is false. The tolerance absorbs the
  // float residue of a payment like 25000/60 multiplied back out.
  if (Math.abs(payment * n - principal) <= 1e-9 * principal) {
    return { rate: 0, periodicRate: 0, iterations: 0, totalPaid: principal, totalInterest: 0 };
  }

  // Below this the loan can never be repaid: the payments do not even cover
  // the principal, let alone interest.
  if (payment * n < principal) {
    throw new RangeError(
      `payment ${payment} over ${n} periods totals ${payment * n}, which cannot repay ${principal}`,
    );
  }

  // present value of the annuity minus the principal, decreasing in i
  const f = (i) => (i === 0 ? payment * n - principal : payment * ((1 - Math.pow(1 + i, -n)) / i) - principal);

  let lo = 0;
  let hi = 1; // 100% per period, far past any real loan
  while (f(hi) > 0) {
    hi *= 2;
    if (hi > 1e6) throw new RangeError('no rate found in a sane range');
  }

  let iterations = 0;
  let mid = 0;
  while (hi - lo > tolerance && iterations < 500) {
    mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
    iterations++;
  }

  const i = (lo + hi) / 2;
  return {
    rate: i * periodsPerYear,
    periodicRate: i,
    iterations,
    totalPaid: payment * n,
    totalInterest: payment * n - principal,
  };
}

/**
 * How much you can borrow for a given payment.
 *
 * The inverse of levelPayment, and the question every borrower actually starts
 * with. Answers "what does my budget buy" rather than "what does this cost".
 *
 * @param {object} p
 * @param {number} p.payment affordable per-period payment
 * @param {number} p.rate annual nominal rate as a decimal
 * @param {number} p.years
 * @param {number} [p.periodsPerYear]
 * @returns {{principal:number, periods:number, totalPaid:number,
 *            totalInterest:number}}
 */
export function affordablePrincipal({ payment, rate, years, periodsPerYear = 12 }) {
  loanPositive('payment', payment);
  loanFinite('rate', rate);
  loanPositive('years', years);
  loanPositive('periodsPerYear', periodsPerYear);

  const n = loanWholePeriods(Math.round(years * periodsPerYear * 1e8) / 1e8);
  const i = loanPeriodicRate(rate, periodsPerYear);
  const principal = i === 0 ? payment * n : payment * ((1 - Math.pow(1 + i, -n)) / i);

  return {
    principal,
    periods: n,
    totalPaid: payment * n,
    totalInterest: payment * n - principal,
  };
}
