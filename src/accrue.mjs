// Accrual, discounting and rate conversion. Pure functions over numbers.
//
// Nothing here touches a network, a wallet or a key. It takes numbers and
// returns numbers. If you want to know what a position is worth, this file
// tells you; it cannot move it.

import { yearFraction, actualDays } from './daycount.mjs';

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
