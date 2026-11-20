// Jupiter's 3DS textures (.jtex, LZ11-compressed): only used for colour statistics of the game's own board
// textures, so the pack can imitate the original colours. Pixel order (3DS tiling) does not matter for that.
import { lz11 } from './ctr';

export type RGBA = [number, number, number, number];

/** decoded opaque-or-not pixels, or null for formats MomoGram can't read with certainty */
export function jtexPixels(file: Uint8Array): RGBA[] | null {
  let d: Uint8Array;
  try { d = lz11(file); } catch { return null; }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  // two header layouts: older games [fmt, w, h, W, H] + data at 0x14; later ones 0x80-byte header with fmt at 4
  const newHdr = v.getUint32(0, true) === 0x80;
  const fmt = v.getUint32(newHdr ? 4 : 0, true);
  const W = v.getUint32(newHdr ? 16 : 12, true), H = v.getUint32(newHdr ? 20 : 16, true);
  const off = newHdr ? 0x80 : 0x14;
  const n = W * H;
  const out: RGBA[] = [];
  if (fmt === 2 && off + n * 4 <= d.length) for (let i = 0; i < n; i++) { const o = off + i * 4; out.push([d[o + 3], d[o + 2], d[o + 1], d[o]]); }
  else if (fmt === 3 && off + n * 3 <= d.length) for (let i = 0; i < n; i++) { const o = off + i * 3; out.push([d[o + 2], d[o + 1], d[o], 255]); }
  else if (fmt === 6 && off + n * 2 <= d.length) for (let i = 0; i < n; i++) {
    const x = v.getUint16(off + i * 2, true);
    out.push([((x >> 11) & 31) * 255 / 31 | 0, ((x >> 5) & 63) * 255 / 63 | 0, (x & 31) * 255 / 31 | 0, 255]);
  } else return null;
  return out;
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('');

/** most common opaque colours (4-bit buckets, averaged), most common first */
export function dominantColors(px: RGBA[], n = 4): Array<{ hex: string; rgb: [number, number, number]; share: number }> {
  const buckets = new Map<number, { c: number; r: number; g: number; b: number }>();
  let total = 0;
  for (const [r, g, b, a] of px) {
    if (a < 200) continue;
    total++;
    const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    const e = buckets.get(k) ?? { c: 0, r: 0, g: 0, b: 0 };
    e.c++; e.r += r; e.g += g; e.b += b;
    buckets.set(k, e);
  }
  return [...buckets.values()].sort((a, b) => b.c - a.c).slice(0, n)
    .map(e => ({ hex: hex(e.r / e.c, e.g / e.c, e.b / e.c), rgb: [e.r / e.c, e.g / e.c, e.b / e.c] as [number, number, number], share: e.c / Math.max(1, total) }));
}

/**
 * A jtex as a picture in image order (8×8 tiles, Z-order inside a tile). Pixel formats as confirmed by looking at
 * the games: 2 RGBA8, 3 RGB8, 4 RGBA4444, 5 and 6 RGB565. Textures with the older 0x14-byte header are stored
 * bottom-up.
 */
export function jtexImage(file: Uint8Array): { w: number; h: number; rgba: Uint8Array } | null {
  let d: Uint8Array;
  try { d = lz11(file); } catch { return null; }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const newHdr = v.getUint32(0, true) === 0x80, o4 = newHdr ? 4 : 0, off = newHdr ? 0x80 : 0x14;
  const fmt = v.getUint32(o4, true), w = v.getUint32(o4 + 4, true), h = v.getUint32(o4 + 8, true), W = v.getUint32(o4 + 12, true), H = v.getUint32(o4 + 16, true);
  const bpp = fmt === 2 ? 4 : fmt === 3 ? 3 : fmt === 4 || fmt === 5 || fmt === 6 ? 2 : 0;
  if (!bpp || !w || !h || W % 8 || H % 8 || w > W || h > H || off + W * H * bpp > d.length) return null;
  const out = new Uint8Array(w * h * 4);
  for (let k = 0; k < W * H; k++) {
    const t = k >> 6, i = k & 63;
    const x = (t % (W / 8)) * 8 + ((i & 1) | ((i >> 1) & 2) | ((i >> 2) & 4));
    let y = Math.floor(t / (W / 8)) * 8 + (((i >> 1) & 1) | ((i >> 2) & 2) | ((i >> 3) & 4));
    if (!newHdr) y = H - 1 - y;
    if (x >= w || y >= h) continue;
    const o = off + k * bpp, p = (y * w + x) * 4;
    if (fmt === 2) { out[p] = d[o + 3]; out[p + 1] = d[o + 2]; out[p + 2] = d[o + 1]; out[p + 3] = d[o]; }
    else if (fmt === 3) { out[p] = d[o + 2]; out[p + 1] = d[o + 1]; out[p + 2] = d[o]; out[p + 3] = 255; }
    else {
      const c = d[o] | (d[o + 1] << 8);
      if (fmt === 4) { out[p] = (c >> 12 & 15) * 17; out[p + 1] = (c >> 8 & 15) * 17; out[p + 2] = (c >> 4 & 15) * 17; out[p + 3] = (c & 15) * 17; }
      else { out[p] = (c >> 11 & 31) * 255 / 31; out[p + 1] = (c >> 5 & 63) * 255 / 63; out[p + 2] = (c & 31) * 255 / 31; out[p + 3] = 255; }
    }
  }
  return { w, h, rgba: out };
}

/** several pictures in one asset: u32 count, then per picture u16 key length, key (utf-8), u16 w, u16 h, RGBA */
export function packPictures(list: Array<{ key: string; w: number; h: number; rgba: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const keys = list.map(p => enc.encode(p.key));
  const size = 4 + list.reduce((a, p, i) => a + 2 + keys[i].length + 4 + p.rgba.length, 0);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  v.setUint32(0, list.length, true);
  let o = 4;
  list.forEach((p, i) => {
    v.setUint16(o, keys[i].length, true); out.set(keys[i], o + 2); o += 2 + keys[i].length;
    v.setUint16(o, p.w, true); v.setUint16(o + 2, p.h, true); o += 4;
    out.set(p.rgba, o); o += p.rgba.length;
  });
  return out;
}
export function unpackPictures(d: Uint8Array): Map<string, { w: number; h: number; rgba: Uint8Array }> {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength), dec = new TextDecoder();
  const m = new Map<string, { w: number; h: number; rgba: Uint8Array }>();
  let o = 4;
  for (let n = v.getUint32(0, true); n > 0 && o < d.length; n--) {
    const kl = v.getUint16(o, true), key = dec.decode(d.subarray(o + 2, o + 2 + kl)); o += 2 + kl;
    const w = v.getUint16(o, true), h = v.getUint16(o + 2, true); o += 4;
    m.set(key, { w, h, rgba: d.slice(o, o + w * h * 4) }); o += w * h * 4;
  }
  return m;
}
