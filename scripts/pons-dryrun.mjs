#!/usr/bin/env node
// Build the exact pons v2 launchToken call and simulate it, without signing.
//
//   node scripts/pons-dryrun.mjs
//   node scripts/pons-dryrun.mjs --tax 200 --buyback true
//
// Everything here is eth_call and eth_estimateGas, so nothing is broadcast and
// no key is needed. The point is to find out whether the real transaction would
// revert before paying a launch fee to discover it.
//
// The return value of the simulated call is the token and curve address the
// real launch would land on, because both are CREATE2-derived from the salt.

import { selector, toChecksum, selfTest } from './keccak.mjs';

selfTest((m) => { console.error(`keccak self-test failed: ${m}`); process.exit(1); });

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const WALLET = '0xB803c14CAF1dc1a3ACEAf535881ef964c1A15C18';
const NATIVE = '0x0000000000000000000000000000000000000000';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', b: '', x: '' };

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

const CREATOR_TAX_BPS = Number(flag('tax', '200'));
const BUYBACK = flag('buyback', 'true') === 'true';
const SALT = flag('salt', null);

let id = 1;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  const j = await res.json();
  if (j.error) return { __err: j.error };
  return j.result;
}

/* ------------------------------------------------------------------ encode */

const word = (h, i) => h.slice(2 + i * 64, 2 + (i + 1) * 64);
const big = (w) => BigInt('0x' + w);
const padNum = (n) => BigInt(n).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const padHex32 = (h) => h.replace(/^0x/, '').padStart(64, '0');

// A dynamic string encodes as its byte length in one word, then the bytes
// right-padded to a whole number of words.
function encString(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  const padded = hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return padNum(bytes.length) + padded;
}

// A struct made only of dynamic members is itself dynamic: a head of offsets
// followed by the tails, with every offset measured from the start of the head.
function encStringStruct(values) {
  const tails = values.map(encString);
  let offset = values.length * 32;
  let head = '';
  for (const t of tails) {
    head += padNum(offset);
    offset += t.length / 2;
  }
  return head + tails.join('');
}

function encTokenParams(p) {
  const socials = encStringStruct([p.twitter, p.telegram, p.discord, p.website, p.farcaster]);
  const dyn = [encString(p.name), encString(p.symbol), encString(p.logo), encString(p.description), socials];

  // Ten head words: four strings, the socials struct, then six static fields.
  let offset = 10 * 32;
  let head = '';
  for (const d of dyn) {
    head += padNum(offset);
    offset += d.length / 2;
  }
  head += padAddr(p.creatorFeeRecipient);
  head += padNum(p.creatorTaxBps);
  head += padNum(p.buybackEnabled ? 1 : 0);
  head += padHex32(p.expectedEconomics);
  head += padHex32(p.salt);
  return head + dyn.join('');
}

const fmtEth = (wei) => {
  const s = wei.toString().padStart(19, '0');
  const f = s.slice(-18).replace(/0+$/, '');
  return f ? `${s.slice(0, -18)}.${f}` : s.slice(0, -18);
};

const ok = (s) => console.log(`  ${C.g}ok${C.x}   ${s}`);
const no = (s) => console.log(`  ${C.r}no${C.x}   ${s}`);
const nb = (s) => console.log(`  ${C.d}--${C.x}   ${s}`);

/* -------------------------------------------------------------- the params */

// Lowercase, to match the wordmark, the site, the banner and the package name.
// The two tokens already on chain say "Accrual", which is the inconsistency
// this launch is meant to fix.
const NAME = 'accrual';
const SYMBOL = 'ACCR';

// Already pinned, and byte-identical to public/logo.png (md5 14f543f2...).
// Reusing it means there is nothing new to upload and nothing new to verify.
const LOGO = 'ipfs://bafkreicknrfsvvvmp4uonfw4fuu2dnvvyguc3wgpwi3o7swizkkesbmspe';

const DESCRIPTION =
  'Yield math for tokenized RWAs. The same principal, rate, and dates produce six different ' +
  'accrued-interest numbers depending on the day-count convention, and the extremes sit 10% apart. ' +
  'accrual implements all six, plus bill yields, duration, and convexity. Runs in the browser, the ' +
  'shell, or your agent over MCP. 37 tests, zero dependencies, MIT. ACCR pays no coupon and accrues nothing.';

const SOCIALS = {
  twitter: 'https://x.com/accrualtools',
  telegram: '',
  discord: '',
  website: 'https://accrual.tools',
  farcaster: '',
};

console.log(`\n${C.b}pons v2 launch dry run${C.x}  ${C.d}(no transaction is sent)${C.x}`);

/* ----------------------------------------------------------- preflight reads */

console.log(`\n${C.b}preflight${C.x}`);

const chainId = await rpc('eth_chainId', []);
nb(`chain id            ${Number(big(chainId.slice(2).padStart(64, '0')))}`);

const canLaunchHex = await rpc('eth_call', [
  { to: FACTORY, data: selector('canLaunch(address)') + padAddr(WALLET) }, 'latest']);
if (canLaunchHex.__err) no(`canLaunch reverted: ${canLaunchHex.__err.message}`);
else (big(word(canLaunchHex, 0)) !== 0n ? ok : no)(`canLaunch(${WALLET})`);

const feeHex = await rpc('eth_call', [{ to: FACTORY, data: selector('launchFee()') }, 'latest']);
const launchFee = big(word(feeHex, 0));
nb(`launchFee           ${fmtEth(launchFee)} ETH`);

const maxTaxHex = await rpc('eth_call', [{ to: FACTORY, data: selector('maxCreatorTaxBps()') }, 'latest']);
const maxTax = Number(big(word(maxTaxHex, 0)));
(CREATOR_TAX_BPS <= maxTax ? ok : no)(
  `creatorTaxBps ${CREATOR_TAX_BPS} against cap ${maxTax}` +
  (CREATOR_TAX_BPS > maxTax ? ` ${C.r}— would revert CreatorTaxTooHigh${C.x}` : ''));

const balHex = await rpc('eth_getBalance', [WALLET, 'latest']);
const bal = BigInt(balHex);
nb(`wallet balance      ${fmtEth(bal)} ETH`);
(bal > launchFee ? ok : no)(`balance covers the ${fmtEth(launchFee)} ETH fee`);

// Pin the economics. If the owner edits the config between this read and the
// real transaction, the launch reverts rather than settling on other terms.
const ecoHex = await rpc('eth_call', [{
  to: FACTORY,
  data: selector('previewLaunchEconomics(uint256,address)') + padNum(0) + padAddr(NATIVE),
}, 'latest']);
if (ecoHex.__err) { no(`previewLaunchEconomics: ${ecoHex.__err.message}`); process.exit(1); }
const expectedEconomics = '0x' + word(ecoHex, 0);
ok(`economics pin       ${expectedEconomics}`);

/* ----------------------------------------------------------------- the call */

const salt = SALT ?? '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

const params = {
  name: NAME,
  symbol: SYMBOL,
  logo: LOGO,
  description: DESCRIPTION,
  ...SOCIALS,
  creatorFeeRecipient: WALLET,
  creatorTaxBps: CREATOR_TAX_BPS,
  buybackEnabled: BUYBACK,
  expectedEconomics,
  salt,
};

const encoded = encTokenParams(params);
// Three top-level args, the first dynamic, so its offset is 3 words in.
const calldata = selector('launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)')
  + padNum(96) + padNum(0) + padAddr(NATIVE) + encoded;

console.log(`\n${C.b}metadata this launch would write onchain${C.x}`);
nb(`name                ${NAME}`);
nb(`symbol              ${SYMBOL}`);
nb(`logo                ${LOGO}`);
nb(`description         ${DESCRIPTION.length} chars`);
nb(`website             ${SOCIALS.website}`);
nb(`twitter             ${SOCIALS.twitter}`);
nb(`creatorFeeRecipient ${WALLET}`);
nb(`creatorTaxBps       ${CREATOR_TAX_BPS}  (${CREATOR_TAX_BPS / 100}%)`);
nb(`buybackEnabled      ${BUYBACK}`);
nb(`salt                ${salt}`);
nb(`calldata            ${(calldata.length - 2) / 2} bytes`);

/* ------------------------------------------------------------- simulate it */

console.log(`\n${C.b}simulation${C.x}`);

const tx = { from: WALLET, to: FACTORY, data: calldata, value: '0x' + launchFee.toString(16) };

const sim = await rpc('eth_call', [tx, 'latest']);
if (sim.__err) {
  no(`the real transaction WOULD REVERT`);
  console.log(`\n  ${C.r}${sim.__err.message}${C.x}`);
  if (sim.__err.data) console.log(`  data ${sim.__err.data}`);
  console.log(`\n  ${C.y}nothing was sent. fix the cause above before launching.${C.x}\n`);
  process.exit(1);
}

ok('the call succeeds — the real transaction would go through');
const token = toChecksum('0x' + word(sim, 0).slice(24));
const curve = toChecksum('0x' + word(sim, 1).slice(24));
console.log(`\n  ${C.b}token would deploy at${C.x}  ${C.g}${token}${C.x}`);
console.log(`  ${C.b}curve would deploy at${C.x}  ${curve}`);

const gas = await rpc('eth_estimateGas', [tx]);
if (gas.__err) no(`gas estimate failed: ${gas.__err.message}`);
else {
  const g = BigInt(gas);
  const priceHex = await rpc('eth_gasPrice', []);
  const price = BigInt(priceHex);
  nb(`gas                 ${g} units at ${fmtEth(price * 1000000000n)} gwei`);
  nb(`gas cost            ${fmtEth(g * price)} ETH`);
  nb(`total outlay        ${fmtEth(g * price + launchFee)} ETH`);
}

// Addresses are CREATE2-derived, so the same salt reproduces the same result.
// Reusing a salt with identical terms reverts, which is what makes this safe
// to hand back for the real transaction.
console.log(`\n${C.b}to send this for real${C.x}
  the calldata below goes to ${FACTORY}
  with value ${fmtEth(launchFee)} ETH, signed by ${WALLET}.

  ${C.d}reuse the same salt to land on the predicted address:${C.x}
  --salt ${salt}
`);

const out = `/tmp/pons-launch-calldata.txt`;
await (await import('node:fs/promises')).writeFile(out, calldata + '\n');
nb(`calldata written to ${out}`);
console.log();
