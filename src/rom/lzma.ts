// LZMA decoder (the raw "LZMA1" stream with a 5-byte properties header, as Unity asset bundles use it).
// Written from the LZMA specification in the public-domain LZMA SDK (lzma-specification.txt).

export function lzma(src: Uint8Array, outSize: number): Uint8Array {
  const props = src[0];
  const lc = props % 9, lp = Math.floor(props / 9) % 5, pb = Math.floor(props / 45);
  const out = new Uint8Array(outSize);
  let pos = 0;
  // range decoder
  let inp = 5, range = 0xffffffff, code = 0;
  for (let i = 0; i < 5; i++) code = ((code << 8) | src[inp++]) >>> 0;
  const normalize = () => { if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[inp++]) >>> 0; } };
  const bit = (p: Uint16Array, i: number): number => {
    const bound = (range >>> 11) * p[i];
    let b: number;
    if (code < bound) { range = bound; p[i] += (2048 - p[i]) >>> 5; b = 0; }
    else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; p[i] -= p[i] >>> 5; b = 1; }
    normalize();
    return b;
  };
  const direct = (n: number): number => {
    let r = 0;
    for (; n > 0; n--) { range >>>= 1; let t = 0; if (code >= range) { code = (code - range) >>> 0; t = 1; } r = ((r << 1) | t) >>> 0; normalize(); }
    return r;
  };
  const tree = (p: Uint16Array, base: number, bits: number) => { let m = 1; for (let i = 0; i < bits; i++) m = (m << 1) + bit(p, base + m); return m - (1 << bits); };
  const reverse = (p: Uint16Array, base: number, bits: number) => { let m = 1, sym = 0; for (let i = 0; i < bits; i++) { const b = bit(p, base + m); m = (m << 1) + b; sym |= b << i; } return sym; };
  const P = (n: number) => new Uint16Array(n).fill(1024);
  const literal = P(0x300 << (lc + lp));
  const isMatch = P(192), isRep = P(12), isRepG0 = P(12), isRepG1 = P(12), isRepG2 = P(12), isRep0Long = P(192);
  const posSlot = P(256), posDecoders = P(115), align = P(16);
  const lenCoder = () => ({ choice: P(2), low: P(256), mid: P(256), high: P(256) });
  const len = lenCoder(), repLen = lenCoder();
  const decLen = (c: ReturnType<typeof lenCoder>, ps: number) => {
    if (!bit(c.choice, 0)) return tree(c.low, ps << 3, 3);
    if (!bit(c.choice, 1)) return 8 + tree(c.mid, ps << 3, 3);
    return 16 + tree(c.high, 0, 8);
  };
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;
  while (pos < outSize) {
    const ps = pos & pbMask;
    if (!bit(isMatch, (state << 4) + ps)) {
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let match = out[pos - rep0 - 1];
        do {
          const mb = (match >> 7) & 1; match <<= 1;
          const b = bit(literal, base + ((1 + mb) << 8) + sym);
          sym = (sym << 1) | b;
          if (mb !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
      out[pos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let l: number;
    if (bit(isRep, state)) {
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + ps)) { state = state < 7 ? 9 : 11; out[pos] = out[pos - rep0 - 1]; pos++; continue; }
      } else {
        let dist: number;
        if (!bit(isRepG1, state)) dist = rep1;
        else { if (!bit(isRepG2, state)) dist = rep2; else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      l = decLen(repLen, ps);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      l = decLen(len, ps);
      state = state < 7 ? 7 : 10;
      const slot = tree(posSlot, Math.min(l, 3) << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const bits = (slot >> 1) - 1;
        let dist = ((2 | (slot & 1)) << bits) >>> 0;
        if (slot < 14) dist = (dist + reverse(posDecoders, dist - slot, bits)) >>> 0;
        else dist = (dist + ((direct(bits - 4) << 4) >>> 0) + reverse(align, 0, 4)) >>> 0;
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) break; // end marker
    }
    l += 2;
    for (let i = 0; i < l && pos < outSize; i++, pos++) out[pos] = out[pos - rep0 - 1];
  }
  return out;
}
