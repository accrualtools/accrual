import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accrueSimple,
  accrueCompound,
  effectiveAnnualRate,
  nominalFromEffective,
  presentValue,
  billYields,
  bondMetrics,
  priceShock,
} from '../src/accrue.mjs';

const close = (a, b, eps = 1e-8) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (diff ${Math.abs(a - b)})`);

test('simple accrual on a 90-day ACT/360 position', () => {
  const r = accrueSimple({
    principal: 1_000_000,
    rate: 0.0425,
    from: '2025-01-01',
    to: '2025-04-01',
    convention: 'ACT/360',
  });
  assert.equal(r.days, 90);
  close(r.years, 90 / 360);
  close(r.interest, 1_000_000 * 0.0425 * (90 / 360));
  close(r.interest, 10625);
});

test('the same position pays less under ACT/365F', () => {
  const base = { principal: 1_000_000, rate: 0.0425, from: '2025-01-01', to: '2025-04-01' };
  const a360 = accrueSimple({ ...base, convention: 'ACT/360' }).interest;
  const a365 = accrueSimple({ ...base, convention: 'ACT/365F' }).interest;
  assert.ok(a360 > a365, 'ACT/360 must pay more on the same dates');
  close(a360 - a365, 10625 - 1_000_000 * 0.0425 * (90 / 365));
});

test('zero principal accrues nothing, zero rate accrues nothing', () => {
  close(accrueSimple({ principal: 0, rate: 0.05, from: '2025-01-01', to: '2025-12-01' }).interest, 0);
  close(accrueSimple({ principal: 1e6, rate: 0, from: '2025-01-01', to: '2025-12-01' }).interest, 0);
});

test('negative principal is rejected', () => {
  assert.throws(
    () => accrueSimple({ principal: -1, rate: 0.05, from: '2025-01-01', to: '2025-02-01' }),
    RangeError
  );
});

test('a negative rate is allowed, because negative rates happened', () => {
  const r = accrueSimple({
    principal: 1_000_000,
    rate: -0.005,
    from: '2025-01-01',
    to: '2026-01-01',
    convention: 'ACT/365F',
  });
  assert.ok(r.interest < 0, 'negative rate must produce negative accrual');
});

test('compounding more often earns more on the same nominal rate', () => {
  const base = {
    principal: 100_000,
    rate: 0.05,
    from: '2025-01-01',
    to: '2026-01-01',
    convention: 'ACT/365F',
  };
  const annual = accrueCompound({ ...base, periodsPerYear: 1 }).future;
  const monthly = accrueCompound({ ...base, periodsPerYear: 12 }).future;
  const continuous = accrueCompound({ ...base, periodsPerYear: Infinity }).future;
  assert.ok(annual < monthly, 'monthly must beat annual');
  assert.ok(monthly < continuous, 'continuous must beat monthly');
  close(annual, 105_000, 1e-6);
  close(continuous, 100_000 * Math.exp(0.05), 1e-6);
});

test('effective annual rate matches the textbook 5% cases', () => {
  close(effectiveAnnualRate(0.05, 1), 0.05);
  close(effectiveAnnualRate(0.05, 2), Math.pow(1.025, 2) - 1);
  close(effectiveAnnualRate(0.05, 12), 0.05116189788173, 1e-12);
  close(effectiveAnnualRate(0.05, Infinity), Math.exp(0.05) - 1);
});

test('nominal and effective conversions round-trip', () => {
  for (const m of [1, 2, 4, 12, 365, Infinity]) {
    const eff = effectiveAnnualRate(0.0673, m);
    close(nominalFromEffective(eff, m), 0.0673, 1e-12);
  }
});

test('present value undoes compound accrual exactly', () => {
  const grown = accrueCompound({
    principal: 50_000,
    rate: 0.04,
    from: '2025-01-01',
    to: '2028-01-01',
    periodsPerYear: 4,
    convention: 'ACT/365F',
  });
  const back = presentValue({
    amount: grown.future,
    rate: 0.04,
    from: '2025-01-01',
    to: '2028-01-01',
    periodsPerYear: 4,
    convention: 'ACT/365F',
  });
  close(back.pv, 50_000, 1e-6);
});

test('discount factor is 1 at time zero and below 1 after', () => {
  close(presentValue({ amount: 100, rate: 0.05, from: '2025-01-01', to: '2025-01-01' }).discountFactor, 1);
  const later = presentValue({ amount: 100, rate: 0.05, from: '2025-01-01', to: '2030-01-01' });
  assert.ok(later.discountFactor < 1);
});

test('bill investment yield exceeds discount yield, always', () => {
  // 182-day bill, face 100, price 97.80.
  const r = billYields({ face: 100, price: 97.8, settle: '2025-01-02', maturity: '2025-07-03' });
  assert.equal(r.days, 182);
  close(r.gain, 2.2, 1e-12);
  close(r.discountYield, (2.2 / 100) * (360 / 182), 1e-12);
  close(r.investmentYield, (2.2 / 97.8) * (365 / 182), 1e-12);
  assert.ok(
    r.investmentYield > r.discountYield,
    'coupon-equivalent yield must exceed the quoted discount'
  );
});

test('a bill quoted at par yields nothing', () => {
  const r = billYields({ face: 100, price: 100, settle: '2025-01-01', maturity: '2025-07-01' });
  close(r.discountYield, 0);
  close(r.investmentYield, 0);
});

test('maturity before settle is rejected', () => {
  assert.throws(
    () => billYields({ face: 100, price: 98, settle: '2025-07-01', maturity: '2025-01-01' }),
    RangeError
  );
});

test('a bond priced at par has coupon equal to yield', () => {
  const r = bondMetrics({ face: 1000, couponRate: 0.05, yield: 0.05, years: 10, periodsPerYear: 2 });
  close(r.price, 1000, 1e-8);
});

test('a discount bond prices below par and a premium bond above', () => {
  const discount = bondMetrics({ face: 1000, couponRate: 0.03, yield: 0.05, years: 10 });
  const premium = bondMetrics({ face: 1000, couponRate: 0.07, yield: 0.05, years: 10 });
  assert.ok(discount.price < 1000, 'coupon below yield must price below par');
  assert.ok(premium.price > 1000, 'coupon above yield must price above par');
});

test('a zero-coupon bond has Macaulay duration equal to its maturity', () => {
  const r = bondMetrics({ face: 1000, couponRate: 0, yield: 0.05, years: 10, periodsPerYear: 1 });
  close(r.macaulay, 10, 1e-9);
  close(r.price, 1000 * Math.pow(1.05, -10), 1e-9);
});

test('duration is shorter than maturity once there are coupons', () => {
  const r = bondMetrics({ face: 1000, couponRate: 0.05, yield: 0.05, years: 10 });
  assert.ok(r.macaulay < 10, 'coupons pull duration in');
  assert.ok(r.macaulay > 7, `expected roughly 7.8 years, got ${r.macaulay}`);
  assert.ok(r.modified < r.macaulay, 'modified duration is Macaulay discounted once');
});

test('longer maturity means more rate sensitivity', () => {
  const short = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0.04, years: 2 });
  const long = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0.04, years: 30 });
  assert.ok(long.modified > short.modified, '30y must be more sensitive than 2y');
  assert.ok(long.convexity > short.convexity, '30y must be more convex than 2y');
});

test('cashflow schedule has the right shape and the last one repays face', () => {
  const r = bondMetrics({ face: 1000, couponRate: 0.06, yield: 0.05, years: 3, periodsPerYear: 2 });
  assert.equal(r.cashflows.length, 6);
  close(r.cashflows[0].cashflow, 30);
  close(r.cashflows[5].cashflow, 1030);
  const summed = r.cashflows.reduce((s, c) => s + c.pv, 0);
  close(summed, r.price, 1e-9);
});

test('duration estimate beats nothing but convexity beats duration', () => {
  const b = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0.04, years: 20 });
  const bump = 0.01;
  const actual = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0.04 + bump, years: 20 }).price;
  const est = priceShock(b.price, b.modified, b.convexity, bump);

  const errDuration = Math.abs(est.durationOnly - actual);
  const errConvexity = Math.abs(est.withConvexity - actual);
  assert.ok(
    errConvexity < errDuration,
    `convexity should reduce error: ${errConvexity} vs ${errDuration}`
  );
  assert.ok(est.durationOnly < b.price, 'a yield rise must lower the price estimate');
});

test('a rate cut raises the price', () => {
  const b = bondMetrics({ face: 1000, couponRate: 0.04, yield: 0.04, years: 20 });
  const est = priceShock(b.price, b.modified, b.convexity, -0.01);
  assert.ok(est.withConvexity > b.price);
});

test('bondMetrics refuses an absurd number of coupon periods', () => {
  // this loop pushes a cashflow row per period, so it is a hang, not a wrong answer
  assert.throws(
    () => bondMetrics({ face: 100, couponRate: 0.04, yield: 0.05, years: 1e9 }),
    /above the 100000 limit/,
  );
});

test('bondMetrics refuses a periodic yield of -100%', () => {
  // the discount factor divides by zero here and every metric becomes Infinity
  assert.throws(
    () => bondMetrics({ face: 100, couponRate: 0.04, yield: -2, years: 10, periodsPerYear: 2 }),
    /must be > -1/,
  );
});
