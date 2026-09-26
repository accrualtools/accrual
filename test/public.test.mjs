// public/ is generated from src/ by scripts/build.mjs, and the build only checks
// that each file parses. A file can parse and still be broken: the browser
// bundle is the three modules concatenated into one scope with their
// cross-imports stripped, so a duplicate declaration or a dropped export is
// exactly the kind of failure that passes `node --check` and then throws in a
// browser tab where nobody sees it.
//
// These tests import the published copies and compare them against src/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as src from '../src/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'public/accrual.mjs');

const bundle = await import(bundlePath);

test('the published bundle actually executes, not merely parses', () => {
  assert.equal(typeof bundle, 'object');
  assert.ok(Object.keys(bundle).length > 0, 'bundle exported nothing');
});

test('every function exported from src is exported from the bundle', () => {
  const expected = Object.keys(src).filter((k) => typeof src[k] === 'function');
  const missing = expected.filter((k) => typeof bundle[k] !== 'function');
  assert.deepEqual(missing, [], `the bundle is missing: ${missing.join(', ')}`);
  assert.ok(expected.length >= 20, `expected the full API, found ${expected.length}`);
});

test('the constants survive the bundling too', () => {
  assert.deepEqual([...bundle.CONVENTIONS], [...src.CONVENTIONS]);
  assert.deepEqual(bundle.CONVENTION_NOTES, src.CONVENTION_NOTES);
});

test('the bundle returns the same numbers as the library it was built from', () => {
  // Chosen to touch each module: day count, accrual, pricing and amortisation.
  const cases = [
    ['yearFraction', ['2025-02-28', '2025-03-31', '30U/360']],
    ['yearFraction', ['2025-01-01', '2026-01-01', 'ACT/ACT']],
    ['actualDays', ['2025-01-01', '2025-04-01']],
    ['compareConventions', ['2025-02-28', '2025-03-31']],
    ['accrueSimple', [{ principal: 1e6, rate: 0.0425, from: '2025-01-01', to: '2025-04-01' }]],
    ['accrueCompound', [{ principal: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 12 }]],
    ['effectiveAnnualRate', [0.05, 12]],
    ['presentValue', [{ amount: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01' }]],
    ['billYields', [{ face: 100, price: 97.8, settle: '2025-01-02', maturity: '2025-07-03' }]],
    ['bondMetrics', [{ face: 1000, couponRate: 0.04, yield: 0.05, years: 10 }]],
    ['levelPayment', [{ principal: 200000, rate: 0.06, years: 30 }]],
    ['amortisationSchedule', [{ principal: 1000, rate: 0.06, years: 1 }]],
    ['payoffWithExtra', [{ principal: 200000, rate: 0.06, years: 30, extraPayment: 200 }]],
    ['rateFromPayment', [{ principal: 1000, payment: 150, years: 1 }]],
    ['affordablePrincipal', [{ payment: 1200, rate: 0.06, years: 30 }]],
    ['bulletSchedule', [{ principal: 1000, rate: 0.06, years: 2 }]],
  ];

  for (const [fn, args] of cases) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(bundle[fn](...args))),
      JSON.parse(JSON.stringify(src[fn](...args))),
      `${fn} disagrees between the bundle and src`
    );
  }
});

test('the guards survive the bundling, so the site refuses the same inputs', () => {
  // A stripped guard would let the web page print NaN duration where the
  // library throws, which is the exact drift this file exists to catch.
  assert.throws(() => bundle.bondMetrics({ face: 0, couponRate: 0.04, yield: 0.05, years: 10 }), /face must be > 0/);
  assert.throws(
    () => bundle.billYields({ face: 0, price: 100, settle: '2025-01-01', maturity: '2025-07-01' }),
    /face must be > 0/
  );
  assert.throws(() => bundle.yearFraction('2025-02-30', '2025-03-31'), /not a real date/);
  assert.throws(() => bundle.levelPayment({ principal: 1000, rate: 0.05, years: 1e9 }), /limit/);
});

test('no import survived the concatenation', async () => {
  // A leftover relative import would 404 in a browser and take the page with it.
  const text = await readFile(bundlePath, 'utf8');
  const imports = text.match(/^import\s.*$/gm);
  assert.equal(imports, null, `bundle still imports: ${imports?.join(' | ')}`);
});

test('the published CLI and MCP copies point at the bundle, not at src', async () => {
  // public/ is served without src/ beside it, so a surviving ../src/ path is a
  // file that downloads cleanly and then fails on first run.
  for (const name of ['cli.mjs', 'mcp.mjs']) {
    const text = await readFile(join(root, 'public', name), 'utf8');
    assert.doesNotMatch(text, /\.\.\/src\//, `public/${name} still reaches outside public/`);
    assert.match(text, /from '\.\/accrual\.mjs'/, `public/${name} does not import the bundle`);
  }
});

test('the published copies are in step with the sources they were built from', async () => {
  // Running the build is part of shipping. A stale public/ means the site and
  // the repo disagree about what the code does, silently.
  const pairs = [
    ['bin/accrual.mjs', 'public/cli.mjs'],
    ['mcp/server.mjs', 'public/mcp.mjs'],
  ];
  for (const [from, to] of pairs) {
    const source = await readFile(join(root, from), 'utf8');
    const published = await readFile(join(root, to), 'utf8');
    const strip = (s) =>
      s
        .replace(/^#!.*$/m, '')
        .replace(/^\/\/ .*served verbatim from src.*$/m, '')
        .replace(/^\/\/ No network calls.*$/m, '')
        .replace(/'\.\.\/src\/index\.mjs'|'\.\/accrual\.mjs'/g, 'IMPORT')
        .replace(/\s+/g, ' ')
        .trim();
    assert.equal(
      strip(published),
      strip(source),
      `${to} is stale: run npm run build after changing ${from}`
    );
  }
});

test('the browser bundle carries the current source of all three modules', async () => {
  const published = await readFile(bundlePath, 'utf8');
  for (const name of ['src/daycount.mjs', 'src/accrue.mjs', 'src/amortise.mjs']) {
    const source = await readFile(join(root, name), 'utf8');
    // Sample a distinctive line from each module rather than diffing whole
    // files, because the build legitimately rewrites the import lines.
    const marker = source
      .split('\n')
      .filter((l) => l.startsWith('export function'))
      .at(-1);
    assert.ok(marker, `no exported function found in ${name}`);
    assert.ok(published.includes(marker), `${name} looks stale in the bundle: missing ${marker}`);
  }
});
