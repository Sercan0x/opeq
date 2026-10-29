const RC = new Int32Array([
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
]);

const S = new Int32Array(50);
const RATE = 136;

function permute() {
  let a0l = S[0], a0h = S[1], a1l = S[2], a1h = S[3], a2l = S[4], a2h = S[5], a3l = S[6], a3h = S[7], a4l = S[8], a4h = S[9], a5l = S[10], a5h = S[11], a6l = S[12], a6h = S[13], a7l = S[14], a7h = S[15], a8l = S[16], a8h = S[17], a9l = S[18], a9h = S[19], a10l = S[20], a10h = S[21], a11l = S[22], a11h = S[23], a12l = S[24], a12h = S[25], a13l = S[26], a13h = S[27], a14l = S[28], a14h = S[29], a15l = S[30], a15h = S[31], a16l = S[32], a16h = S[33], a17l = S[34], a17h = S[35], a18l = S[36], a18h = S[37], a19l = S[38], a19h = S[39], a20l = S[40], a20h = S[41], a21l = S[42], a21h = S[43], a22l = S[44], a22h = S[45], a23l = S[46], a23h = S[47], a24l = S[48], a24h = S[49];
  for (let round = 0; round < 48; round += 2) {
    const c0l = a0l ^ a5l ^ a10l ^ a15l ^ a20l, c0h = a0h ^ a5h ^ a10h ^ a15h ^ a20h;
    const c1l = a1l ^ a6l ^ a11l ^ a16l ^ a21l, c1h = a1h ^ a6h ^ a11h ^ a16h ^ a21h;
    const c2l = a2l ^ a7l ^ a12l ^ a17l ^ a22l, c2h = a2h ^ a7h ^ a12h ^ a17h ^ a22h;
    const c3l = a3l ^ a8l ^ a13l ^ a18l ^ a23l, c3h = a3h ^ a8h ^ a13h ^ a18h ^ a23h;
    const c4l = a4l ^ a9l ^ a14l ^ a19l ^ a24l, c4h = a4h ^ a9h ^ a14h ^ a19h ^ a24h;
    const d0l = c4l ^ ((c1l << 1) | (c1h >>> 31)), d0h = c4h ^ ((c1h << 1) | (c1l >>> 31));
    const d1l = c0l ^ ((c2l << 1) | (c2h >>> 31)), d1h = c0h ^ ((c2h << 1) | (c2l >>> 31));
    const d2l = c1l ^ ((c3l << 1) | (c3h >>> 31)), d2h = c1h ^ ((c3h << 1) | (c3l >>> 31));
    const d3l = c2l ^ ((c4l << 1) | (c4h >>> 31)), d3h = c2h ^ ((c4h << 1) | (c4l >>> 31));
    const d4l = c3l ^ ((c0l << 1) | (c0h >>> 31)), d4h = c3h ^ ((c0h << 1) | (c0l >>> 31));
    const t0l = a0l ^ d0l, t0h = a0h ^ d0h;
    const t1l = a1l ^ d1l, t1h = a1h ^ d1h;
    const t2l = a2l ^ d2l, t2h = a2h ^ d2h;
    const t3l = a3l ^ d3l, t3h = a3h ^ d3h;
    const t4l = a4l ^ d4l, t4h = a4h ^ d4h;
    const t5l = a5l ^ d0l, t5h = a5h ^ d0h;
    const t6l = a6l ^ d1l, t6h = a6h ^ d1h;
    const t7l = a7l ^ d2l, t7h = a7h ^ d2h;
    const t8l = a8l ^ d3l, t8h = a8h ^ d3h;
    const t9l = a9l ^ d4l, t9h = a9h ^ d4h;
    const t10l = a10l ^ d0l, t10h = a10h ^ d0h;
    const t11l = a11l ^ d1l, t11h = a11h ^ d1h;
    const t12l = a12l ^ d2l, t12h = a12h ^ d2h;
    const t13l = a13l ^ d3l, t13h = a13h ^ d3h;
    const t14l = a14l ^ d4l, t14h = a14h ^ d4h;
    const t15l = a15l ^ d0l, t15h = a15h ^ d0h;
    const t16l = a16l ^ d1l, t16h = a16h ^ d1h;
    const t17l = a17l ^ d2l, t17h = a17h ^ d2h;
    const t18l = a18l ^ d3l, t18h = a18h ^ d3h;
    const t19l = a19l ^ d4l, t19h = a19h ^ d4h;
    const t20l = a20l ^ d0l, t20h = a20h ^ d0h;
    const t21l = a21l ^ d1l, t21h = a21h ^ d1h;
    const t22l = a22l ^ d2l, t22h = a22h ^ d2h;
    const t23l = a23l ^ d3l, t23h = a23h ^ d3h;
    const t24l = a24l ^ d4l, t24h = a24h ^ d4h;
    const b0l = t0l, b0h = t0h;
    const b10l = (t1l << 1) | (t1h >>> 31), b10h = (t1h << 1) | (t1l >>> 31);
    const b20l = (t2h << 30) | (t2l >>> 2), b20h = (t2l << 30) | (t2h >>> 2);
    const b5l = (t3l << 28) | (t3h >>> 4), b5h = (t3h << 28) | (t3l >>> 4);
    const b15l = (t4l << 27) | (t4h >>> 5), b15h = (t4h << 27) | (t4l >>> 5);
    const b16l = (t5h << 4) | (t5l >>> 28), b16h = (t5l << 4) | (t5h >>> 28);
    const b1l = (t6h << 12) | (t6l >>> 20), b1h = (t6l << 12) | (t6h >>> 20);
    const b11l = (t7l << 6) | (t7h >>> 26), b11h = (t7h << 6) | (t7l >>> 26);
    const b21l = (t8h << 23) | (t8l >>> 9), b21h = (t8l << 23) | (t8h >>> 9);
    const b6l = (t9l << 20) | (t9h >>> 12), b6h = (t9h << 20) | (t9l >>> 12);
    const b7l = (t10l << 3) | (t10h >>> 29), b7h = (t10h << 3) | (t10l >>> 29);
    const b17l = (t11l << 10) | (t11h >>> 22), b17h = (t11h << 10) | (t11l >>> 22);
    const b2l = (t12h << 11) | (t12l >>> 21), b2h = (t12l << 11) | (t12h >>> 21);
    const b12l = (t13l << 25) | (t13h >>> 7), b12h = (t13h << 25) | (t13l >>> 7);
    const b22l = (t14h << 7) | (t14l >>> 25), b22h = (t14l << 7) | (t14h >>> 25);
    const b23l = (t15h << 9) | (t15l >>> 23), b23h = (t15l << 9) | (t15h >>> 23);
    const b8l = (t16h << 13) | (t16l >>> 19), b8h = (t16l << 13) | (t16h >>> 19);
    const b18l = (t17l << 15) | (t17h >>> 17), b18h = (t17h << 15) | (t17l >>> 17);
    const b3l = (t18l << 21) | (t18h >>> 11), b3h = (t18h << 21) | (t18l >>> 11);
    const b13l = (t19l << 8) | (t19h >>> 24), b13h = (t19h << 8) | (t19l >>> 24);
    const b14l = (t20l << 18) | (t20h >>> 14), b14h = (t20h << 18) | (t20l >>> 14);
    const b24l = (t21l << 2) | (t21h >>> 30), b24h = (t21h << 2) | (t21l >>> 30);
    const b9l = (t22h << 29) | (t22l >>> 3), b9h = (t22l << 29) | (t22h >>> 3);
    const b19l = (t23h << 24) | (t23l >>> 8), b19h = (t23l << 24) | (t23h >>> 8);
    const b4l = (t24l << 14) | (t24h >>> 18), b4h = (t24h << 14) | (t24l >>> 18);
    a0l = b0l ^ (~b1l & b2l); a0h = b0h ^ (~b1h & b2h);
    a1l = b1l ^ (~b2l & b3l); a1h = b1h ^ (~b2h & b3h);
    a2l = b2l ^ (~b3l & b4l); a2h = b2h ^ (~b3h & b4h);
    a3l = b3l ^ (~b4l & b0l); a3h = b3h ^ (~b4h & b0h);
    a4l = b4l ^ (~b0l & b1l); a4h = b4h ^ (~b0h & b1h);
    a5l = b5l ^ (~b6l & b7l); a5h = b5h ^ (~b6h & b7h);
    a6l = b6l ^ (~b7l & b8l); a6h = b6h ^ (~b7h & b8h);
    a7l = b7l ^ (~b8l & b9l); a7h = b7h ^ (~b8h & b9h);
    a8l = b8l ^ (~b9l & b5l); a8h = b8h ^ (~b9h & b5h);
    a9l = b9l ^ (~b5l & b6l); a9h = b9h ^ (~b5h & b6h);
    a10l = b10l ^ (~b11l & b12l); a10h = b10h ^ (~b11h & b12h);
    a11l = b11l ^ (~b12l & b13l); a11h = b11h ^ (~b12h & b13h);
    a12l = b12l ^ (~b13l & b14l); a12h = b12h ^ (~b13h & b14h);
    a13l = b13l ^ (~b14l & b10l); a13h = b13h ^ (~b14h & b10h);
    a14l = b14l ^ (~b10l & b11l); a14h = b14h ^ (~b10h & b11h);
    a15l = b15l ^ (~b16l & b17l); a15h = b15h ^ (~b16h & b17h);
    a16l = b16l ^ (~b17l & b18l); a16h = b16h ^ (~b17h & b18h);
    a17l = b17l ^ (~b18l & b19l); a17h = b17h ^ (~b18h & b19h);
    a18l = b18l ^ (~b19l & b15l); a18h = b18h ^ (~b19h & b15h);
    a19l = b19l ^ (~b15l & b16l); a19h = b19h ^ (~b15h & b16h);
    a20l = b20l ^ (~b21l & b22l); a20h = b20h ^ (~b21h & b22h);
    a21l = b21l ^ (~b22l & b23l); a21h = b21h ^ (~b22h & b23h);
    a22l = b22l ^ (~b23l & b24l); a22h = b22h ^ (~b23h & b24h);
    a23l = b23l ^ (~b24l & b20l); a23h = b23h ^ (~b24h & b20h);
    a24l = b24l ^ (~b20l & b21l); a24h = b24h ^ (~b20h & b21h);
    a0l ^= RC[round]; a0h ^= RC[round + 1];
  }
  S[0] = a0l; S[1] = a0h;
  S[2] = a1l; S[3] = a1h;
  S[4] = a2l; S[5] = a2h;
  S[6] = a3l; S[7] = a3h;
  S[8] = a4l; S[9] = a4h;
  S[10] = a5l; S[11] = a5h;
  S[12] = a6l; S[13] = a6h;
  S[14] = a7l; S[15] = a7h;
  S[16] = a8l; S[17] = a8h;
  S[18] = a9l; S[19] = a9h;
  S[20] = a10l; S[21] = a10h;
  S[22] = a11l; S[23] = a11h;
  S[24] = a12l; S[25] = a12h;
  S[26] = a13l; S[27] = a13h;
  S[28] = a14l; S[29] = a14h;
  S[30] = a15l; S[31] = a15h;
  S[32] = a16l; S[33] = a16h;
  S[34] = a17l; S[35] = a17h;
  S[36] = a18l; S[37] = a18h;
  S[38] = a19l; S[39] = a19h;
  S[40] = a20l; S[41] = a20h;
  S[42] = a21l; S[43] = a21h;
  S[44] = a22l; S[45] = a22h;
  S[46] = a23l; S[47] = a23h;
  S[48] = a24l; S[49] = a24h;
}

function absorbByte(pos, v) {
  const lane = pos >> 3, k = pos & 7;
  if (k < 4) S[2 * lane] ^= v << (8 * k);
  else S[2 * lane + 1] ^= v << (8 * (k - 4));
}

export function keccak256(...parts) {
  S.fill(0);
  let pos = 0;
  for (const part of parts) {
    let i = 0;
    const n = part.length;
    while (i < n) {
      if ((pos & 3) === 0 && i + 4 <= n && pos + 4 <= RATE) {
        const w = part[i] | (part[i + 1] << 8) | (part[i + 2] << 16) | (part[i + 3] << 24);
        S[pos >> 2] ^= w;
        i += 4;
        pos += 4;
      } else {
        absorbByte(pos, part[i]);
        i++;
        pos++;
      }
      if (pos === RATE) { permute(); pos = 0; }
    }
  }
  absorbByte(pos, 0x01);
  absorbByte(RATE - 1, 0x80);
  permute();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = i >> 3, k = i & 7;
    out[i] = (k < 4 ? S[2 * lane] >>> (8 * k) : S[2 * lane + 1] >>> (8 * (k - 4))) & 0xff;
  }
  return out;
}
