#!/usr/bin/env node
// Fill in the contract address (and chain id) everywhere at once, then verify.
//
//   node scripts/set-ca.mjs 0xAbC... [chainId] [--no-deploy]
//
// The point of this script is that the address is typed once. Every place it
// appears is derived from that single input, so the site, the agent manifest
// and the crawler text cannot drift apart from each other.
//
// It refuses to write a mixed-case address whose EIP-55 checksum is wrong,
// which is the one mistake that is expensive and silent.

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', b: '', x: '' };

const die = (msg) => {
  console.error(`\n${C.r}${C.b}abort${C.x} ${msg}\n`);
  process.exit(1);
};

/* ------------------------------------------------------------------ keccak */
// EIP-55 needs keccak-256, which node's crypto does not provide (its sha3-256
// uses different padding). 40 bytes of input is one block, so a plain BigInt
// implementation is fast enough and easier to read than a lane-split one.

const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// r[x][y], the rho rotation offsets from the Keccak reference spec.
const R = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

const at = (x, y) => x + 5 * y;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // theta
    const Cc = new Array(5);
    for (let x = 0; x < 5; x++) {
      Cc[x] = A[at(x, 0)] ^ A[at(x, 1)] ^ A[at(x, 2)] ^ A[at(x, 3)] ^ A[at(x, 4)];
    }
    for (let x = 0; x < 5; x++) {
      const D = Cc[(x + 4) % 5] ^ rotl(Cc[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) A[at(x, y)] ^= D;
    }
    // rho + pi
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[at(y, (2 * x + 3 * y) % 5)] = rotl(A[at(x, y)], R[x][y]);
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[at(x, y)] = B[at(x, y)] ^ (~B[at((x + 1) % 5, y)] & B[at((x + 2) % 5, y)]) & MASK;
      }
    }
    // iota
    A[0] ^= RC[round];
  }
  return A;
}

function keccak256(bytes) {
  const rate = 136; // 1088 bits
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  let A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    A = keccakF(A);
  }

  let out = '';
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out += (lane & 0xffn).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return out;
}

// Never trust a hash function you just wrote. These are the published vectors.
function selfTest() {
  const enc = (s) => new TextEncoder().encode(s);
  const vectors = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    ['testing', '5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02'],
  ];
  for (const [input, want] of vectors) {
    const got = keccak256(enc(input));
    if (got !== want) die(`keccak self-test failed for "${input}"\n  want ${want}\n  got  ${got}`);
  }
  // EIP-55 vectors from the spec itself.
  const addrs = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  for (const a of addrs) {
    const got = toChecksum(a.toLowerCase());
    if (got !== a) die(`EIP-55 self-test failed\n  want ${a}\n  got  ${got}`);
  }
}

function toChecksum(lower) {
  const body = lower.slice(2);
  const hash = keccak256(new TextEncoder().encode(body));
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const deploy = !argv.includes('--no-deploy');
const positional = argv.filter((a) => !a.startsWith('--'));
const [rawAddr, rawChain] = positional;

if (!rawAddr) {
  console.error(`
${C.b}usage${C.x}  node scripts/set-ca.mjs <address> [chainId] [--no-deploy]

  node scripts/set-ca.mjs 0x1234abcd...ef 1234
  node scripts/set-ca.mjs 0x1234abcd...ef          ${C.d}# address only${C.x}
  node scripts/set-ca.mjs 0x1234abcd...ef 1234 --no-deploy
`);
  process.exit(1);
}

selfTest();

// Tolerate a paste that picked up whitespace, quotes or a trailing comma.
const addr = rawAddr.trim().replace(/^["'\s]+|["',\s]+$/g, '');

if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
  die(
    `not a valid EVM address: ${JSON.stringify(rawAddr)}\n` +
      `        expected 0x followed by 40 hex characters (42 total), got ${addr.length}.\n` +
      `        if pons uses a different address format, tell me and I'll adjust this check.`
  );
}

const lower = addr.toLowerCase();
const checksummed = toChecksum(lower);
const isMixedCase = addr !== lower && addr !== addr.toUpperCase();

if (isMixedCase && addr !== checksummed) {
  die(
    `EIP-55 checksum does not match. This address is very likely mistyped.\n` +
      `        you gave   ${addr}\n` +
      `        expected   ${checksummed}\n` +
      `        re-copy it from the explorer. nothing was written.`
  );
}

let chainId = null;
if (rawChain !== undefined) {
  const c = rawChain.trim();
  if (!/^\d+$/.test(c)) die(`chain id must be a plain decimal number, got ${JSON.stringify(rawChain)}`);
  chainId = c;
}

console.log(`
${C.b}address${C.x}   ${C.g}${checksummed}${C.x}
${C.b}checksum${C.x}  ${isMixedCase ? `${C.g}verified against EIP-55${C.x}` : `${C.y}input was single-case, writing the checksummed form${C.x}`}
${C.b}chain id${C.x}  ${chainId ?? `${C.y}not supplied, leaving <CHAIN_ID> in place${C.x}`}
${C.b}deploy${C.x}    ${deploy ? 'yes' : 'no'}`);

/* ------------------------------------------------------------------- patch */

// Each target matches either the placeholder or an address already written, so
// re-running with a corrected address works instead of silently doing nothing.
const targets = [
  {
    file: join(pub, 'agent.json'),
    label: 'agent.json address',
    find: /("address":\s*")(?:<CA>|0x[0-9a-fA-F]{40})(")/,
    to: `$1${checksummed}$2`,
  },
  {
    file: join(pub, 'llms.txt'),
    label: 'llms.txt address',
    find: /^(Contract address: ).*$/m,
    to: `$1${checksummed}`,
  },
  {
    file: join(pub, 'index.html'),
    label: 'index.html address',
    find: /(<code>)(?:&lt;CA&gt;|0x[0-9a-fA-F]{40})(<\/code>)/,
    to: `$1${checksummed}$2`,
  },
];

if (chainId) {
  targets.push(
    {
      file: join(pub, 'agent.json'),
      label: 'agent.json chainId',
      find: /("chainId":\s*")(?:<CHAIN_ID>|\d+)(")/,
      to: `$1${chainId}$2`,
    },
    {
      file: join(pub, 'agent.json'),
      label: 'agent.json chainIdSource',
      find: /("chainIdSource":\s*")[^"]*(")/,
      to: `$1supplied by the token creator, read from their wallet at launch$2`,
    }
  );
}

console.log(`\n${C.b}patching${C.x}`);

const touched = new Set();
for (const t of targets) {
  let src = await readFile(t.file, 'utf8');
  if (!t.find.test(src)) {
    die(`no match for ${t.label} in ${t.file}\n        the file changed shape; fix this script rather than the file.`);
  }
  if (!touched.has(t.file)) {
    await copyFile(t.file, `${t.file}.bak`);
    touched.add(t.file);
  }
  const before = src.match(t.find)[0];
  src = src.replace(t.find, t.to);
  const after = src.match(new RegExp(t.to.replace(/\$\d/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    ? t.to.replace(/\$\d/g, '')
    : '';
  await writeFile(t.file, src);
  console.log(`  ${C.g}ok${C.x}  ${t.label}`);
  console.log(`      ${C.d}${before.trim()}${C.x}`);
  if (after) console.log(`      ${C.g}${after.trim()}${C.x}`);
}

// A malformed manifest is worse than a placeholder, so prove it still parses.
try {
  JSON.parse(await readFile(join(pub, 'agent.json'), 'utf8'));
  console.log(`  ${C.g}ok${C.x}  agent.json still parses`);
} catch (err) {
  die(`agent.json no longer parses: ${err.message}\n        restore with: mv public/agent.json.bak public/agent.json`);
}

// Confirm nothing was left behind.
const leftovers = [];
for (const f of ['agent.json', 'llms.txt', 'index.html']) {
  const src = await readFile(join(pub, f), 'utf8');
  if (/<CA>|&lt;CA&gt;/.test(src)) leftovers.push(`${f}: CA`);
  if (chainId && /<CHAIN_ID>/.test(src)) leftovers.push(`${f}: CHAIN_ID`);
}
if (leftovers.length) die(`placeholders still present:\n        ${leftovers.join('\n        ')}`);
console.log(`  ${C.g}ok${C.x}  no placeholders left${chainId ? '' : ` ${C.d}(CHAIN_ID intentionally kept)${C.x}`}`);

/* ------------------------------------------------------- test, build, ship */

const run = (cmd, args, label) => {
  process.stdout.write(`\n${C.b}${label}${C.x}\n`);
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(err.stdout ?? '');
    console.error(err.stderr ?? '');
    die(`${label} failed. files are patched; backups are at public/*.bak`);
  }
};

const testOut = run('npm', ['test'], 'tests');
const pass = testOut.match(/^# pass (\d+)/m)?.[1];
const fail = testOut.match(/^# fail (\d+)/m)?.[1];
console.log(`  ${fail === '0' ? C.g + 'ok' + C.x : C.r + 'FAIL' + C.x}  ${pass} passing, ${fail} failing`);
if (fail !== '0') die('tests failing, not deploying');

run('npm', ['run', 'build'], 'build');
console.log(`  ${C.g}ok${C.x}  bundle rebuilt and parsed`);

if (!deploy) {
  console.log(`\n${C.y}stopped before deploy${C.x} (--no-deploy). ship it with:\n  npx vercel deploy public --prod --yes\n`);
  process.exit(0);
}

const out = run('npx', ['vercel', 'deploy', 'public', '--prod', '--yes'], 'deploy');
const url = out.match(/https:\/\/[^\s]+\.vercel\.app/)?.[0];
console.log(`  ${C.g}ok${C.x}  ${url ?? 'deployed'}`);

/* ------------------------------------------------------------ verify live */

process.stdout.write(`\n${C.b}verifying accrual.tools${C.x}\n`);

const get = async (path) => {
  const res = await fetch(`https://accrual.tools${path}`, { cache: 'no-store' });
  return { status: res.status, body: await res.text() };
};

// The edge may still be serving the previous build for a moment.
let live = null;
for (let i = 1; i <= 10; i++) {
  const { status, body } = await get('/agent.json');
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      if (j.token?.address === checksummed) { live = j; break; }
    } catch { /* fall through to retry */ }
  }
  console.log(`  ${C.d}attempt ${i}: not live yet${C.x}`);
  await new Promise((r) => setTimeout(r, 3000));
}

if (!live) die('agent.json on accrual.tools does not show the new address after 10 attempts');
console.log(`  ${C.g}ok${C.x}  agent.json  ${live.token.address}`);
console.log(`  ${C.g}ok${C.x}  chainId     ${live.token.chain.chainId}`);

for (const [path, needle] of [['/llms.txt', checksummed], ['/', checksummed]]) {
  const { status, body } = await get(path);
  const found = body.includes(needle);
  console.log(`  ${status === 200 && found ? C.g + 'ok' + C.x : C.r + 'FAIL' + C.x}  ${path.padEnd(11)} ${status}${found ? '' : '  address not found in body'}`);
  if (status !== 200 || !found) die(`${path} did not come back with the address`);
}

console.log(`
${C.g}${C.b}done${C.x}  $ACCR is live with its contract address.

  ${C.b}${checksummed}${C.x}

copy that from here, not from a screenshot, and paste it into the pinned tweet.
backups of the previous files are at public/*.bak
`);
