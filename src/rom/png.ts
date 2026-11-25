// PNG to RGBA, for game icons taken from the player's files (Android launcher icons). Every colour type and bit
// depth, palettes with transparency, and Adam7 interlacing; no colour management.
import { unzlibSync } from 'fflate';

export interface Rgba { w: number; h: number; px: Uint8Array }

export const isPng = (d: Uint8Array) => d.length > 33 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47;

export function decodePng(d: Uint8Array): Rgba | null {
  if (!isPng(d)) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20), depth = d[24], ctype = d[25], interlace = d[28];
  if (!w || !h || w > 4096 || h > 4096) return null;
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!chans) return null;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 12 <= d.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    const body = d.subarray(o + 8, o + 8 + len);
    if (type === 'IDAT') idat.push(body);
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  let raw: Uint8Array;
  try {
    const all = new Uint8Array(idat.reduce((a, b) => a + b.length, 0));
    let at = 0;
    for (const b of idat) { all.set(b, at); at += b.length; }
    raw = unzlibSync(all);
  } catch { return null; }
  const out = new Uint8Array(w * h * 4);
  const bpp = Math.max(1, (chans * depth) >> 3);
  const max = (1 << depth) - 1;
  let p = 0;
  // one (sub)image: unfilter its scanlines and write its pixels to (x0 + i*dx, y0 + j*dy)
  const pass = (x0: number, y0: number, dx: number, dy: number) => {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) return true;
    const stride = Math.ceil((pw * chans * depth) / 8);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let j = 0; j < ph; j++) {
      if (p + 1 + stride > raw.length) return false;
      const f = raw[p++];
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = raw[p + i];
        cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255;
      }
      p += stride;
      const sample = (k: number) => depth === 8 ? cur[k] : depth === 16 ? cur[k * 2] :
        (cur[(k * depth) >> 3] >> (8 - depth - ((k * depth) & 7))) & max;
      const scale = (v: number) => depth >= 8 ? v : Math.round((v * 255) / max);
      for (let i = 0; i < pw; i++) {
        const o = ((y0 + j * dy) * w + x0 + i * dx) * 4, k = i * chans;
        if (ctype === 3) {
          const v = sample(k);
          out[o] = plte?.[v * 3] ?? 0; out[o + 1] = plte?.[v * 3 + 1] ?? 0; out[o + 2] = plte?.[v * 3 + 2] ?? 0;
          out[o + 3] = trns && v < trns.length ? trns[v] : 255;
        } else if (ctype === 0 || ctype === 4) {
          const v = sample(k);
          out[o] = out[o + 1] = out[o + 2] = scale(v);
          out[o + 3] = ctype === 4 ? scale(sample(k + 1)) : trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === v ? 0 : 255;
        } else {
          out[o] = scale(sample(k)); out[o + 1] = scale(sample(k + 1)); out[o + 2] = scale(sample(k + 2));
          out[o + 3] = ctype === 6 ? scale(sample(k + 3)) : 255;
        }
      }
      [prev, cur] = [cur, prev];
    }
    return true;
  };
  const ok = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]].every(([a, b, c, e]) => pass(a, b, c, e))
    : pass(0, 0, 1, 1);
  return ok ? { w, h, px: out } : null;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** a smaller copy (area average, alpha-weighted) whose longer side is at most `max` pixels */
export function shrink(img: Rgba, max: number): Rgba {
  const s = Math.max(img.w, img.h) / max;
  if (s <= 1) return img;
  const w = Math.max(1, Math.round(img.w / s)), h = Math.max(1, Math.round(img.h / s));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor((x * img.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / w));
    const y0 = Math.floor((y * img.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / h));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.w + xx) * 4, al = img.px[i + 3];
      r += img.px[i] * al; g += img.px[i + 1] * al; b += img.px[i + 2] * al; a += al; n++;
    }
    const o = (y * w + x) * 4;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    out[o + 3] = Math.round(a / n);
  }
  return { w, h, px: out };
}

/** `top` drawn over `bottom` (same size; `top` is scaled to it when it differs) */
export function over(bottom: Rgba, top: Rgba): Rgba {
  const out = new Uint8Array(bottom.px);
  for (let y = 0; y < bottom.h; y++) for (let x = 0; x < bottom.w; x++) {
    const tx = Math.floor((x * top.w) / bottom.w), ty = Math.floor((y * top.h) / bottom.h);
    const t = (ty * top.w + tx) * 4, o = (y * bottom.w + x) * 4, a = top.px[t + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(top.px[t + c] * a + out[o + c] * (1 - a));
    out[o + 3] = Math.max(out[o + 3], top.px[t + 3]);
  }
  return { w: bottom.w, h: bottom.h, px: out };
}
