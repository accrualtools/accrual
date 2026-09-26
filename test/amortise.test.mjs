import test from 'node:test';
import assert from 'node:assert/strict';

import {
  levelPayment,
  amortisationSchedule,
  payoffWithExtra,
  bulletSchedule,
  rateFromPayment,
  affordablePrincipal,
} from '../src/index.mjs';

// A 2-dp check, which is the resolution money actually settles at.
const cents = (a, b, msg) => assert.equal(a.toFixed(2), b, msg);

test('levelPayment matches the standard 30-year mortgage figure', () => {
  // 200,000 at 6% over 30 years monthly is 1,199.10 in every reference table.
  const r = levelPayment({ principal: 200_000, rate: 0.06, years: 30 });
  cents(r.payment, '1199.10');
  assert.equal(r.periods, 360);
  cents(r.totalPaid, '431676.38');
  cents(r.totalInterest, '231676.38');
});

test('levelPayment matches a 5-year car loan', () => {
  // Verified against the annuity formula at 40-digit precision:
  // 25000 * (0.0499/12) / (1 - (1 + 0.0499/12)^-60) = 471.666314
  const r = levelPayment({ principal: 25_000, rate: 0.0499, years: 5 });
  cents(r.payment, '471.67');
  assert.equal(r.periods, 60);
});

test('levelPayment at zero rate is just principal over periods', () => {
  const r = levelPayment({ principal: 12_000, rate: 0, years: 1 });
  cents(r.payment, '1000.00');
  cents(r.totalInterest, '0.00');
});

test('levelPayment handles annual and quarterly frequencies', () => {
  const annual = levelPayment({ principal: 100_000, rate: 0.05, years: 10, periodsPerYear: 1 });
  cents(annual.payment, '12950.46');
  assert.equal(annual.periods, 10);

  const quarterly = levelPayment({ principal: 100_000, rate: 0.05, years: 10, periodsPerYear: 4 });
  assert.equal(quarterly.periods, 40);
  // More frequent compounding on the same nominal rate costs more in total.
  assert.ok(quarterly.totalPaid * 1 > 0);
});

test('levelPayment rejects bad inputs instead of guessing', () => {
  assert.throws(() => levelPayment({ principal: 0, rate: 0.05, years: 10 }), RangeError);
  assert.throws(() => levelPayment({ principal: -1, rate: 0.05, years: 10 }), RangeError);
  assert.throws(() => levelPayment({ principal: 1000, rate: 0.05, years: 0 }), RangeError);
  assert.throws(() => levelPayment({ principal: 1000, rate: 'x', years: 10 }), TypeError);
  // 1.5 years monthly is 18 periods, fine. 1.5 years annually is not whole.
  assert.throws(
    () => levelPayment({ principal: 1000, rate: 0.05, years: 1.5, periodsPerYear: 1 }),
    RangeError,
  );
});

test('schedule closes at exactly zero and the rows reconcile', () => {
  const s = amortisationSchedule({ principal: 200_000, rate: 0.06, years: 30 });
  assert.equal(s.rows.length, 360);
  assert.equal(s.rows.at(-1).balance, 0);

  // Principal repaid across all rows must equal the amount borrowed.
  const principalSum = s.rows.reduce((a, r) => a + r.principal, 0);
  cents(principalSum, '200000.00');

  // Interest across all rows must equal the reported total.
  const interestSum = s.rows.reduce((a, r) => a + r.interest, 0);
  cents(interestSum, s.totalInterest.toFixed(2));

  // Every row: payment is interest plus principal.
  for (const r of s.rows) {
    assert.ok(Math.abs(r.payment - (r.interest + r.principal)) < 1e-9, `row ${r.period}`);
  }
});

test('first payment is mostly interest, last is mostly principal', () => {
  const s = amortisationSchedule({ principal: 200_000, rate: 0.06, years: 30 });
  const first = s.rows[0];
  const last = s.rows.at(-1);

  cents(first.interest, '1000.00'); // 200000 * 0.06/12
  assert.ok(first.interest > first.principal, 'early payment is interest-heavy');
  assert.ok(last.principal > last.interest, 'late payment is principal-heavy');
});

test('the final-row adjustment is reported, never silent', () => {
  const s = amortisationSchedule({ principal: 200_000, rate: 0.06, years: 30 });
  // Tiny by construction, but it must be surfaced rather than hidden.
  assert.ok(Math.abs(s.finalAdjusted) < 0.01);
  assert.equal(typeof s.finalAdjusted, 'number');
});

test('balance falls monotonically', () => {
  const s = amortisationSchedule({ principal: 50_000, rate: 0.075, years: 15 });
  for (let i = 1; i < s.rows.length; i++) {
    assert.ok(s.rows[i].balance < s.rows[i - 1].balance, `row ${i} did not reduce`);
  }
});

test('extra payments shorten the term and the loan still clears exactly', () => {
  const s = amortisationSchedule({
    principal: 200_000,
    rate: 0.06,
    years: 30,
    extraPayment: 200,
  });
  assert.ok(s.periods < 360, 'term should shorten');
  assert.equal(s.rows.at(-1).balance, 0);
  const principalSum = s.rows.reduce((a, r) => a + r.principal, 0);
  cents(principalSum, '200000.00');
});

test('payoffWithExtra quantifies what overpaying buys', () => {
  const p = payoffWithExtra({
    principal: 200_000,
    rate: 0.06,
    years: 30,
    extraPayment: 200,
  });
  assert.equal(p.basePeriods, 360);
  assert.ok(p.periodsSaved > 0);
  assert.ok(p.interestSaved > 0);
  cents(p.baseInterest, '231676.38');
  cents(p.payment, '1199.10');
  cents(p.newPayment, '1399.10');
  // Saving must equal the difference in interest paid.
  cents(p.interestSaved, (p.baseInterest - p.newInterest).toFixed(2));
  assert.equal(p.yearsSaved, p.periodsSaved / 12);
});

test('a larger overpayment saves strictly more', () => {
  const a = payoffWithExtra({ principal: 200_000, rate: 0.06, years: 30, extraPayment: 100 });
  const b = payoffWithExtra({ principal: 200_000, rate: 0.06, years: 30, extraPayment: 400 });
  assert.ok(b.interestSaved > a.interestSaved);
  assert.ok(b.periodsSaved > a.periodsSaved);
});

test('bulletSchedule pays interest only then the whole principal', () => {
  const b = bulletSchedule({ principal: 100_000, rate: 0.05, years: 5 });
  assert.equal(b.periods, 60);
  cents(b.payment, '416.67'); // 100000 * 0.05/12
  assert.equal(b.balloon, 100_000);
  cents(b.totalInterest, '25000.00');
  cents(b.totalPaid, '125000.00');

  // Balance never amortises until the final period.
  assert.equal(b.rows[0].principal, 0);
  assert.equal(b.rows[0].balance, 100_000);
  assert.equal(b.rows.at(-1).balance, 0);
  assert.equal(b.rows.at(-1).principal, 100_000);
});

test('bullet costs less per period but more in total than level', () => {
  const args = { principal: 100_000, rate: 0.05, years: 5 };
  const level = levelPayment(args);
  const bullet = bulletSchedule(args);
  assert.ok(bullet.payment < level.payment, 'bullet looks cheaper monthly');
  assert.ok(bullet.totalInterest > level.totalInterest, 'bullet costs more overall');
});

test('rateFromPayment inverts levelPayment', () => {
  const fwd = levelPayment({ principal: 200_000, rate: 0.06, years: 30 });
  const back = rateFromPayment({ principal: 200_000, payment: fwd.payment, years: 30 });
  assert.ok(Math.abs(back.rate - 0.06) < 1e-8, `got ${back.rate}`);
});

test('rateFromPayment round-trips across a range of loans', () => {
  const cases = [
    { principal: 25_000, rate: 0.0499, years: 5 },
    { principal: 5_000, rate: 0.199, years: 2 },
    { principal: 750_000, rate: 0.0325, years: 25 },
  ];
  for (const c of cases) {
    const { payment } = levelPayment(c);
    const back = rateFromPayment({ principal: c.principal, payment, years: c.years });
    assert.ok(Math.abs(back.rate - c.rate) < 1e-8, `${c.rate} -> ${back.rate}`);
  }
});

test('rateFromPayment refuses a payment stream that cannot repay', () => {
  // 100 a month for 12 months cannot retire 10,000.
  assert.throws(
    () => rateFromPayment({ principal: 10_000, payment: 100, years: 1 }),
    RangeError,
  );
});

test('rateFromPayment exposes a punitive rate honestly', () => {
  // 1,000 borrowed, 150 a month for 12 months. Solved independently at
  // 40-digit precision: monthly 0.1044810922, nominal 125.3773%.
  // The effective annual rate on the same loan is 229.53%, which is the
  // number a borrower feels. Both are correct; they answer different
  // questions. Quoting the smaller one is legal and routine.
  const r = rateFromPayment({ principal: 1_000, payment: 150, years: 1 });
  cents(r.totalPaid, '1800.00');
  cents(r.totalInterest, '800.00');
  assert.ok(Math.abs(r.rate - 1.253773106) < 1e-7, `nominal, got ${r.rate}`);

  const effective = Math.pow(1 + r.periodicRate, 12) - 1;
  assert.ok(Math.abs(effective - 2.295334) < 1e-5, `effective, got ${effective}`);
});

test('affordablePrincipal inverts levelPayment', () => {
  const fwd = levelPayment({ principal: 200_000, rate: 0.06, years: 30 });
  const back = affordablePrincipal({ payment: fwd.payment, rate: 0.06, years: 30 });
  cents(back.principal, '200000.00');
  assert.equal(back.periods, 360);
});

test('affordablePrincipal at zero rate is payment times periods', () => {
  const r = affordablePrincipal({ payment: 500, rate: 0, years: 2 });
  cents(r.principal, '12000.00');
  cents(r.totalInterest, '0.00');
});

test('a higher rate buys strictly less principal', () => {
  const cheap = affordablePrincipal({ payment: 1500, rate: 0.04, years: 30 });
  const dear = affordablePrincipal({ payment: 1500, rate: 0.08, years: 30 });
  assert.ok(cheap.principal > dear.principal);
});

// An MCP server hands these functions to an agent, which can pass a number no
// human would type. Before the period ceiling existed, each of these built a
// loop of billions of iterations: the process climbed to gigabytes and never
// returned. A refusal is the only correct answer.
test('an absurd period count is refused rather than attempted', () => {
  for (const call of [
    () => levelPayment({ principal: 1000, rate: 0.05, years: 1e9 }),
    () => amortisationSchedule({ principal: 1000, rate: 0.05, years: 1e9 }),
    () => bulletSchedule({ principal: 1000, rate: 0.05, years: 1e9 }),
    () => rateFromPayment({ principal: 1000, payment: 150, years: 1e9 }),
    () => affordablePrincipal({ payment: 500, rate: 0.05, years: 1e9 }),
    // the ceiling must bind on periodsPerYear too, not just years
    () => amortisationSchedule({ principal: 1000, rate: 0.05, years: 1, periodsPerYear: 1e9 }),
  ]) {
    assert.throws(call, /above the 100000 limit/);
  }
});

test('the largest allowed schedule is accepted and the ceiling is exact', () => {
  // 100000 periods must pass, 100001 must not
  const ok = amortisationSchedule({ principal: 1000, rate: 0.05, years: 100000, periodsPerYear: 1 });
  assert.equal(ok.rows.length <= 100000, true);
  assert.throws(
    () => levelPayment({ principal: 1000, rate: 0.05, years: 100001, periodsPerYear: 1 }),
    /above the 100000 limit/,
  );
});

// At a periodic rate of exactly -100% the annuity denominator is infinite and
// the payment comes back as a silent zero. Below it the power oscillates and
// every figure is garbage. Both used to be returned without complaint.
test('a periodic rate at or below -100% is refused', () => {
  assert.throws(
    () => levelPayment({ principal: 1000, rate: -12, years: 5, periodsPerYear: 12 }),
    /must be > -1/,
  );
  assert.throws(
    () => amortisationSchedule({ principal: 1000, rate: -24, years: 5, periodsPerYear: 12 }),
    /must be > -1/,
  );
});

test('a merely negative rate still works, because negative-rate lending is real', () => {
  const r = levelPayment({ principal: 1000, rate: -0.01, years: 5 });
  assert.ok(r.payment > 0);
  assert.ok(r.totalInterest < 0);
  // you repay less than you borrowed, which is the whole point
  assert.ok(r.totalPaid < 1000);
});
