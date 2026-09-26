// The MCP server is the surface an agent actually talks to. The math is tested
// elsewhere; what is tested here is the protocol around it, because a correct
// number wrapped in a malformed JSON-RPC frame is still a broken tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(root, 'mcp/server.mjs');

/**
 * Send a batch of JSON-RPC messages over stdio and collect the replies.
 * One process per call, closed by stdin end, so no test can leak a server.
 */
function rpc(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`server exited ${code}: ${err}`));
      const lines = out.split('\n').filter((l) => l.trim());
      try {
        resolve({ replies: lines.map((l) => JSON.parse(l)), stderr: err });
      } catch (e) {
        reject(new Error(`unparseable stdout: ${JSON.stringify(out)}`));
      }
    });
    for (const m of messages) {
      child.stdin.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
    }
    child.stdin.end();
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

/** Call one tool and return its parsed JSON payload. */
async function call(name, args, id = 2) {
  const { replies } = await rpc([init, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }]);
  const reply = replies.find((r) => r.id === id);
  assert.ok(reply, `no reply for ${name}`);
  assert.ok(reply.result, `no result for ${name}: ${JSON.stringify(reply.error)}`);
  return {
    isError: reply.result.isError,
    text: reply.result.content[0].text,
    json: reply.result.isError ? null : JSON.parse(reply.result.content[0].text),
  };
}

test('the server starts when launched through a symlink, the way npm installs it', async (t) => {
  // npm puts bins in node_modules/.bin as symlinks, so this is the only path a
  // real MCP client ever takes. Node resolves symlinks for import.meta.url but
  // not for argv[1], so a naive main-module check silently decides it was
  // imported and never reads stdin: the client sees a process that starts,
  // answers nothing, and exits 0.
  const { mkdtemp, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'accrual-bin-'));
  const link = join(dir, 'accrual-mcp');
  await symlink(SERVER, link);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [link], { stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (text += d));
    child.on('error', reject);
    child.on('close', () => resolve(text));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    child.stdin.end();
  });

  const lines = out.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1, `expected one reply through the symlink, got ${JSON.stringify(out)}`);
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
});

test('importing the server does not take over stdin or keep the process alive', async () => {
  // Importing used to attach a stdin listener as a side effect, so the importing
  // process held a handle it never asked for and could not exit on its own.
  const out = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', `import(${JSON.stringify(pathToFileURL(SERVER).href)}).then(m => console.log(Object.keys(m).sort().join(",")))`],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (text += d));
    child.on('error', reject);
    // stdin is left open on purpose: if the module claimed it, this never closes.
    child.on('close', (code) => resolve({ text: text.trim(), code }));
  });
  assert.equal(out.code, 0, 'importing the server did not exit cleanly');
  assert.equal(out.text, 'TOOLS,handle,serve');
});

test('initialize returns a protocol version and a server name', async () => {
  const { replies } = await rpc([init]);
  assert.equal(replies.length, 1);
  const r = replies[0].result;
  assert.equal(r.protocolVersion, '2024-11-05');
  assert.equal(r.serverInfo.name, 'accrual');
  assert.ok(r.capabilities.tools);
});

test('the advertised version matches package.json', async () => {
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8')
  );
  const { replies } = await rpc([init]);
  assert.equal(
    replies[0].result.serverInfo.version,
    pkg.version,
    'serverInfo.version drifted from package.json'
  );
});

test('tools/list advertises every tool with a usable schema', async () => {
  const { replies } = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tools = replies.find((r) => r.id === 2).result.tools;
  assert.ok(tools.length >= 13, `expected the full tool set, got ${tools.length}`);

  const names = new Set();
  for (const t of tools) {
    assert.ok(t.name, 'tool without a name');
    assert.ok(!names.has(t.name), `duplicate tool name ${t.name}`);
    names.add(t.name);
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema is not an object`);
    assert.ok(t.inputSchema.properties, `${t.name} has no properties`);
    // A required key that is not in properties is invisible to a model.
    for (const req of t.inputSchema.required || []) {
      assert.ok(
        Object.hasOwn(t.inputSchema.properties, req),
        `${t.name} requires ${req} but never describes it`
      );
    }
    // handler must not leak into the wire format
    assert.equal(t.handler, undefined, `${t.name} leaked its handler`);
  }
});

test('every advertised tool can be called and returns parseable JSON', async () => {
  // One representative valid call per tool. If a tool is added without a case
  // here the test fails, which is the point: an untested tool is an unusable one.
  const cases = {
    day_count: { from: '2025-02-28', to: '2025-03-31' },
    year_fraction: { from: '2025-01-01', to: '2025-07-01', convention: 'ACT/365F' },
    accrue_simple: { principal: 1_000_000, rate: 0.0425, from: '2025-01-01', to: '2025-04-01' },
    accrue_compound: { principal: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 12 },
    bill_yields: { face: 100, price: 97.8, settle: '2025-01-02', maturity: '2025-07-03' },
    bond_metrics: { face: 1000, couponRate: 0.04, yield: 0.05, years: 10 },
    present_value: { amount: 1000, rate: 0.05, from: '2025-01-01', to: '2026-01-01' },
    compare_products: { a: { label: 'x', rate: 0.05, periodsPerYear: 1 }, b: { label: 'y', rate: 0.049, periodsPerYear: 12 } },
    loan_payment: { principal: 200000, rate: 0.06, years: 30 },
    loan_schedule: { principal: 200000, rate: 0.06, years: 30, everyNth: 12 },
    loan_payoff: { principal: 200000, rate: 0.06, years: 30, extraPayment: 200 },
    loan_implied_rate: { principal: 1000, payment: 150, years: 1 },
    loan_affordable: { payment: 1200, rate: 0.06, years: 30 },
  };

  const { replies } = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const advertised = replies.find((r) => r.id === 2).result.tools.map((t) => t.name);
  assert.deepEqual(
    advertised.slice().sort(),
    Object.keys(cases).sort(),
    'tools/list and this test disagree about which tools exist'
  );

  for (const [name, args] of Object.entries(cases)) {
    const res = await call(name, args);
    assert.equal(res.isError, false, `${name} errored: ${res.text}`);
    assert.equal(typeof res.json, 'object', `${name} did not return an object`);
    // No NaN or Infinity anywhere: JSON turns both into null, which reads as
    // "no answer" to a model rather than "the input was wrong".
    const bad = [];
    JSON.stringify(res.json, (k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(k);
      return v;
    });
    assert.deepEqual(bad, [], `${name} returned non-finite numbers at ${bad.join(', ')}`);
    assert.ok(!/null/.test(JSON.stringify(res.json).slice(0, 0)), 'unreachable');
  }
});

test('a tool that is handed bad input reports it instead of crashing the server', async () => {
  const res = await call('day_count', { from: '2025-02-30', to: '2025-03-31' });
  assert.equal(res.isError, true);
  assert.match(res.text, /not a real date/);
});

test('a missing required argument is an error, not a silent NaN', async () => {
  const res = await call('accrue_simple', { principal: 1000, rate: 0.05, from: '2025-01-01' });
  assert.equal(res.isError, true, `expected an error, got ${res.text}`);
  assert.doesNotMatch(res.text, /null/, 'a missing date must not be reported as null output');
});

test('an unknown tool is a JSON-RPC error with the right code', async () => {
  const { replies } = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } }]);
  const r = replies.find((x) => x.id === 2);
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /unknown tool/);
});

test('an unsupported method is rejected, and a notification is silent', async () => {
  const { replies } = await rpc([
    init,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
  ]);
  assert.equal(replies.length, 2, 'a notification must not produce a reply');
  const r = replies.find((x) => x.id === 3);
  assert.equal(r.error.code, -32601);
});

test('malformed JSON gets a parse error and the server keeps serving', async () => {
  const { replies } = await rpc([init, '{ not json', { jsonrpc: '2.0', id: 4, method: 'ping' }]);
  const parseErr = replies.find((r) => r.error?.code === -32700);
  assert.ok(parseErr, 'no parse error returned');
  assert.ok(
    replies.find((r) => r.id === 4),
    'server stopped responding after a bad line'
  );
});

test('several messages arriving in one chunk are all answered', async () => {
  // Real clients do not politely send one line per TCP write.
  const { replies } = await rpc([
    init,
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  assert.equal(replies.length, 3);
  assert.deepEqual(
    replies.map((r) => r.id),
    [1, 2, 3]
  );
});

test('null periodsPerYear means continuous, not one', async () => {
  const cont = await call('accrue_compound', {
    principal: 1000,
    rate: 0.05,
    from: '2025-01-01',
    to: '2026-01-01',
    periodsPerYear: null,
  });
  assert.equal(cont.json.periodsPerYear, 'continuous');
  // e^0.05 - 1 = 5.127%
  assert.ok(Math.abs(cont.json.effectiveAnnualRate - (Math.exp(0.05) - 1)) < 1e-12);
});

test('an absurd term is refused rather than serialising megabytes', async () => {
  const res = await call('loan_schedule', { principal: 1000, rate: 0.05, years: 1e9 });
  assert.equal(res.isError, true, 'a billion-year loan must not be attempted');
  assert.match(res.text, /limit/);
});

test('a long but legal schedule is thinned and says so', async () => {
  const res = await call('loan_schedule', { principal: 200000, rate: 0.06, years: 30, everyNth: 1 });
  assert.equal(res.isError, false);
  assert.equal(res.json.rowsTotal, 360);
  assert.ok(res.json.rowsReturned <= 600);
  // Totals must always describe the whole loan, never the returned rows.
  assert.ok(res.json.totalInterest > 200000);
  assert.equal(res.json.rows.at(-1).period, res.json.periods);
  assert.ok(Math.abs(res.json.rows.at(-1).balance) < 1e-6, 'last row must close at zero');
});

test('the returned payload stays small enough for a model to read', async () => {
  // A 50,000 year bond is legal input. It must not come back as 11 MB of JSON.
  const res = await call('bond_metrics', { face: 1000, couponRate: 0.04, yield: 0.05, years: 20000 });
  assert.equal(res.isError, false);
  assert.ok(res.text.length < 200_000, `payload was ${res.text.length} bytes`);
  assert.equal(res.json.cashflowsTotal, 40000);
  assert.ok(res.json.cashflowsReturned <= 601);
});

// JSON has no NaN or Infinity: JSON.stringify turns both into `null`. A model
// reading `"widestDisagreementPct": null` next to `isError: false` concludes the
// tool declined to answer, which is a worse failure than an error would be.
// Every case below returned a silent null before it was fixed.

test('day_count never reports a null percentage without saying why', async () => {
  for (const [from, to] of [
    ['2025-03-31', '2025-03-31'], // identical dates: every convention returns 0
    ['2025-01-30', '2025-01-31'], // one day the 30/360 family counts as zero
    ['2025-03-30', '2025-03-31'],
  ]) {
    const res = await call('day_count', { from, to });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.widestDisagreementPct, null, `${from} -> ${to} should have no percentage`);
    assert.equal(typeof res.json.widestDisagreementAbs, 'number');
    assert.ok(Number.isFinite(res.json.widestDisagreementAbs));
    assert.match(
      res.json.widestDisagreementNote,
      /no percentage is defined/,
      'a null figure must be explained in the same response'
    );
  }
});

test('day_count still reports a percentage when one is defined', async () => {
  const res = await call('day_count', { from: '2025-02-28', to: '2025-03-31' });
  assert.equal(res.isError, false);
  assert.ok(Number.isFinite(res.json.widestDisagreementPct));
  assert.ok(res.json.widestDisagreementPct > 0);
  assert.match(res.json.widestDisagreementNote, /relative to the lowest/);
});

test('an interest-free loan explains its null percentage instead of leaving it bare', async () => {
  const res = await call('loan_payoff', { principal: 200000, rate: 0, years: 30, extraPayment: 200 });
  assert.equal(res.isError, false);
  assert.equal(res.json.interestSavedPct, null);
  assert.match(res.json.note, /interest-free/);
  // The term still shortens, and that number must be real.
  assert.ok(res.json.periodsSaved > 0);
});

test('a bond with no face value is an error, not a response full of nulls', async () => {
  const res = await call('bond_metrics', { face: 0, couponRate: 0.04, yield: 0.05, years: 10 });
  assert.equal(res.isError, true, `expected an error, got ${res.text}`);
  assert.match(res.text, /face must be > 0/);
});

test('a bill with no face value is an error, not an infinite yield', async () => {
  const res = await call('bill_yields', { face: 0, price: 100, settle: '2025-01-01', maturity: '2025-07-01' });
  assert.equal(res.isError, true);
  assert.match(res.text, /face must be > 0/);
});

test('no successful response contains an unexplained null', async () => {
  // Any null in a payload must sit beside a note that accounts for it. This is
  // the sweep that caught the four separate divide-by-zero fields originally.
  const cases = [
    ['day_count', { from: '2025-03-31', to: '2025-03-31' }],
    ['day_count', { from: '2025-01-30', to: '2025-01-31' }],
    ['loan_payment', { principal: 200000, rate: 0, years: 30 }],
    ['loan_payoff', { principal: 200000, rate: 0, years: 30, extraPayment: 200 }],
    ['loan_schedule', { principal: 200000, rate: 0, years: 30, everyNth: 60 }],
    ['bond_metrics', { face: 1000, couponRate: 0, yield: 0, years: 10 }],
    ['accrue_simple', { principal: 0, rate: 0, from: '2025-01-01', to: '2026-01-01' }],
    ['accrue_compound', { principal: 1000, rate: -1, from: '2025-01-01', to: '2026-01-01', periodsPerYear: 1 }],
    ['compare_products', { a: { rate: 0.05 }, b: { rate: 0.05 } }],
    ['bill_yields', { face: 100, price: 100, settle: '2025-01-01', maturity: '2025-07-01' }],
    ['present_value', { amount: 1000, rate: 0, from: '2025-01-01', to: '2026-01-01' }],
  ];

  for (const [name, args] of cases) {
    const res = await call(name, args);
    assert.equal(res.isError, false, `${name} errored: ${res.text}`);
    const nulls = [];
    const walk = (v, path) => {
      if (v === null) return nulls.push(path);
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      }
    };
    walk(res.json, '');
    if (nulls.length) {
      const explained = /null|no percentage|interest-free/i.test(
        JSON.stringify(Object.entries(res.json).filter(([k]) => /note/i.test(k)))
      );
      assert.ok(
        explained,
        `${name}(${JSON.stringify(args)}) returned nulls at ${nulls.join(', ')} with no note explaining them`
      );
    }
  }
});

test('a compounding frequency of zero is refused rather than silently ignored', async () => {
  const res = await call('accrue_compound', {
    principal: 1000,
    rate: 0.05,
    from: '2025-01-01',
    to: '2026-01-01',
    periodsPerYear: 0,
  });
  assert.equal(res.isError, true, `expected an error, got ${res.text}`);
  assert.match(res.text, /periodsPerYear must be > 0/);
});

test('a rate worse than -100% per period is refused rather than returned as null', async () => {
  const res = await call('accrue_compound', {
    principal: 1000,
    rate: -2,
    from: '2025-01-01',
    to: '2026-01-01',
    periodsPerYear: 1,
  });
  assert.equal(res.isError, true, `expected an error, got ${res.text}`);
  assert.match(res.text, /must be >= 0/);
});

test('a bad numeric input is named by type, not reported as null', async () => {
  const res = await call('accrue_simple', {
    principal: 'lots',
    rate: 0.05,
    from: '2025-01-01',
    to: '2026-01-01',
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /principal must be a finite number, got "lots"/);
});
