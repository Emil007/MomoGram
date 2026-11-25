// Nonogram Classic Games (com.coolmath.nonogram.classic.games, CoolMath) — nonogram puzzles, Android.
//
// The game ships its whole catalogue as Unity Texture2D sprites in one asset bundle:
//
//   assets/bin/Data/data.unity3d  (UnityFS bundle, LZ4)
//     - Texture2D  "WxH_<base>"           black-and-white solution mask (alpha ≥ 128 = filled), the
//                                          playable nonogram; fmt: RGBA32 (4) or ETC2_RGBA8 (47)
//     - Texture2D  "WxH_<base>_color"     full-colour completed illustration, shown in the Gallery /
//                                          win screen; NOT a playable colour-picross palette
//     - TextAsset  "Texts"                puzzle names in 5 languages (CSV, EN first)
//     - the game's UI MonoBehaviours (Board, BoardInput, LevelData, Gallery, DailyChallenge)
//
// Nothing else carries puzzles: there is no atlas descriptor, no content.db, no JSON. The colour
// `_color` textures are decorative (rendered works, 19+ anti-aliased shades on the 8×8 ones); the
// playable puzzles are the 73 black-and-white masks.
//
//   Catalogue (all 73, one mask + one colour sprite each)
//     5×5×1, 6×6×2, 7×7×2, 8×8×3, 9×9×2, 10×10×19, 15×15×24, 20×20×20
//
// Modes (verified in il2cpp metadata / per-pixel analysis):
//   NORMAL  ✓ 73 playable B/W puzzles (the masks).
//   COLOR   ✗ The `_color` textures are gallery illustrations, not colour puzzles: coloured cells
//            do not align with the masks (only 17/73 match a single-background bitmap exactly; the
//            rest have 2+ shades on empty cells — boat +101 cells, smile +72, yinyang +84) and there
//            is no per-cell palette channel. See ANALYSIS.md for the numbers.
//   MEGA    ✗ No Mega clues: il2cpp metadata has zero "mega"-like strings; the game's methods
//            (LevelData, Board, CreateRows, CheckFoundRowNumbers, ShowTileOriginalColors) hold no
//            line-pairing structure; no second clue set exists anywhere in the APK.
//
// Container-agnostic (owner requirement): detection and reading never gate on the file extension
// (.apk / .xapk / .apkm / .zip / an extracted folder). The real markers are
//   - the binary AndroidManifest.xml containing UTF-16LE "com.coolmath.nonogram.classic.games", and
//   - the Unity data.unity3d bundle whose Texture2Ds carry at least one puzzle mask (WxH_<base>
//     without `_color`) and the "Texts" TextAsset with the puzzle names.
// .xapk/.apkm/.zip are zips holding the base APK next to an ABI split; unwrapping recursively and
// matching the markers works for every distribution.
//
// Icon: the biggest launcher icon is res/mipmap-xxxhdpi-v4/ic_launcher.webp (WebP); the repo's icon
// loader is PNG-based, so the importer accepts a PNG copy wherever present, else null (the icon is
// extracted separately in _code/icons/).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, PackIcon } from '../format';
import { unzipSync } from 'fflate';
import { readBundle, readSerialized, textAsset, UObject } from '../../rom/unity';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.coolmath.nonogram.classic.games';
const PUZZLE_RE = /^(\d+)x(\d+)_([a-z0-9]+)(_color)?$/;

/** the marker set of Nonogram Classic Games: manifest package + Unity data.unity3d with puzzle masks. */
export function hasManifestPackage(entries: Entry[]): boolean {
  for (const e of entries) {
    if (!/^(AndroidManifest\.xml|META-INF\/?(manifest|.*manifest.*)\.xml)$/i.test(e.name)) continue;
    const d = e.data;
    const needle = new TextEncoder().encode(PKG);
    for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
      let all = true;
      for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
      if (all) return true;
    }
  }
  return false;
}

/** true when the entries carry the puzzle marker: a Unity data.unity3d bundle with puzzle masks + Texts. */
export function looksLike(entries: Entry[]): boolean {
  const bundle = entries.find(e => /^assets\/bin\/Data\/data\.unity3d$/i.test(e.name))?.data;
  if (!bundle) return false;
  try {
    const { masks, hasTexts } = scanBundle(bundle);
    return masks >= 3 && hasTexts;
  } catch { return false; }
}

/** count puzzle mask textures + presence of the Texts asset inside a data.unity3d bundle. */
function scanBundle(bundle: Uint8Array): { masks: number; hasTexts: boolean; serialized: Uint8Array[] } {
  let serialized = serializedFilesOf(bundle);
  let masks = 0, hasTexts = false;
  for (const ser of serialized) {
    const objs = readSerialized(ser);
    for (const o of objs) {
      if (o.classId === 28) {
        const name = objectNameOf(o);
        if (name && PUZZLE_RE.test(name)) {
          const m = PUZZLE_RE.exec(name)!;
          if (!m[4]) masks++;
        }
      } else if (o.classId === 49) {
        const t = textAsset(o);
        if (t && t.name === 'Texts') hasTexts = true;
      }
    }
  }
  return { masks, hasTexts, serialized };
}

function serializedFilesOf(bundle: Uint8Array): Uint8Array[] {
  // a UnityFS bundle: its non-resource nodes are serialized files
  try {
    const nodes = readBundle(bundle);
    const files: Uint8Array[] = [];
    for (const [n, v] of nodes) if (!/\.res(ource|S)$/i.test(n)) files.push(v);
    if (files.length) return files;
  } catch { /* not a bundle */ }
  // a plain serialized file
  return [bundle];
}

export function objectNameOf(o: UObject): string | null {
  if (o.classId !== 28) return null;
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, o.le ?? true);
  if (!(len > 0 && len < 256 && 4 + len <= d.length)) return null;
  return new TextDecoder().decode(d.subarray(4, 4 + len));
}

/** Unity TextureFormat ids used by the puzzle masks. */
const FMT_RGBA32 = 4, FMT_ETC2_RGBA8 = 47;

// ETC2 big-endian alpha read: the 8 alpha bytes are read as a little-endian u64 then byte-swapped.
const EAC_MOD = [
  [-3, -6, -9, -15, 2, 5, 8, 14], [-3, -7, -10, -13, 2, 6, 9, 12], [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12], [-3, -6, -8, -12, 2, 5, 7, 11], [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10], [-3, -5, -8, -11, 2, 4, 7, 10], [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9], [-2, -4, -8, -10, 1, 3, 7, 9], [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9], [-1, -2, -3, -10, 0, 1, 2, 9], [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];
// pixel i of the 4×4 block → row-major index (WriteOrderTableRev)
const EAC_ORDER = [15, 11, 7, 3, 14, 10, 6, 2, 13, 9, 5, 1, 12, 8, 4, 0];

function clampByte(n: number): number { return n < 0 ? 0 : n > 255 ? 255 : n; }

/** the filled/empty mask of an inline puzzle Texture2D object. The pixel data is the last
 * m_CompleteImageSize bytes before the object's zero padding (16 or 18 zero bytes): RGBA32 =
 * w*h*4 bytes straight; ETC2_RGBA8 = one 16-byte block per padded 4×4, whose first 8 bytes are
 * the EAC alpha sub-block (bytes 8-15 = RGB, not needed). alpha ≥ 128 = filled. Returns null
 * when the pixel region does not fit the expected size. */
export function maskOf(o: UObject, w: number, h: number, format: number): boolean[][] | null {
  const d = o.data;
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const comp = format === FMT_RGBA32 ? w * h * 4 : bw * bh * 16;
  // The puzzle textures all carry the inline image bytes right after the m_CompleteImageSize field.
  // That field's value equals `comp` and sits in the header near byte 100 (96..104 once the name
  // width shifts alignment). Find it and the pixels start 4 bytes later. This is deterministic and
  // correct for every mask texture (see ANALYSIS.md).
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let start = -1;
  const lo = 60, hi = Math.min(d.length - comp, 130);
  for (let p = lo; p + 4 <= hi; p++) {
    if (dv.getUint32(p, o.le ?? true) === comp) {
      start = p + 4;
      break;
    }
  }
  if (start < 0) return null;
  if (start + comp > d.length) return null;
  const px = d.subarray(start, start + comp);
  // The raw texture is stored bottom-up (OpenGL/Unity convention, matching UnityPy's `image` which
  // is the top-down display orientation). Build the grid row by row from the raw order, then flip
  // the row list so the first element is the puzzle's top row.
  const flip = true;
  const rows: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < w; x++) {
      let alpha: number;
      if (format === FMT_RGBA32) {
        alpha = px[(y * w + x) * 4 + 3];
      } else {
        const by = y >> 2, bx = x >> 2;
        const block = (by * bw + bx) * 16;
        if (block + 8 > px.length) { row.push(false); continue; }
        const a = px.subarray(block, block + 8);
        const b1 = a[1];
        if (b1 & 0xf0) { // multiplier != 0: EAC-modulated
          const mult = b1 >> 4;
          const table = EAC_MOD[b1 & 0xf];
          // Decode all 16 alphas in one pass, mirroring AssetStudio's decode_etc2a8_block:
          // pixel EAC_ORDER[i] gets the value read from the i-th 3-bit field of the big-endian
          // 8-byte alpha word. Read the 48-bit field with BigInt — a plain Number loses precision
          // above 2^53.
          let l = 0n;
          for (let k = 0; k < 8; k++) l = l * 256n + BigInt(a[k]);
          const alphas = new Array<number>(16);
          for (let i = 0; i < 16; i++) {
            const c = Number(l % 8n);
            alphas[EAC_ORDER[i]] = clampByte(a[0] + mult * table[c]);
            l /= 8n;
          }
          alpha = alphas[(y & 3) * 4 + (x & 3)];
        } else {
          alpha = a[0];
        }
      }
      row.push(alpha >= 128);
    }
    rows.push(row);
  }
  if (flip) rows.reverse();
  return rows;
}

/** parse the "WxH_<base>" / "WxH_<base>_color" name. */
function parsePuzzleName(name: string): { w: number; h: number; base: string; color: boolean } | null {
  const m = PUZZLE_RE.exec(name);
  if (!m) return null;
  return { w: +m[1], h: +m[2], base: m[3], color: !!m[4] };
}

/** a rows grid of the mask (true→'#') — helper for the level builder. */
function rowsFromMask(mask: boolean[][]): string[] {
  return mask.map(r => r.map(f => f ? '#' : '.').join(''));
}

// ---- icon ----
function pngRgba(d: Uint8Array): { w: number; h: number; rgba: ArrayBuffer } | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50) return null;
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024) || d[24] !== 8) return null;
  const ctype = d[25];
  let bpp = 0;
  if (ctype === 6) bpp = 4; else if (ctype === 2) bpp = 3; else if (ctype === 0) bpp = 1; else return null;
  // collect IDAT chunks, inflate (with the repo's own inflate helper)
  // (implementation below via a small inflate)
  return inflatePng(d, w, h, bpp);
}
// minimal zlib inflate via the repo's approach (the eyes importer used fflate's unzlibSync)
import { unzlibSync } from 'fflate';
function inflatePng(d: Uint8Array, w: number, h: number, bpp: number): { w: number; h: number; rgba: ArrayBuffer } | null {
  const idats: Uint8Array[] = [];
  let o = 8;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  while (o + 8 <= d.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    if (type === 'IEND') break;
    if (type === 'IDAT') idats.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  if (!idats.length) return null;
  let tl = 0; for (const id of idats) tl += id.length;
  const all = new Uint8Array(tl); let at = 0;
  for (const id of idats) { all.set(id, at); at += id.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(all); } catch { return null; }
  const stride = w * bpp, want = (stride + 1) * h;
  if (raw.length < want) return null;
  const out = new Uint8Array(w * h * 4);
  const paeth = (a: number, b: number, c: number) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x];
      cur[x] = filter === 0 ? f : filter === 1 ? (f + a) & 0xff : filter === 2 ? (f + b) & 0xff :
        filter === 3 ? (f + ((a + b) >> 1)) & 0xff : (f + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const ci = x * bpp, di = (y * w + x) * 4;
      if (bpp === 4) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = cur[ci + 3]; }
      else if (bpp === 3) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = 255; }
      else { const v = cur[ci]; out[di] = v; out[di + 1] = v; out[di + 2] = v; out[di + 3] = 255; }
    }
    prev.set(cur);
  }
  return { w, h, rgba: out.buffer };
}

export function findIcon(entries: Entry[]): PackIcon | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap-[^/]+\/ic_launcher[0-9a-z_.]{0,12}\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name) || /(?:foreground|background)/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return makeIcon(px.w, px.h, new Uint8Array(px.rgba));
}

// ---- pack building ----

/** read the Texts CSV: base → { en, de, fr, it, es, pt } (EN column first, as shipped). */
function parseTexts(csv: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.split(',');
    const key = parts[0]?.trim();
    if (!key) continue;
    const langs = ['en', 'es', 'pt', 'it', 'fr']; // header: Code,EN,ES,PT,IT,FR
    const t: Record<string, string> = {};
    for (let i = 0; i < langs.length; i++) if (parts[i + 1]?.trim()) t[langs[i]] = parts[i + 1].trim();
    if (t.en) out.set(key, t);
  }
  return out;
}

/** the game order: the order the 73 bases appear in the Texts CSV. */
function orderOf(texts: Map<string, Record<string, string>>, bases: Set<string>): string[] {
  const out: string[] = [];
  for (const [k] of texts) if (bases.has(k)) out.push(k);
  // any base not in the CSV (shouldn't happen) last
  for (const b of bases) if (!out.includes(b)) out.push(b);
  return out;
}

function levelsFrom(bases: Array<{ base: string; w: number; h: number; rows: string[] }>,
  names: Map<string, Record<string, string>>): PackLevel[] {
  const bySize = new Map<string, typeof bases>();
  for (const b of bases) {
    const k = `${b.w}x${b.h}`;
    (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(b);
  }
  const sizes = [...bySize.keys()].sort((a, b) => {
    const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
    return aw * ah - bw * bh;
  });
  const levels: PackLevel[] = [];
  for (const s of sizes) {
    const group = bySize.get(s)!;
    const puzzles: PackPuzzle[] = group.map((b, i) => ({
      id: `${s}-${b.base}`,
      width: b.w, height: b.h, rows: b.rows,
      ...(names.get(b.base) ? { name: names.get(b.base) } : {}),
    }));
    const label = s.replace('x', '×');
    levels.push({
      id: `s${s}`,
      title: { en: label },
      group: s,
      groupTitle: { en: label },
      rules: 'normal',
      puzzles,
    });
  }
  return levels;
}

export function packFromBundle(bundle: Uint8Array): Pack {
  const { serialized, hasTexts } = scanBundle(bundle);
  if (!hasTexts) throw new Error('Nonogram Classic Games: Texts names asset missing.');
  const maskByName = new Map<string, { w: number; h: number; rows: string[] }>();
  let textsCsv: string | null = null;
  for (const ser of serialized) {
    const objs = readSerialized(ser);
    for (const o of objs) {
      if (o.classId === 28) {
        const name = objectNameOf(o);
        if (!name) continue;
        const p = parsePuzzleName(name);
        if (!p || p.color) continue;
        const oo = o as UObject;
        const { w, h } = p;
        const fmt = textureFormatOf(oo);
        const mask = maskOf(oo, w, h, fmt);
        if (!mask) continue;
        const rows = rowsFromMask(mask);
        if (!rows.length) continue;
        // a valid puzzle must have both filled and empty cells
        const filled = rows.join('').split('#').length - 1;
        if (filled === 0) continue;
        maskByName.set(p.base, { w, h, rows });
      } else if (o.classId === 49) {
        const t = textAsset(o);
        if (t && t.name === 'Texts') textsCsv = new TextDecoder().decode(t.bytes);
      }
    }
  }
  if (maskByName.size < 3) throw new Error('Nonogram Classic Games: no puzzle masks found.');
  const texts = textsCsv ? parseTexts(textsCsv) : new Map();
  const order = orderOf(texts, new Set(maskByName.keys()));
  const bases = order.map(b => ({ base: b, ...maskByName.get(b)! }));
  return {
    format: 'momogram-pack',
    version: 1,
    id: 'android-nonogram-classic-games',
    title: { en: 'Nonogram Classic Games', de: 'Nonogram Classic Games' },
    source: {
      game: 'Nonogram Classic Games', platform: 'Android', developer: 'CoolMath Games',
      file: `data.unity3d (${maskByName.size} puzzles)`,
    },
    theme: { palette: {
      accent: '#5b8dd6', fill: '#232a36', cell: '#ffffff', grid: '#c9d4e0', clue: '#202020',
      cross: '#e05050', cursor: '#ffb340', bg: '#f2f6fb', style: 'default',
    } },
    levels: levelsFrom(bases, texts),
  };
}

/** the Texture2D format field: after name pad → forcedFallback(s32) downscale(u8)+pad w h complete depth format. */
export function textureFormatOf(o: UObject): number {
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, o.le ?? true);
  // layout after the name (each u32 read LE): forcedFallback(s32) downscale(u8)+3 pad
  // then w h completeImageSize colourDepth format  (verified against the bundle)
  let p = (4 + len + 3) & ~3;
  p += 4; // forcedFallback
  p += 1; // downscale byte
  p = (p + 3) & ~3;
  p += 12; // w, h, completeImageSize
  p += 4;  // colourDepth
  if (p + 4 <= d.length) {
    const f = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(p, o.le ?? true);
    if (f === FMT_RGBA32 || f === FMT_ETC2_RGBA8) return f;
  }
  return FMT_RGBA32; // fall back: the vast majority are RGBA32
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** find assets/bin/Data/data.unity3d among a file set, unwrapping nested APKs if needed. */
function bundleFromEntries(entries: Entry[]): Uint8Array | null {
  let e = entries.find(x => /(?:^|\/)data\.unity3d$/i.test(x.name));
  if (e) return e.data;
  for (const x of entries) {
    if (/\.(apk|zip)$/i.test(x.name)) {
      try {
        const sub = unzipAll(x.data);
        const inner = sub.find(y => /data\.unity3d$/i.test(y.name));
        if (inner) return inner.data;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** recursively unwrap a container until the game's marker set is on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 4) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (hasManifestPackage(entries) || looksLike(entries)) return entries;
  const inner = entries.filter(e => /\.(apk|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && (hasManifestPackage(sub) || looksLike(sub))) return sub;
  }
  return entries;
}

registerImporter({
  name: 'Nonogram Classic Games (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    const bundle = bundleFromEntries(entries);
    if (!bundle) throw new Error('Not a Nonogram Classic Games APK: marker data.unity3d missing.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(entries);
    if (icon) pack.icon = icon;
    return [pack];
  },
});

registerSetImporter({
  name: 'Nonogram Classic Games (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (/^assets\/bin\/Data\/data\.unity3d$/i.test(n)) roots.add('assets/bin/Data');
      else if (/^AndroidManifest\.xml$/i.test(n)) roots.add('.');
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) roots.add(n);
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      const data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (rel) all.push({ name: rel, data });
      }
    }
    const bundle = bundleFromEntries(all);
    if (!bundle) throw new Error('Not a Nonogram Classic Games APK: marker data.unity3d missing.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(all);
    if (icon) pack.icon = icon;
    return [pack];
  },
});
