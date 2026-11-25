// MomoGram shared reader: an embedded Unity Texture2D (class 28) as rows of RGB pixels.
//
// The puzzle "image" textures are stored inline in a serialized file (no .resS): each
// Texture2D object starts with its m_Name, then the texture layout, and the raw pixel
// data ("complete image") at the *end* of the object. We need the rows for the nonogram
// engines that generate the grid from a black/white picture (SherloCAT Holmes Nonogram,
// Paint it Back, …).
//
// Works for the two layouts we met so far:
//   - modern Unity (2017+):  m_ForcedFallbackFormat(s32) m_DownscaleFallback(bool)+pad
//                            m_Width m_Height m_CompleteImageSize m_TextureFormat
//   - older Unity 4.x:       (no type tree) m_Width right after the name, then m_Height,
//                            m_CompleteImageSize, m_TextureFormat
// The best candidate is the one whose w/h are plausible and whose m_TextureFormat is a
// known Unity format.
//
// Registry note: join this with unity.ts (same serialized-file parsing). Kept separate so
// the existing unity.ts stays untouched.

import { UObject } from './unity';

/** Parse the first field of any Unity object: its m_Name string. */
export function objectName(o: UObject): string | null {
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, true);
  if (!(len > 0 && len < 200 && 4 + len <= d.length)) return null;
  return new TextDecoder().decode(d.subarray(4, 4 + len));
}

/**
 * Width and height of a Texture2D object, plus its Unity TextureFormat id and the raw
 * size of the embedded image blob (m_CompleteImageSize, in bytes) when present.
 * Tries the old 4.x layout first (w right after the name pad), then the modern one that
 * has the two extra fields (m_ForcedFallbackFormat, m_DownscaleFallback).
 */
export function textureSize(o: UObject): { w: number; h: number; format: number; complete?: number } | null {
  const d = o.data;
  const nameLen = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, true);
  if (!(nameLen > 0 && nameLen < 200)) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const read = (p: number) => p + 4 <= d.length ? dv.getInt32(p, true) : -1;
  let base = (4 + nameLen + 3) & ~3;
  if (base + 16 > d.length) return null;
  // candidate 1: old Unity 4.x layout (w right after the name pad)
  const w1 = read(base), h1 = read(base + 4), size1 = read(base + 8), fmt1 = read(base + 12);
  // candidate 2: modern layout (m_ForcedFallbackFormat + m_DownscaleFallback before w)
  base += 4; base += 1; base = (base + 3) & ~3;
  if (base + 16 > d.length) return plausible(w1, h1) ? { w: w1, h: h1, format: fmt1, complete: size1 > 0 ? size1 : undefined } : null;
  const w2 = read(base), h2 = read(base + 4), size2 = read(base + 8), fmt2 = read(base + 12);
  const ok1 = plausible(w1, h1), ok2 = plausible(w2, h2);
  if (ok1 && ok2) {
    // prefer the layout whose completeImageSize matches the cell area (w*h*bpp)
    const s1 = sizeFits(w1, h1, size1, fmt1), s2 = sizeFits(w2, h2, size2, fmt2);
    if (s1 && !s2) return { w: w1, h: h1, format: fmt1, complete: size1 > 0 ? size1 : undefined };
    if (s2 && !s1) return { w: w2, h: h2, format: fmt2, complete: size2 > 0 ? size2 : undefined };
    // complete is often absent; a known uncompressed format wins. A tie keeps the Unity 4.x
    // layout (width right after the name). 2017+ only wins when its byte size matches and the old one does not.
    const k1 = RGB_BPP[fmt1] != null, k2 = RGB_BPP[fmt2] != null;
    if (k2 && !k1) return { w: w2, h: h2, format: fmt2, complete: size2 > 0 ? size2 : undefined };
    return { w: w1, h: h1, format: fmt1, complete: size1 > 0 ? size1 : undefined };
  }
  if (ok1) return { w: w1, h: h1, format: fmt1, complete: size1 > 0 ? size1 : undefined };
  if (ok2) return { w: w2, h: h2, format: fmt2, complete: size2 > 0 ? size2 : undefined };
  return null;
}
function sizeFits(w: number, h: number, size: number, fmt: number): boolean {
  const bpp = RGB_BPP[fmt];
  if (!bpp || size <= 0 || w <= 0 || h <= 0) return false;
  const raw = w * h * bpp;
  // mip0 exactly, or mip0 plus the smaller chain (about a third more) and a little padding
  return size === raw || (size > raw && size <= raw + Math.floor(raw / 3) + 64);
}
function plausible(w: number, h: number): boolean { return w > 0 && h > 0 && w <= 4096 && h <= 4096; }

/** Unity TextureFormat → bytes per pixel, for formats we can turn into RGB24.
 *  1 Alpha8, 2 ARGB4444, 3 RGB24, 4 RGBA32, 5 ARGB32, 7 RGB565, 13 RGBA4444.
 *  9 is R16, 10 is DXT1, 15 is RHalf — not these layouts. */
const RGB_BPP: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 4,
  7: 2,
  13: 2,
};
/**
 * Raw RGB24 rows of an inline Texture2D object (width*height RGB bytes, row-major).
 * The tail length depends on the format: w*h*bpp, with the "complete image" at the very
 * end of the object (path=="" means the pixels are inline, no .resS).
 * Returns null for formats we cannot decode or when the tail doesn't add up.
 */
export function textureRgb24(o: UObject, w: number, h: number, format = 3, complete?: number): Uint8Array | null {
  const d = o.data;
  const area = w * h;
  const bpp = RGB_BPP[format];
  // DXT1 (10), R16 (9), RHalf (15) and every other compressed format are rejected, not read as raw RGB.
  if (bpp == null || area <= 0) return null;
  const want = area * bpp;
  let px: Uint8Array | null = null;
  // Prefer the exact blob position (m_CompleteImageSize). Unity keeps the embedded image at
  // the end of the object; mip0 (the full-resolution level) is its first part, downscaled
  // mips or padding follow. Fall back to the plain tail.
  if (complete && complete > 0 && complete <= d.length) {
    const start = d.length - complete;
    if (start + want <= d.length) px = d.subarray(start, start + want);
  }
  if (!px) {
    const tailStart = d.length - want;
    if (want > 0 && tailStart >= 0 && tailStart >= 12 && tailStart <= 600) px = d.subarray(tailStart, d.length);
  }
  if (!px) return null;
  switch (format) {
    case 3: return px;
    case 1: return gray(px);
    case 4: return rgba32(px);
    case 5: return argb32(px);
    case 7: return rgb565(px);
    case 2: return argb4444(px);
    case 13: return rgba4444(px);
    default: return null;
  }
}
function gray(px: Uint8Array): Uint8Array {
  const out = new Uint8Array(px.length * 3);
  for (let i = 0; i < px.length; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = px[i];
  return out;
}
function rgba32(px: Uint8Array): Uint8Array {
  const n = px.length >> 2, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = px[i * 4]; out[i * 3 + 1] = px[i * 4 + 1]; out[i * 3 + 2] = px[i * 4 + 2]; }
  return out;
}
function argb32(px: Uint8Array): Uint8Array {
  const n = px.length >> 2, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = px[i * 4 + 1]; out[i * 3 + 1] = px[i * 4 + 2]; out[i * 3 + 2] = px[i * 4 + 3]; }
  return out;
}
function rgb565(px: Uint8Array): Uint8Array {
  const n = px.length >> 1, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = px[i * 2] | (px[i * 2 + 1] << 8);
    let r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    out[i * 3] = (r << 3) | (r >> 2); out[i * 3 + 1] = (g << 2) | (g >> 4); out[i * 3 + 2] = (b << 3) | (b >> 2);
  }
  return out;
}
function argb4444(px: Uint8Array): Uint8Array {
  const n = px.length >> 1, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = px[i * 2] | (px[i * 2 + 1] << 8);
    const r = (v >> 8) & 15, g = (v >> 4) & 15, b = v & 15;
    out[i * 3] = (r << 4) | r; out[i * 3 + 1] = (g << 4) | g; out[i * 3 + 2] = (b << 4) | b;
  }
  return out;
}
function rgba4444(px: Uint8Array): Uint8Array {
  const n = px.length >> 1, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = px[i * 2] | (px[i * 2 + 1] << 8);
    const r = (v >> 12) & 15, g = (v >> 8) & 15, b = (v >> 4) & 15;
    out[i * 3] = (r << 4) | r; out[i * 3 + 1] = (g << 4) | g; out[i * 3 + 2] = (b << 4) | b;
  }
  return out;
}

/**
 * Rows of a picture. By default a cell is filled when it is not near-white.
 * blackOnly: filled only when the pixel is near black (a coloured hint pixel stays empty).
 * flipY: the file stores the bottom row first, and the game's grid has row 0 at the top.
 */
export function gridFromTexture(o: UObject, w: number, h: number, format = 3, complete?: number, whiteThreshold = 200, flipY = false, blackOnly = false): boolean[][] | null {
  const px = textureRgb24(o, w, h, format, complete);
  if (!px) return null;
  const rows: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < w; x++) {
      const b = y * w + x, r = px[b * 3], g = px[b * 3 + 1], bl = px[b * 3 + 2];
      row.push(blackOnly ? r < 16 && g < 16 && bl < 16 : !(r > whiteThreshold && g > whiteThreshold && bl > whiteThreshold));
    }
    rows.push(row);
  }
  if (flipY) rows.reverse();
  return rows;
}
