// Every case here produced NaN or Infinity before it was fixed. None of them
// threw, which was the problem: a number that is not a number travels quietly
// through a CLI table, a JSON response and a web page, and only the reader
// notices. JSON has no NaN, so over the MCP wire each one arrived as `null`,
// which a model reads as "the tool declined to answer" rather than "your input
// has no meaning". These tests exist to keep that from coming back.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accrueCompound,
  effectiveAnnualRate,
  nominalFromEffective,
  presentValue,
  billYields,
  bondMetrics,
  compareConventions,
} from '../src/index.mjs';

/** Fails on NaN and on Infinity, which assert.ok(Number.isFinite(x)) reports uselessly. */
function realNumber(v, label) {
  assert.equal(typeof v, 'number', `${label} is not a number: ${v}`);
  assert.ok(Number.isFinite(v), `${label} is ${v}, which JSON serialises as null`);
}

test('a bill with no redemption amount is refused, not quoted at an infinite yield', () => {
  // discountYield divides the gain by face. At face 0 that was Infinity, and a
  // quoted rate of Infinity looks like a spectacular opportunity.
  assert.throws(
    () => billYields({ face: 0, price: 100, settle: '2025-01-01', maturity: '2025-07-01' }),
    /face must be > 0/,
  );
});

test('a bill priced at zero is refused rather than divided by', () => {
  assert.throws(
    () => billYields({ face: 100, price: 0, settle: '2025-01-01', maturity: '2025-07-01' }),
    /price must be > 0/,
  );
});

test('a bond with no face value is refused, not priced with NaN duration', () => {
  // Price came out 0, and every metric divides by price: Macaulay, modified,
  // convexity and price-per-100 were all NaN while isError stayed false.
  assert.throws(
    () => bondMetrics({ face: 0, couponRate: 0.04, yield: 0.05, years: 10 }),
    /face must be > 0/,
  );
});

test('a bond with a coupon but no face is still refused', () => {
  assert.throws(() => bondMetrics({ face: 0, couponRate: 0, yield: 0.05, years: 10 }), /face must be > 0/);
});

test('bondMetrics with a zero yield still returns real numbers', () => {
  // A zero yield is legal and must not be caught by the new guards.
  const r = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0, years: 10 });
  realNumber(r.price, 'price');
  realNumber(r.macaulay, 'macaulay');
  realNumber(r.convexity, 'convexity');
  assert.equal(r.price, 1400, 'undiscounted cashflows sum to face plus every coupon');
});

test('a compounding frequency of zero is refused instead of ignored', () => {
  // periodsPerYear 0 made rate/0 Infinity, and Math.pow(Infinity, 0) is 1, so
  // the position silently reported no growth at all.
  assert.throws(
    () => accrueCompound({ principal: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 0 }),
    /periodsPerYear must be > 0/,
  );
  assert.throws(() => effectiveAnnualRate(0.05, 0), /periodsPerYear must be > 0/);
  assert.throws(
    () => presentValue({ amount: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 0 }),
    /periodsPerYear must be > 0/,
  );
});

test('a negative compounding frequency is refused', () => {
  // presentValue with periodsPerYear -1 returned a discount factor of 0.95,
  // a plausible-looking number produced by discounting backwards.
  assert.throws(
    () => presentValue({ amount: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01', periodsPerYear: -1 }),
    /periodsPerYear must be > 0/,
  );
  assert.throws(() => effectiveAnnualRate(0.05, -4), /periodsPerYear must be > 0/);
});

test('a rate worse than -100% per period is refused, not returned as NaN', () => {
  // Math.pow with a negative base and a fractional exponent is NaN. Every one
  // of these came back as null over the wire with isError false.
  assert.throws(
    () => accrueCompound({ principal: 1000, rate: -2, from: '2025-01-01', to: '2025-07-01', periodsPerYear: 1 }),
    /must be >= 0/,
  );
  assert.throws(() => effectiveAnnualRate(-2, 1), /must be >= 0/);
  assert.throws(
    () => presentValue({ amount: 1000, rate: -1, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 1 }),
    /infinite/,
  );
  assert.throws(() => nominalFromEffective(-2, 2), /effective must be > -1/);
});

test('a rate of exactly -100% per period wipes the position out rather than erroring', () => {
  // The boundary is meaningful: growth of 0 is the correct answer here.
  const r = accrueCompound({
    principal: 1000,
    rate: -1,
    from: '2025-01-01',
    to: '2026-01-01',
    periodsPerYear: 1,
    convention: 'ACT/365F',
  });
  assert.equal(r.growth, 0);
  assert.equal(r.future, 0);
  assert.equal(r.interest, -1000);
});

test('a mildly negative rate is still allowed, because negative rates happened', () => {
  const r = accrueCompound({
    principal: 1000,
    rate: -0.005,
    from: '2025-01-01',
    to: '2026-01-01',
    periodsPerYear: 12,
  });
  realNumber(r.future, 'future');
  assert.ok(r.future < 1000 && r.future > 990);
  realNumber(effectiveAnnualRate(-0.005, 12), 'effective annual rate');
  realNumber(nominalFromEffective(-0.005, 12), 'nominal from effective');
});

test('NaN and Infinity are reported by name, not as null', () => {
  // JSON.stringify(NaN) is the string "null", so the old message read
  // "must be a finite number, got null" for an input of NaN.
  assert.throws(
    () => accrueCompound({ principal: NaN, rate: 0.05, from: '2025-01-01', to: '2026-01-01' }),
    /got NaN/,
  );
  assert.throws(
    () => bondMetrics({ face: Infinity, couponRate: 0.04, yield: 0.05, years: 10 }),
    /got Infinity/,
  );
});

test('two conventions can both return a year fraction of zero, and that is not an error', () => {
  // 2025-01-30 to 2025-01-31 is one actual day, which the 30/360 family counts
  // as zero. Any caller computing a relative spread divides by that zero.
  const spread = compareConventions('2025-01-30', '2025-01-31');
  const vals = Object.values(spread);
  assert.equal(Math.min(...vals), 0, 'the 30/360 family must collapse this to zero');
  assert.ok(Math.max(...vals) > 0, 'ACT/360 must still count the day');
  for (const [name, v] of Object.entries(spread)) realNumber(v, name);
});

test('identical dates give zero everywhere without producing NaN', () => {
  const spread = compareConventions('2025-03-31', '2025-03-31');
  for (const [name, v] of Object.entries(spread)) {
    realNumber(v, name);
    assert.equal(v, 0);
  }
});
