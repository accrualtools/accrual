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
