// keccak-256, because node's crypto only offers the NIST SHA-3 padding and
// Ethereum needs the original. Used for EIP-55 checksums and function
// selectors. A plain BigInt implementation is fast enough for both.

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

// The rho rotation offsets, r[x][y], from the Keccak reference spec.
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
    const Cc = new Array(5);
    for (let x = 0; x < 5; x++) {
      Cc[x] = A[at(x, 0)] ^ A[at(x, 1)] ^ A[at(x, 2)] ^ A[at(x, 3)] ^ A[at(x, 4)];
    }
    for (let x = 0; x < 5; x++) {
      const D = Cc[(x + 4) % 5] ^ rotl(Cc[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) A[at(x, y)] ^= D;
    }
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[at(y, (2 * x + 3 * y) % 5)] = rotl(A[at(x, y)], R[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[at(x, y)] = B[at(x, y)] ^ (~B[at((x + 1) % 5, y)] & B[at((x + 2) % 5, y)]) & MASK;
      }
    }
    A[0] ^= RC[round];
  }
  return A;
}

export function keccak256(bytes) {
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

export const keccakHex = (s) => keccak256(new TextEncoder().encode(s));

// The first four bytes of the hash of a canonical signature.
export const selector = (sig) => '0x' + keccakHex(sig).slice(0, 8);

export function toChecksum(lower) {
  const body = lower.slice(2);
  const hash = keccakHex(body);
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

// Never trust a hash function without vectors. Callers run this before relying
// on anything above, because a wrong selector silently calls the wrong function.
export function selfTest(die = (m) => { throw new Error(m); }) {
  const vectors = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    ['testing', '5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02'],
  ];
  for (const [input, want] of vectors) {
    const got = keccakHex(input);
    if (got !== want) die(`keccak self-test failed for "${input}"\n  want ${want}\n  got  ${got}`);
  }
  // EIP-55 vectors from the spec.
  for (const a of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    const got = toChecksum(a.toLowerCase());
    if (got !== a) die(`EIP-55 self-test failed\n  want ${a}\n  got  ${got}`);
  }
  // Known selectors, which prove the signature hashing path too.
  for (const [sig, want] of [
    ['name()', '0x06fdde03'],
    ['symbol()', '0x95d89b41'],
    ['decimals()', '0x313ce567'],
    ['totalSupply()', '0x18160ddd'],
    ['balanceOf(address)', '0x70a08231'],
    ['transfer(address,uint256)', '0xa9059cbb'],
  ]) {
    const got = selector(sig);
    if (got !== want) die(`selector self-test failed for ${sig}\n  want ${want}\n  got  ${got}`);
  }
}
