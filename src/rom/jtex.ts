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
