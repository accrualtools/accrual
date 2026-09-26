// The CLI is how a person uses this package, and it had no tests at all. The
// math is covered elsewhere; what matters here is that a wrong invocation is
// refused with a message naming what the user typed, and that nothing ever
// prints the literal string "NaN" as if it were a figure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin/accrual.mjs');

/** Run the CLI and resolve with its output whatever the exit code. */
function run(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr, all: stdout + stderr });
      }
    );
  });
}

/** No output line may contain a non-number pretending to be one. */
function assertNoBrokenNumbers(out, label) {
  const offenders = out
    .split('\n')
    .filter((l) => /\bNaN\b|\bInfinity\b|\bundefined\b/.test(l));
  assert.deepEqual(offenders, [], `${label} printed a non-number:\n${offenders.join('\n')}`);
}

const INVOCATIONS = [
  ['days', '--from', '2025-02-28', '--to', '2025-03-31'],
  ['days', '--from', '2025-03-31', '--to', '2025-03-31'],
  ['days', '--from', '2025-01-30', '--to', '2025-01-31'],
  ['accrue', '--principal', '1000000', '--rate', '4.25', '--from', '2025-01-01', '--to', '2025-04-01'],
  ['accrue', '--principal', '1000', '--rate', '0', '--from', '2025-01-01', '--to', '2026-01-01'],
  ['accrue', '--principal', '1000', '--rate', '5', '--from', '2025-01-01', '--to', '2026-01-01', '--compound', '12'],
  ['accrue', '--principal', '1000', '--rate', '5', '--from', '2025-01-01', '--to', '2026-01-01', '--compound', 'continuous'],
  ['bill', '--face', '100', '--price', '97.80', '--settle', '2025-01-02', '--maturity', '2025-07-03'],
  ['bill', '--face', '100', '--price', '100', '--settle', '2025-01-02', '--maturity', '2025-07-03'],
  ['bond', '--face', '1000', '--coupon', '4', '--yield', '5', '--years', '10'],
  ['bond', '--face', '1000', '--coupon', '0', '--yield', '0', '--years', '10'],
  ['pv', '--amount', '1000', '--rate', '5', '--from', '2025-01-01', '--to', '2026-01-01'],
  ['loan', '--principal', '200000', '--rate', '6', '--years', '30'],
  ['loan', '--principal', '200000', '--rate', '0', '--years', '30', '--schedule', '60'],
  ['loan', '--principal', '200000', '--rate', '6', '--years', '30', '--bullet'],
  ['loan', '--principal', '1000', '--payment', '150', '--years', '1'],
  ['loan', '--payment', '1200', '--rate', '6', '--years', '30'],
  ['payoff', '--principal', '200000', '--rate', '6', '--years', '30', '--extra', '200'],
  ['payoff', '--principal', '200000', '--rate', '0', '--years', '30', '--extra', '200'],
  ['conventions'],
];

test('every documented invocation exits clean and prints only real numbers', async () => {
  for (const args of INVOCATIONS) {
    const r = await run(args);
    const label = `accrual ${args.join(' ')}`;
    assert.equal(r.code, 0, `${label} exited ${r.code}:\n${r.all}`);
    assertNoBrokenNumbers(r.all, label);
  }
});

test('help is reachable three ways and lists every command', async () => {
  const commands = ['days', 'accrue', 'bill', 'bond', 'pv', 'loan', 'payoff', 'conventions'];
  for (const args of [[], ['--help'], ['-h']]) {
    const r = await run(args);
    assert.equal(r.code, 0, `accrual ${args.join(' ')} exited ${r.code}`);
    for (const c of commands) {
      assert.match(r.stdout, new RegExp(`\\b${c}\\b`), `help omits ${c}`);
    }
  }
});

test('every command named in help actually runs', async () => {
  // Help is the contract. A command listed there that errors with "unknown
  // command" is worse than one that is missing from the list.
  const help = (await run(['--help'])).stdout;
  const listed = [...help.matchAll(/^ {2}(\w+)\s{2,}\S/gm)].map((m) => m[1]);
  assert.ok(listed.length >= 8, `expected the full command list, parsed ${listed.join(', ')}`);
  for (const c of listed) {
    const r = await run([c]);
    assert.doesNotMatch(r.all, /unknown command/, `help lists ${c} but the CLI rejects it`);
  }
});

test('an unknown command exits 2 and names what was typed', async () => {
  const r = await run(['nosuchthing']);
  assert.equal(r.code, 2);
  assert.match(r.all, /unknown command "nosuchthing"/);
});

test('a missing flag exits 2 and names the flag', async () => {
  const r = await run(['days', '--from', '2025-01-01']);
  assert.equal(r.code, 2);
  assert.match(r.all, /missing required: --to/);
});

test('a non-numeric amount exits 2 and names the value, not an internal null', async () => {
  const r = await run(['accrue', '--principal', 'abc', '--rate', '5', '--from', '2025-01-01', '--to', '2026-01-01']);
  assert.equal(r.code, 2);
  assert.match(r.all, /principal is not a number: abc/);
  assert.doesNotMatch(r.all, /null/);
});

test('a non-numeric term is caught at the boundary, not inside the library', async () => {
  // This used to reach the library as NaN and surface as
  // "years must be a finite number, got null", which names a value nobody typed.
  for (const args of [
    ['loan', '--principal', '200000', '--rate', '6', '--years', 'abc'],
    ['bond', '--face', '1000', '--coupon', '4', '--yield', '5', '--years', 'abc'],
    ['payoff', '--principal', '1000', '--rate', '6', '--years', 'abc', '--extra', '10'],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')} should exit 2, got ${r.code}:\n${r.all}`);
    assert.match(r.all, /years is not a number: abc/);
    assert.doesNotMatch(r.all, /got null/);
  }
});

test('a non-numeric frequency or compounding is caught the same way', async () => {
  const freq = await run(['loan', '--principal', '200000', '--rate', '6', '--years', '30', '--freq', 'abc']);
  assert.equal(freq.code, 2);
  assert.match(freq.all, /freq is not a number: abc/);

  const comp = await run(['accrue', '--principal', '1000', '--rate', '5', '--from', '2025-01-01', '--to', '2026-01-01', '--compound', 'abc']);
  assert.equal(comp.code, 2);
  assert.match(comp.all, /compound is not a number: abc/);
});

test('an impossible date exits 1 and says which date', async () => {
  const r = await run(['days', '--from', '2025-02-30', '--to', '2025-03-31']);
  assert.equal(r.code, 1);
  assert.match(r.all, /2025-02-30 is not a real date/);
});

test('an unpayable loan is refused rather than solved to a nonsense rate', async () => {
  const r = await run(['loan', '--principal', '1000', '--payment', '10', '--years', '1']);
  assert.equal(r.code, 1);
  assert.match(r.all, /cannot repay/);
});

test('an absurd term is refused instead of allocating forever', async () => {
  const r = await run(['loan', '--principal', '1000', '--rate', '5', '--years', '1e9']);
  assert.equal(r.code, 1);
  assert.match(r.all, /limit/);
});

test('identical dates report no percentage rather than NaN%', async () => {
  const r = await run(['days', '--from', '2025-03-31', '--to', '2025-03-31']);
  assert.equal(r.code, 0);
  assertNoBrokenNumbers(r.all, 'days with identical dates');
  assert.match(r.stdout, /n\/a/, 'a zero denominator must be named, not printed as a number');
});

test('a 30/360 zero-day period reports the absolute gap, not a percentage', async () => {
  // One actual day that the 30/360 family counts as zero. The percentage is
  // Infinity, but the gap itself is a real and useful number.
  const r = await run(['days', '--from', '2025-01-30', '--to', '2025-01-31']);
  assert.equal(r.code, 0);
  assertNoBrokenNumbers(r.all, 'days across a 30/360 zero');
  assert.match(r.stdout, /widest disagreement\s+0\.00277778/);
  assert.match(r.stdout, /n\/a/);
});

test('an interest-free loan says there is nothing to save instead of NaN%', async () => {
  const r = await run(['payoff', '--principal', '200000', '--rate', '0', '--years', '30', '--extra', '200']);
  assert.equal(r.code, 0);
  assertNoBrokenNumbers(r.all, 'payoff at a zero rate');
  assert.match(r.stdout, /no interest to save/);
});

test('a rejected --schedule does not print a table header with nothing under it', async () => {
  const r = await run(['loan', '--principal', '1000', '--rate', '5', '--years', '1', '--schedule', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.all, /schedule is not a number: abc/);
  assert.doesNotMatch(r.stdout, /period\s+payment\s+interest/);
});

test('--schedule 12 returns the first row, the last row and every twelfth', async () => {
  const r = await run(['loan', '--principal', '200000', '--rate', '6', '--years', '30', '--schedule', '12']);
  assert.equal(r.code, 0);
  // Rows are `  <period padded to 6>  <payment>  ...`, so anchor on a line that
  // ends in four aligned money columns rather than on the period alone.
  const periods = [...r.stdout.matchAll(/^\s+(\d+)(?:\s+[\d,]+\.\d{2}){4}\s*$/gm)].map((m) =>
    Number(m[1])
  );
  assert.equal(periods.length > 25, true, `expected ~32 rows, parsed ${periods.length}`);
  assert.equal(periods[0], 1, 'the first payment must always be shown');
  assert.equal(periods.at(-1), 360, 'the last payment must always be shown');
  assert.ok(periods.includes(12) && periods.includes(348), 'every twelfth row must be present');
  assert.ok(!periods.includes(13), 'rows between the step must be omitted');
});

test('the schedule closes at exactly zero on the final period', async () => {
  const r = await run(['loan', '--principal', '200000', '--rate', '6', '--years', '30', '--schedule', '359']);
  assert.equal(r.code, 0);
  const lastLine = r.stdout.split('\n').find((l) => /^\s+360(?:\s+[\d,]+\.\d{2}){4}\s*$/.test(l));
  assert.ok(lastLine, `the final period must appear:\n${r.stdout}`);
  assert.match(lastLine, /\s0\.00\s*$/, 'the closing balance must be exactly zero');
});

test('rates are accepted as both 4.25 and 0.0425', async () => {
  const asPct = await run(['accrue', '--principal', '1000000', '--rate', '4.25', '--from', '2025-01-01', '--to', '2025-04-01']);
  const asDec = await run(['accrue', '--principal', '1000000', '--rate', '0.0425', '--from', '2025-01-01', '--to', '2025-04-01']);
  const interest = (out) => out.match(/interest\s+([\d,]+\.\d+)/)[1];
  assert.equal(interest(asPct.stdout), interest(asDec.stdout));
});

test('a rate written with a percent sign is accepted everywhere a rate is taken', async () => {
  // "6%" is what a person types. It used to exit 2 with "rate is not a number".
  const signed = await run(['loan', '--principal', '200000', '--rate', '6%', '--years', '30']);
  const bare = await run(['loan', '--principal', '200000', '--rate', '6', '--years', '30']);
  assert.equal(signed.code, 0, `--rate 6% was rejected: ${signed.stderr}`);
  const payment = (out) => out.match(/payment\s+([\d,]+\.\d+)/)[1];
  assert.equal(payment(signed.stdout), payment(bare.stdout));

  // Every command that reads a rate, not just loan.
  const withPct = [
    ['accrue', '--principal', '1000000', '--rate', '4.25%', '--from', '2025-01-01', '--to', '2025-04-01'],
    ['pv', '--amount', '1000', '--rate', '5%', '--from', '2025-01-01', '--to', '2026-01-01'],
    ['bond', '--face', '1000', '--coupon', '4%', '--yield', '5%', '--years', '10'],
    ['payoff', '--principal', '200000', '--rate', '6%', '--years', '30', '--extra', '200'],
  ];
  for (const args of withPct) {
    const r = await run(args);
    assert.equal(r.code, 0, `${args[0]} rejected a % rate: ${r.stderr}`);
    assertNoBrokenNumbers(r.stdout, args[0]);
  }
});

test('the percent sign resolves the rate the bare-number heuristic gets wrong', async () => {
  // A bare 1 is over the "looks like a percentage" threshold, so it reads as
  // 100%. Only the explicit sign can say 1%.
  const asHundred = await run(['loan', '--principal', '200000', '--rate', '1', '--years', '30']);
  const asOne = await run(['loan', '--principal', '200000', '--rate', '1%', '--years', '30']);
  // The loan header echoes the rate it actually used: "at 1.0000%, 30y".
  const echoed = (out) => out.match(/\bat\s+([\d.]+)%/)[1];
  assert.equal(echoed(asHundred.stdout), '100.0000');
  assert.equal(echoed(asOne.stdout), '1.0000');
  // And the two must not agree, which is the whole point of the sign.
  const payment = (out) => out.match(/payment\s+([\d,]+\.\d+)/)[1];
  assert.notEqual(payment(asOne.stdout), payment(asHundred.stdout));
});

test('a percent sign on something that is not a number is still refused', async () => {
  const r = await run(['loan', '--principal', '200000', '--rate', 'six%', '--years', '30']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rate is not a number: six%/);
});

test('thousands separators in an amount are accepted', async () => {
  const plain = await run(['loan', '--principal', '200000', '--rate', '6', '--years', '30']);
  const commas = await run(['loan', '--principal', '200,000', '--rate', '6', '--years', '30']);
  const underscores = await run(['loan', '--principal', '200_000', '--rate', '6', '--years', '30']);
  assert.equal(commas.code, 0);
  assert.equal(underscores.code, 0);
  const payment = (out) => out.match(/payment\s+([\d,]+\.\d+)/)[1];
  assert.equal(payment(commas.stdout), payment(plain.stdout));
  assert.equal(payment(underscores.stdout), payment(plain.stdout));
});

test('--key=value works as well as --key value', async () => {
  const spaced = await run(['days', '--from', '2025-02-28', '--to', '2025-03-31']);
  const equals = await run(['days', '--from=2025-02-28', '--to=2025-03-31']);
  assert.equal(equals.code, 0);
  assert.equal(equals.stdout, spaced.stdout);
});
