// accrual.mjs — served verbatim from src/. accrual is MIT licensed.
// No network calls, no key material, no signing. Read it before you run it.

// Day-count conventions. This is the part every RWA deck skips and every
// settlement desk argues about.
//
// A day-count convention answers one question: given two dates, what fraction
// of a year passed? Different markets answer it differently, and the answer
// changes the money. Same principal, same rate, same dates, four conventions,
// four different numbers.
//
// References are the ISDA 2006 Definitions section 4.16 and ICMA Rule 251.
// Implemented here directly, no dependencies.

/**
 * Supported conventions, keyed by the name desks actually use.
 *
 * Note the three 30/360 variants. They are not interchangeable and mixing
 * them up is a real settlement break, not a rounding difference. For
 * 2025-02-28 to 2025-03-31 they return 30, 33 and 32 days respectively.
 */
export const CONVENTIONS = Object.freeze([
  'ACT/360',
  'ACT/365F',
  'ACT/ACT',
  '30U/360',
  '30/360',
  '30E/360',
]);

/** Human-readable name and the market each convention belongs to. */
export const CONVENTION_NOTES = Object.freeze({
  'ACT/360': 'Money market. Actual days over a 360-day year, so a year exceeds 1.0.',
  'ACT/365F': 'Fixed 365 denominator. Sterling and many loan agreements.',
  'ACT/ACT': 'ISDA. Splits at year boundaries, so a full calendar year is exactly 1.0.',
  '30U/360': 'US / NASD. Has a last-day-of-February rule the others lack.',
  '30/360': 'ISDA Bond Basis. Clamps the 31st only. The most common default.',
  '30E/360': 'European / Eurobond, ICMA. Clamps both 31sts, ignores February.',
});

const MS_PER_DAY = 86400000;

/**
 * Parse a date input into a UTC-midnight Date.
 * Accepts a Date or an ISO YYYY-MM-DD string. Rejects anything ambiguous,
 * because a silently wrong date is worse than a thrown error.
 * @param {Date|string} d
 * @returns {Date}
 */
export function toUTCDate(d) {
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) throw new TypeError('invalid Date');
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new TypeError(`expected a Date or YYYY-MM-DD string, got ${JSON.stringify(d)}`);
  }
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  // Catches 2025-02-30 and friends, which Date would silently roll forward.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) {
    throw new RangeError(`${d} is not a real date`);
  }
  return dt;
}

/** Actual calendar days between two dates. Signed. */
export function actualDays(from, to) {
  return Math.round((toUTCDate(to) - toUTCDate(from)) / MS_PER_DAY);
}

/** True for a Gregorian leap year. */
export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 366 in a leap year, else 365. */
export function daysInYear(y) {
  return isLeapYear(y) ? 366 : 365;
}

/**
 * The 30/360 family. All three pretend every month has 30 days. They differ
 * only in how they handle the 31st and the end of February, and that is
 * enough to change the money.
 *
 * @param {'us'|'isda'|'eu'} variant
 */
function thirty360Days(d1, d2, variant) {
  let dd1 = d1.getUTCDate();
  let dd2 = d2.getUTCDate();
  const m1 = d1.getUTCMonth() + 1;
  const m2 = d2.getUTCMonth() + 1;
  const y1 = d1.getUTCFullYear();
  const y2 = d2.getUTCFullYear();

  if (variant === 'eu') {
    // ICMA Rule 251. Clamp both ends, no February special case.
    if (dd1 === 31) dd1 = 30;
    if (dd2 === 31) dd2 = 30;
  } else if (variant === 'us') {
    // NASD. The February rule is what separates this from Bond Basis.
    const lastFeb1 = m1 === 2 && dd1 === (isLeapYear(y1) ? 29 : 28);
    const lastFeb2 = m2 === 2 && dd2 === (isLeapYear(y2) ? 29 : 28);
    if (lastFeb1 && lastFeb2) dd2 = 30;
    if (lastFeb1) dd1 = 30;
    if (dd2 === 31 && dd1 >= 30) dd2 = 30;
    if (dd1 === 31) dd1 = 30;
  } else {
    // ISDA 2006 Bond Basis. Clamp D1's 31st, then D2's only if D1 became 30.
    if (dd1 === 31) dd1 = 30;
    if (dd2 === 31 && dd1 === 30) dd2 = 30;
  }
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (dd2 - dd1);
}

/**
 * ACT/ACT (ISDA). Splits the period at each year boundary and divides each
 * piece by the length of the year it falls in. This is why a period spanning
 * a leap year is not a clean fraction.
 */
function actActISDA(d1, d2) {
  const y1 = d1.getUTCFullYear();
  const y2 = d2.getUTCFullYear();
  if (y1 === y2) return actualDays(d1, d2) / daysInYear(y1);

  let total = 0;
  // Head: d1 to the start of the next year.
  total += actualDays(d1, new Date(Date.UTC(y1 + 1, 0, 1))) / daysInYear(y1);
  // Whole years in between, each counting as exactly 1.
  total += y2 - y1 - 1;
  // Tail: start of d2's year to d2.
  total += actualDays(new Date(Date.UTC(y2, 0, 1)), d2) / daysInYear(y2);
  return total;
}

/**
 * Year fraction between two dates under a given convention.
 * @param {Date|string} from
 * @param {Date|string} to
 * @param {'ACT/360'|'ACT/365F'|'ACT/ACT'|'30U/360'|'30/360'|'30E/360'} convention
 * @returns {number} years, may be fractional, negative if to < from
 */
export function yearFraction(from, to, convention = 'ACT/365F') {
  const d1 = toUTCDate(from);
  const d2 = toUTCDate(to);

  switch (convention) {
    case 'ACT/360':
      return actualDays(d1, d2) / 360;
    case 'ACT/365F':
      return actualDays(d1, d2) / 365;
    case 'ACT/ACT':
      return actActISDA(d1, d2);
    case '30U/360':
      return thirty360Days(d1, d2, 'us') / 360;
    case '30/360':
      return thirty360Days(d1, d2, 'isda') / 360;
    case '30E/360':
      return thirty360Days(d1, d2, 'eu') / 360;
    default:
      throw new RangeError(
        `unknown convention ${JSON.stringify(convention)}. known: ${CONVENTIONS.join(', ')}`
      );
  }
}

/**
 * Every convention at once, so you can see the spread instead of trusting one.
 * @returns {Record<string, number>}
 */
export function compareConventions(from, to) {
  const out = {};
  for (const c of CONVENTIONS) out[c] = yearFraction(from, to, c);
  return out;
}


// Accrual, discounting and rate conversion. Pure functions over numbers.
//
// Nothing here touches a network, a wallet or a key. It takes numbers and
// returns numbers. If you want to know what a position is worth, this file
// tells you; it cannot move it.

// (imported functions are defined above in this bundle)
// JSON.stringify(NaN) is the string "null", and JSON.stringify(Infinity) is too,
// so reporting a bad input through it told the caller "got null" when they had
// actually passed NaN. Name the value it really was.
function describe(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return `${v}n`;
  return JSON.stringify(v) ?? String(v);
}

/** Guard for inputs that would silently produce nonsense. */
function finite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${name} must be a finite number, got ${describe(v)}`);
  }
  return v;
}

function nonNegative(name, v) {
  finite(name, v);
  if (v < 0) throw new RangeError(`${name} must be >= 0, got ${v}`);
  return v;
}

function positive(name, v) {
  finite(name, v);
  if (v <= 0) throw new RangeError(`${name} must be > 0, got ${v}`);
  return v;
}

// A growth factor of (1 + rate/m) raised to a fractional power is only real
// when the base is non-negative. At exactly -1 the position is wiped out; below
// it Math.pow returns NaN, which JSON turns into null and a reader mistakes for
// "no answer" rather than "that input has no meaning". Refuse it instead.
function compoundingBase(rate, periodsPerYear, label = 'rate') {
  const base = 1 + rate / periodsPerYear;
  if (base < 0) {
    throw new RangeError(
      `1 + ${label} / periodsPerYear must be >= 0, got ${base} (${label} ${rate} over ${periodsPerYear} periods)`,
    );
  }
  return base;
}

// Ceiling on any loop that runs once per period. See the note in bondMetrics.
// Named distinctly from the amortise.mjs ceiling because the browser bundle
// concatenates both modules into one scope, where two `const MAX_PERIODS`
// declarations are a SyntaxError that node --check on the source cannot see.
const MAX_COUPON_PERIODS = 100000;

/**
 * Simple interest accrued over a period. This is the convention for T-bills,
 * repo, commercial paper and most tokenized cash products.
 *
 * @param {object} p
 * @param {number} p.principal face or notional
 * @param {number} p.rate annual rate as a decimal, 0.0425 for 4.25%
 * @param {Date|string} p.from
 * @param {Date|string} p.to
 * @param {string} [p.convention]
 * @returns {{interest:number, years:number, days:number, convention:string}}
 */
export function accrueSimple({ principal, rate, from, to, convention = 'ACT/360' }) {
  nonNegative('principal', principal);
  finite('rate', rate);
  const years = yearFraction(from, to, convention);
  return {
    interest: principal * rate * years,
    years,
    days: actualDays(from, to),
    convention,
  };
}

/**
 * Compound interest accrued over a period.
 * @param {object} p
 * @param {number} p.principal
 * @param {number} p.rate annual nominal rate as a decimal
 * @param {Date|string} p.from
 * @param {Date|string} p.to
 * @param {number} [p.periodsPerYear] compounding frequency, Infinity for continuous
 * @param {string} [p.convention]
 */
export function accrueCompound({
  principal,
  rate,
  from,
  to,
  periodsPerYear = 1,
  convention = 'ACT/365F',
}) {
  nonNegative('principal', principal);
  finite('rate', rate);
  const years = yearFraction(from, to, convention);

  let growth;
  if (periodsPerYear === Infinity) {
    growth = Math.exp(rate * years);
  } else {
    positive('periodsPerYear', periodsPerYear);
    growth = Math.pow(compoundingBase(rate, periodsPerYear), periodsPerYear * years);
  }

  const future = principal * growth;
  return {
    interest: future - principal,
    future,
    growth,
    years,
    days: actualDays(from, to),
    periodsPerYear,
    convention,
  };
}

/**
 * Convert a nominal rate compounded m times a year into an effective annual
 * rate. This is the number that lets you compare two products honestly, and
 * it is almost never the number in the marketing.
 * @param {number} nominal annual nominal rate as a decimal
 * @param {number} periodsPerYear Infinity for continuous
 */
export function effectiveAnnualRate(nominal, periodsPerYear = 1) {
  finite('nominal', nominal);
  if (periodsPerYear === Infinity) return Math.exp(nominal) - 1;
  positive('periodsPerYear', periodsPerYear);
  return Math.pow(compoundingBase(nominal, periodsPerYear, 'nominal'), periodsPerYear) - 1;
}

/** The inverse: what nominal rate at frequency m gives this effective rate. */
export function nominalFromEffective(effective, periodsPerYear = 1) {
  finite('effective', effective);
  // An effective rate of -100% or worse means the whole position is gone; there
  // is no nominal rate that produces it, and log/pow of a negative base is NaN.
  if (effective <= -1) {
    throw new RangeError(`effective must be > -1, got ${effective}`);
  }
  if (periodsPerYear === Infinity) return Math.log(1 + effective);
  positive('periodsPerYear', periodsPerYear);
  return periodsPerYear * (Math.pow(1 + effective, 1 / periodsPerYear) - 1);
}

/**
 * Present value of a single future cashflow.
 * @param {object} p
 * @param {number} p.amount the cashflow
 * @param {number} p.rate annual discount rate as a decimal
 * @param {Date|string} p.from valuation date
 * @param {Date|string} p.to cashflow date
 * @param {number} [p.periodsPerYear]
 * @param {string} [p.convention]
 */
export function presentValue({
  amount,
  rate,
  from,
  to,
  periodsPerYear = 1,
  convention = 'ACT/365F',
}) {
  finite('amount', amount);
  finite('rate', rate);
  const years = yearFraction(from, to, convention);
  let discount;
  if (periodsPerYear === Infinity) {
    discount = Math.exp(-rate * years);
  } else {
    positive('periodsPerYear', periodsPerYear);
    // A base of exactly 0 raised to a negative power is Infinity, so a discount
    // rate of -100% would report an infinite present value rather than refusing.
    const base = compoundingBase(rate, periodsPerYear);
    if (base === 0 && years !== 0) {
      throw new RangeError(
        `1 + rate / periodsPerYear is 0, so the discount factor is infinite (rate ${rate})`,
      );
    }
    discount = Math.pow(base, -periodsPerYear * years);
  }
  return { pv: amount * discount, discountFactor: discount, years, convention };
}

/**
 * Discount yield for an instrument sold below face and redeemed at par.
 * This is how T-bills are actually quoted, and it is not the same number as
 * the yield you earn. Both are returned so you can see the gap.
 *
 * @param {object} p
 * @param {number} p.face redemption amount
 * @param {number} p.price what you pay
 * @param {Date|string} p.settle
 * @param {Date|string} p.maturity
 * @returns {{discountYield:number, investmentYield:number, days:number, gain:number}}
 */
export function billYields({ face, price, settle, maturity }) {
  // Face of exactly 0 divides by zero in the discount yield below. An
  // instrument that redeems for nothing has no yield to quote, so refuse it
  // rather than returning Infinity as if it were a rate.
  positive('face', face);
  positive('price', price);
  const days = actualDays(settle, maturity);
  if (days <= 0) throw new RangeError('maturity must be after settle');

  const gain = face - price;
  return {
    // Bank discount basis: gain over FACE, 360-day year.
    discountYield: (gain / face) * (360 / days),
    // Coupon-equivalent: gain over PRICE, 365-day year. The one you earn.
    investmentYield: (gain / price) * (365 / days),
    days,
    gain,
  };
}

/**
 * Macaulay and modified duration for a level-coupon bond, plus price.
 * Duration is the sensitivity nobody quotes when they tokenize a bond fund.
 *
 * @param {object} p
 * @param {number} p.face
 * @param {number} p.couponRate annual, decimal
 * @param {number} p.yield annual yield to maturity, decimal
 * @param {number} p.years whole years to maturity
 * @param {number} [p.periodsPerYear]
 * @returns {{price:number, macaulay:number, modified:number, convexity:number, cashflows:Array}}
 */
export function bondMetrics({ face, couponRate, yield: y, years, periodsPerYear = 2 }) {
  // Face of 0 with a coupon of 0 prices at 0, and every metric below divides by
  // that price: duration, convexity and price-per-100 all come back NaN. A bond
  // with no redemption amount is not a bond, so refuse it at the door.
  positive('face', face);
  finite('couponRate', couponRate);
  finite('yield', y);
  nonNegative('years', years);
  positive('periodsPerYear', periodsPerYear);

  const n = Math.round(years * periodsPerYear);
  if (n < 1) throw new RangeError('need at least one coupon period');
  // This loop pushes a cashflow row per period, so an absurd `years` is a
  // denial of service rather than a wrong answer. 100,000 semiannual periods
  // is 50,000 years; no instrument comes close.
  if (n > MAX_COUPON_PERIODS) {
    throw new RangeError(
      `years * periodsPerYear is ${n} coupon periods, above the ${MAX_COUPON_PERIODS} limit`,
    );
  }
  const c = (face * couponRate) / periodsPerYear;
  const r = y / periodsPerYear;
  // At a periodic yield of -100% the discount factor divides by zero and every
  // metric below becomes Infinity or NaN. Refuse instead of returning garbage.
  if (r <= -1) {
    throw new RangeError(`yield / periodsPerYear must be > -1, got ${r}`);
  }

  let price = 0;
  let weighted = 0;
  let convexNum = 0;
  const cashflows = [];

  for (let k = 1; k <= n; k++) {
    const cf = k === n ? c + face : c;
    const t = k / periodsPerYear;
    const df = Math.pow(1 + r, -k);
    const pv = cf * df;
    price += pv;
    weighted += t * pv;
    convexNum += t * (t + 1 / periodsPerYear) * pv;
    cashflows.push({ period: k, years: t, cashflow: cf, pv });
  }

  const macaulay = weighted / price;
  return {
    price,
    macaulay,
    modified: macaulay / (1 + r),
    convexity: convexNum / (price * Math.pow(1 + r, 2)),
    cashflows,
  };
}

/**
 * Estimate the price change for a yield move, using duration and convexity.
 * @param {number} price
 * @param {number} modified modified duration
 * @param {number} convexity
 * @param {number} deltaYield in decimal, 0.01 for +100bp
 */
export function priceShock(price, modified, convexity, deltaYield) {
  finite('price', price);
  finite('deltaYield', deltaYield);
  const linear = -modified * deltaYield;
  const curve = 0.5 * convexity * deltaYield * deltaYield;
  return {
    durationOnly: price * (1 + linear),
    withConvexity: price * (1 + linear + curve),
    pctLinear: linear,
    pctConvexity: curve,
  };
}


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
