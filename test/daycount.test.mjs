import test from 'node:test';
import assert from 'node:assert/strict';
import {
  yearFraction,
  actualDays,
  isLeapYear,
  daysInYear,
  compareConventions,
  toUTCDate,
  CONVENTIONS,
} from '../src/daycount.mjs';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (diff ${Math.abs(a - b)})`);

test('leap years follow the Gregorian rule', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2025), false);
  assert.equal(isLeapYear(1900), false, '1900 is divisible by 100, not 400');
  assert.equal(isLeapYear(2000), true, '2000 is divisible by 400');
  assert.equal(daysInYear(2024), 366);
  assert.equal(daysInYear(2025), 365);
});

test('actual days counts calendar days and includes leap day', () => {
  assert.equal(actualDays('2025-01-01', '2025-01-31'), 30);
  assert.equal(actualDays('2024-02-01', '2024-03-01'), 29, 'Feb 2024 has 29 days');
  assert.equal(actualDays('2025-02-01', '2025-03-01'), 28);
  assert.equal(actualDays('2025-01-01', '2026-01-01'), 365);
  assert.equal(actualDays('2024-01-01', '2025-01-01'), 366);
});

test('actual days is signed', () => {
  assert.equal(actualDays('2025-06-01', '2025-05-01'), -31);
});

test('ACT/360 divides actual days by 360, so a year is more than 1.0', () => {
  close(yearFraction('2025-01-01', '2026-01-01', 'ACT/360'), 365 / 360);
});

test('ACT/365F divides by a fixed 365 even in a leap year', () => {
  close(yearFraction('2025-01-01', '2026-01-01', 'ACT/365F'), 1);
  close(yearFraction('2024-01-01', '2025-01-01', 'ACT/365F'), 366 / 365);
});

test('ACT/ACT gives exactly 1.0 for a whole calendar year, leap or not', () => {
  close(yearFraction('2025-01-01', '2026-01-01', 'ACT/ACT'), 1);
  close(yearFraction('2024-01-01', '2025-01-01', 'ACT/ACT'), 1);
});

test('ACT/ACT splits a period that straddles a year boundary', () => {
  // 2024-12-01 to 2025-02-01. 31 days in 2024 (366-day year), 31 in 2025.
  const expected = 31 / 366 + 31 / 365;
  close(yearFraction('2024-12-01', '2025-02-01', 'ACT/ACT'), expected);
});

test('the 30/360 family makes every month exactly 30 days', () => {
  for (const c of ['30U/360', '30/360', '30E/360']) {
    close(yearFraction('2025-01-01', '2025-02-01', c), 30 / 360, 1e-9);
    close(yearFraction('2025-01-01', '2026-01-01', c), 1, 1e-9);
  }
});

test('the three 30/360 variants disagree on Feb 28 to Mar 31', () => {
  // Hand-traced. This single date pair is the cleanest way to tell them apart.
  // 30U/360: NASD's last-day-of-February rule pulls D1 to the 30th -> 30 days.
  close(yearFraction('2025-02-28', '2025-03-31', '30U/360'), 30 / 360);
  // 30/360 Bond Basis: no February rule, D1 stays 28, D2's 31 is not clamped
  // because D1 did not become 30 -> 33 days.
  close(yearFraction('2025-02-28', '2025-03-31', '30/360'), 33 / 360);
  // 30E/360: clamps D2's 31 unconditionally -> 32 days.
  close(yearFraction('2025-02-28', '2025-03-31', '30E/360'), 32 / 360);
});

test('30U/360 alone treats end-of-February as the 30th at both ends', () => {
  // 2024-02-29 to 2025-02-28, both last-of-Feb.
  close(yearFraction('2024-02-29', '2025-02-28', '30U/360'), 1, 1e-9);
  // Bond Basis and European see a 359-day period, not a clean year.
  close(yearFraction('2024-02-29', '2025-02-28', '30/360'), 359 / 360);
  close(yearFraction('2024-02-29', '2025-02-28', '30E/360'), 359 / 360);
});

test('all three 30/360 variants agree when no 31st or February end is involved', () => {
  const a = yearFraction('2025-03-31', '2025-09-30', '30U/360');
  const b = yearFraction('2025-03-31', '2025-09-30', '30/360');
  const c = yearFraction('2025-03-31', '2025-09-30', '30E/360');
  close(a, 180 / 360);
  close(b, 180 / 360);
  close(c, 180 / 360);
});

test('the conventions genuinely disagree, which is the whole point', () => {
  const spread = compareConventions('2025-01-15', '2025-07-15');
  const values = Object.values(spread);
  const min = Math.min(...values);
  const max = Math.max(...values);
  assert.ok(max - min > 0.005, `expected a visible spread, got ${min}..${max}`);
  assert.equal(Object.keys(spread).length, CONVENTIONS.length);
});

test('a one-day period is never zero', () => {
  for (const c of CONVENTIONS) {
    assert.ok(yearFraction('2025-03-10', '2025-03-11', c) > 0, `${c} returned zero`);
  }
});

test('identical dates give zero under every convention', () => {
  for (const c of CONVENTIONS) {
    assert.equal(yearFraction('2025-03-10', '2025-03-10', c), 0, `${c} was not zero`);
  }
});

test('bad input throws instead of guessing', () => {
  assert.throws(() => toUTCDate('2025-02-30'), RangeError, 'Feb 30 must be rejected');
  assert.throws(() => toUTCDate('15/01/2025'), TypeError, 'ambiguous format must be rejected');
  assert.throws(() => toUTCDate('2025-1-1'), TypeError, 'unpadded must be rejected');
  assert.throws(() => toUTCDate(1737000000000), TypeError, 'raw epoch must be rejected');
  assert.throws(() => yearFraction('2025-01-01', '2025-02-01', 'ACT/366'), RangeError);
});

test('a Date object is accepted and normalised to UTC midnight', () => {
  const d = toUTCDate(new Date('2025-06-15T23:45:00Z'));
  assert.equal(d.toISOString(), '2025-06-15T00:00:00.000Z');
});
