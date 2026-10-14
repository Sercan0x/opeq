const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const Wbuf = new Int32Array(64);

function compress(H, block, off) {
  const W = Wbuf;
  for (let i = 0; i < 16; i++) {
    const j = off + 4 * i;
    W[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

export class Sha256 {
  constructor() {
    this.H = new Int32Array(IV);
    this.buf = new Uint8Array(64);
    this.len = 0;
    this.total = 0;
  }

  clone() {
    const c = new Sha256();
    c.H.set(this.H);
    c.buf.set(this.buf);
    c.len = this.len;
    c.total = this.total;
    return c;
  }

  update(data) {
    let i = 0;
    this.total += data.length;
    if (this.len) {
      const take = Math.min(64 - this.len, data.length);
      this.buf.set(data.subarray(0, take), this.len);
      this.len += take;
      i = take;
      if (this.len < 64) return this;
      compress(this.H, this.buf, 0);
      this.len = 0;
    }
    for (; i + 64 <= data.length; i += 64) compress(this.H, data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.len = data.length - i;
    }
    return this;
  }

  digest() {
    const c = this.clone();
    const bits = c.total * 8;
    const pad = new Uint8Array(((c.len < 56 ? 56 : 120) - c.len) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    const n = pad.length;
    pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
    const H = c.H, buf = c.buf;
    let len = c.len;
    for (let k = 0; k < pad.length; k++) {
      buf[len++] = pad[k];
      if (len === 64) { compress(H, buf, 0); len = 0; }
    }
    const out = new Uint8Array(32);
    for (let k = 0; k < 8; k++) {
      out[4 * k] = H[k] >>> 24; out[4 * k + 1] = H[k] >>> 16; out[4 * k + 2] = H[k] >>> 8; out[4 * k + 3] = H[k];
    }
    return out;
  }
}

export function sha256(...parts) {
  const h = new Sha256();
  for (const p of parts) h.update(p);
  return h.digest();
}

const oneH = new Int32Array(8);
const oneBlock = new Uint8Array(64);

export function sha256Short(msg, out, outLen = 32) {
  const n = msg.length;
  oneBlock.fill(0);
  oneBlock.set(msg);
  oneBlock[n] = 0x80;
  const bits = n * 8;
  oneBlock[62] = bits >>> 8;
  oneBlock[63] = bits & 0xff;
  oneH.set(IV);
  compress(oneH, oneBlock, 0);
  for (let k = 0; k < outLen; k++) out[k] = oneH[k >> 2] >>> (24 - 8 * (k & 3));
  return out;
}
