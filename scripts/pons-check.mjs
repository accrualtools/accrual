#!/usr/bin/env node
// Read pons v2 launch state straight off Robinhood Chain.
//
//   node scripts/pons-check.mjs                     # can I launch? what are the terms?
//   node scripts/pons-check.mjs --wallet 0xYour...  # check a specific wallet
//   node scripts/pons-check.mjs --token 0xToken...  # read a launched token's metadata
//
// The pons web app is currently showing "Degraded performance ... market data
// may load slowly or read out of date", so anything that matters is read from
// the contracts instead of from their API.

import { keccakHex, selector, toChecksum, selfTest } from './keccak.mjs';

selfTest((m) => { console.error(`keccak self-test failed: ${m}`); process.exit(1); });

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

// docs.ponsfamily.com/v2#contracts
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const LAUNCH_AND_BUY = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', b: '', x: '' };

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

let rpcId = 1;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} (${j.error.code})`);
  return j.result;
}

const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const encAddr = (a) => pad(a.toLowerCase());

async function call(to, sig, argsHex = '') {
  const data = selector(sig) + argsHex;
  return rpc('eth_call', [{ to, data }, 'latest']);
}

/* ------------------------------------------------------------------ decode */

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const toBig = (w) => BigInt('0x' + w);
const toAddr = (w) => toChecksum('0x' + w.slice(24));
const toBool = (w) => toBig(w) !== 0n;

// A dynamic string is an offset into the tail; the tail holds its length then
// its bytes, right-padded to a word.
function decodeStringAt(hex, offsetBytes) {
  const base = 2 + offsetBytes * 2;
  const len = Number(BigInt('0x' + hex.slice(base, base + 64)));
  if (len === 0) return '';
  const raw = hex.slice(base + 64, base + 64 + len * 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

const fmtEth = (wei) => {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

const ok = (s) => `  ${C.g}ok${C.x}   ${s}`;
const bad = (s) => `  ${C.r}no${C.x}   ${s}`;
const info = (s) => `  ${C.d}--${C.x}   ${s}`;

/* -------------------------------------------------------------------- main */

console.log(`\n${C.b}pons v2 on Robinhood Chain${C.x}`);

const netId = await rpc('eth_chainId', []);
const blockHex = await rpc('eth_blockNumber', []);
const chainOk = Number(BigInt(netId)) === CHAIN_ID;
console.log(chainOk
  ? ok(`chain id ${Number(BigInt(netId))}, block ${Number(BigInt(blockHex))}`)
  : bad(`chain id ${Number(BigInt(netId))} but expected ${CHAIN_ID}`));

// A factory with no code means the address is wrong, and every read below
// would silently return 0x rather than failing.
const code = await rpc('eth_getCode', [FACTORY, 'latest']);
console.log(code && code !== '0x'
  ? ok(`factory has code, ${(code.length - 2) / 2} bytes`)
  : bad(`factory ${FACTORY} has NO CODE — wrong address or wrong chain`));

/* --------------------------------------------------------- token inspection */

const tokenArg = flag('token');
if (tokenArg) {
  const token = toChecksum(tokenArg.trim().toLowerCase());
  console.log(`\n${C.b}token ${token}${C.x}`);

  const tcode = await rpc('eth_getCode', [token, 'latest']);
  if (!tcode || tcode === '0x') {
    console.log(bad('no contract at that address on this chain'));
    process.exit(1);
  }
  console.log(ok(`contract, ${(tcode.length - 2) / 2} bytes`));

  for (const [sig, label] of [['name()', 'name'], ['symbol()', 'symbol']]) {
    try {
      const hex = await call(token, sig);
      console.log(info(`${label.padEnd(12)}${decodeStringAt(hex, Number(toBig(word(hex, 0))))}`));
    } catch (err) { console.log(bad(`${label}: ${err.message}`)); }
  }
  try {
    const hex = await call(token, 'totalSupply()');
    console.log(info(`supply      ${fmtEth(toBig(word(hex, 0)))}`));
  } catch (err) { console.log(bad(`totalSupply: ${err.message}`)); }

  // getTokenInfo returns (address, string, string, Socials). The struct is
  // five strings, so it is itself dynamic and carries its own offsets.
  try {
    const hex = await call(token, 'getTokenInfo()');
    const deployer = toAddr(word(hex, 0));
    const logo = decodeStringAt(hex, Number(toBig(word(hex, 1))));
    const desc = decodeStringAt(hex, Number(toBig(word(hex, 2))));
    const socialsAt = Number(toBig(word(hex, 3)));
    const socialsHex = '0x' + hex.slice(2 + socialsAt * 2);
    const names = ['twitter', 'telegram', 'discord', 'website', 'farcaster'];
    console.log(`\n  ${C.b}onchain metadata${C.x}`);
    console.log(info(`deployer    ${deployer}`));
    console.log(info(`logo        ${logo || C.y + '(empty)' + C.x}`));
    console.log(info(`description ${desc ? desc.slice(0, 80) + (desc.length > 80 ? '...' : '') : C.y + '(empty)' + C.x}`));
    names.forEach((n, i) => {
      const v = decodeStringAt(socialsHex, Number(toBig(word(socialsHex, i))));
      console.log(info(`${n.padEnd(12)}${v || C.d + '(empty)' + C.x}`));
    });
  } catch (err) {
    console.log(bad(`getTokenInfo: ${err.message}`));
    console.log(info('not a pons v2 launch token, or a different ABI'));
  }

  try {
    const hex = await call(FACTORY, 'getLaunchedToken(address)', encAddr(token));
    if (hex === '0x') {
      console.log(bad('factory has no record of this token'));
    } else {
      // LaunchedToken is a static struct, so its fields sit inline behind one
      // offset word.
      const b = '0x' + hex.slice(2 + 64);
      const phases = ['NotGraduated (on curve)', 'Swept', 'PoolCreated (on Uniswap v4)', 'Rescued'];
      console.log(`\n  ${C.b}factory record${C.x}`);
      console.log(info(`curve       ${toAddr(word(b, 1))}`));
      console.log(info(`deployer    ${toAddr(word(b, 2))}`));
      console.log(info(`feeTo       ${toAddr(word(b, 3))}`));
      console.log(info(`pairToken   ${toAddr(word(b, 4))}`));
      console.log(info(`threshold   ${fmtEth(toBig(word(b, 5)))}`));
      console.log(info(`creatorTax  ${toBig(word(b, 8))} bps`));
      console.log(info(`buyback     ${toBool(word(b, 9))}`));
      console.log(info(`phase       ${phases[Number(toBig(word(b, 10)))] ?? toBig(word(b, 10))}`));
      console.log(info(`exists      ${toBool(word(b, 14))}`));
    }
  } catch (err) {
    console.log(bad(`getLaunchedToken: ${err.message}`));
  }
  console.log();
  process.exit(0);
}

/* ------------------------------------------------------------ launch gates */

console.log(`\n${C.b}launch gate${C.x}`);

const wallet = flag('wallet');
if (wallet) {
  const w = toChecksum(wallet.trim().toLowerCase());
  try {
    const hex = await call(FACTORY, 'canLaunch(address)', encAddr(w));
    const allowed = toBool(word(hex, 0));
    console.log(allowed
      ? ok(`canLaunch(${w}) = true — this wallet may launch`)
      : bad(`canLaunch(${w}) = false — this wallet CANNOT launch`));
  } catch (err) {
    console.log(bad(`canLaunch reverted: ${err.message}`));
  }
} else {
  console.log(info('no --wallet given, checking the public gate only'));
}

for (const [sig, label, want] of [
  ['launchEnabled()', 'launchEnabled', true],
  ['launchFee()', 'launchFee', null],
  ['maxCreatorTaxBps()', 'maxCreatorTaxBps', null],
  ['launchConfigCount()', 'launchConfigCount', null],
]) {
  try {
    const hex = await call(FACTORY, sig);
    const v = toBig(word(hex, 0));
    if (want === true) {
      console.log(v !== 0n
        ? ok(`${label} = true — public launches are OPEN`)
        : bad(`${label} = false — public launches are CLOSED, whitelist only`));
    } else if (label === 'launchFee') {
      console.log(info(`${label.padEnd(18)}${fmtEth(v)} ETH`));
    } else {
      console.log(info(`${label.padEnd(18)}${v}`));
    }
  } catch (err) {
    console.log(bad(`${label}: ${err.message.slice(0, 70)}`));
  }
}

/* ---------------------------------------------------------- launch configs */

console.log(`\n${C.b}launch configs${C.x}`);
try {
  const cntHex = await call(FACTORY, 'launchConfigCount()');
  const count = Number(toBig(word(cntHex, 0)));
  for (let id = 0; id < count; id++) {
    const hex = await call(FACTORY, 'getLaunchConfig(uint256)', pad(id.toString(16)));
    // LaunchConfig is static: supply, curveFeeBps, phantomQuote,
    // graduationThreshold, poolFee, tickSpacing, enabled.
    const b = hex;
    const supply = toBig(word(b, 0));
    const curveFee = toBig(word(b, 1));
    const phantom = toBig(word(b, 2));
    const threshold = toBig(word(b, 3));
    const poolFee = toBig(word(b, 4));
    const enabled = toBool(word(b, 6));
    // Reserved for the pool = supply * phantom / (phantom + threshold).
    const reserved = (supply * phantom) / (phantom + threshold);
    const pct = Number((reserved * 10000n) / supply) / 100;
    console.log(`  ${enabled ? C.g + 'enabled ' + C.x : C.d + 'disabled' + C.x} id ${id}`);
    console.log(info(`  supply      ${fmtEth(supply)}`));
    console.log(info(`  curve fee   ${curveFee} bps`));
    console.log(info(`  threshold   ${fmtEth(threshold)} to graduate`));
    console.log(info(`  pool fee    ${poolFee}`));
    console.log(info(`  reserved    ${pct}% of supply becomes pool liquidity`));
  }
} catch (err) {
  console.log(bad(`config enumeration failed: ${err.message.slice(0, 80)}`));
}

/* --------------------------------------------------------------- summary */

console.log(`\n${C.b}also deployed${C.x}`);
for (const [addr, label] of [[FACTORY, 'factory'], [LAUNCH_AND_BUY, 'launch-and-buy router']]) {
  const c = await rpc('eth_getCode', [addr, 'latest']);
  console.log(c && c !== '0x' ? ok(`${label.padEnd(22)}${addr}`) : bad(`${label.padEnd(22)}${addr} NO CODE`));
}
console.log();
