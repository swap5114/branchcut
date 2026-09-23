// SHA-256 (FIPS 180-4) in plain TypeScript, so the same repo code runs in the
// browser without the async WebCrypto API and in Node without node:crypto.

// Round constants: the first 32 bits of the fractional parts of the cube roots
// of the first 64 primes. Initial hash: the same for square roots of the first 8.
// Computing them is shorter than a table of 72 magic numbers, and the tests
// check the result against known hashes.
const primes: number[] = [];
for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
const frac32 = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = Uint32Array.from(primes, (p) => frac32(Math.cbrt(p)));
const H0 = Uint32Array.from(primes.slice(0, 8), (p) => frac32(Math.sqrt(p)));

const encoder = new TextEncoder();
const W = new Uint32Array(64);

export function sha256(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const n = bytes.length;
  // Padding: a 1 bit, zeros, then the length in bits as a 64-bit number, to a multiple of 64 bytes.
  const size = Math.ceil((n + 9) / 64) * 64;
  const buf = new Uint8Array(size);
  buf.set(bytes);
  buf[n] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(size - 8, Math.floor(n / 2 ** 29));
  view.setUint32(size - 4, (n * 8) >>> 0);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = H0;
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
