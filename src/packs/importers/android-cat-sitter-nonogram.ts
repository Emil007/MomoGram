// Cat Sitter (+ nonogram) (com.healingjam.catslave, HealingJam) — nonogram puzzles from a Unity (il2cpp) APK.
//
// The game is a Unity 2022.3.62f2 (il2cpp) Android app ("NonogramCatSlaveRenewal", HealingJam). Its whole
// puzzle catalogue is stored LOCAL, at rest, in the base APK — no runtime / network dependency for the 312
// shipped puzzles:
//
//   1. an XML atlas descriptor  (TextAsset)
//        assets/bin/Data/data.unity3d → sharedassets0.assets → TextAsset "picross"
//        (an XML `<PicrossMap>` with 312 `<Map …/>` records, one per puzzle)
//   2. an RGBA32 texture atlas  (Texture2D, class 28) in the SAME serialized file sharedassets0.assets:
//        Texture2D "total" (165×600 RGBA32, complete image 396 000 B = 165·600·4, inline — no .resS)
//
// Each <Map> record describes one puzzle as an atlas sub-rectangle:
//   uniqueMapName   "v1S5_1" … "v12S20_5" — stable puzzle id (v<pack> S<size> _<index>)
//   pixelCategory   "m1" … "m12" — the game's 12 packs (each 26 puzzles; the game calls them chapters / stages)
//   dataRectangle   "x, y, w, h" — atlas pixels; each CELL is exactly 1 atlas pixel
//   titleLabel      "ko,ja,en" — the puzzle's title in Korean / Japanese / English ("고양이,猫,Cat")
//   baseColor       always "0" (no separate colour channel)
//
// The atlas is the solved picture: every grid cell is one pixel of the RGBA illustration. A cell is FILLED
// when its alpha ≥ 128, EMPTY otherwise. We verified the whole atlas alpha channel is perfectly binary
// (33 593 cells alpha 255, 65 407 cells alpha 0, zero partial alpha) — so the alpha mask is exactly the
// solution. The RGB channels carry the anti-aliased illustration art (continuous gradient shading of the
// same colour family, e.g. the cat's orange fur: (247,148,29)→(237,126,0)→…), NOT a discrete clue palette —
// the game's pictures are ordinary MONO nonograms (each puzzle solved in one colour; the coloured art is a
// decorative solved picture). Color-nonogram encoding (per-cell palette indices / ≥2 discrete clue colours)
// is absent (see ANALYSIS.md: hue-family analysis shows continuous art, no discrete palette; baseColor=0).
//
// Solvability (measured on the real atlas, see VERIFIED.md §3): 275 of the 312 masks are solved by line
// logic alone (puzzleScore solvable=true); the remaining 37 need a guess (7 of them are still unique — the
// picture itself is stored that way, not an extraction artefact). 30 of the 312 are genuinely ambiguous
// (solutionCount=2), confirmed by an independent brute-force over the row/column clue sets of a sample
// (e.g. v2S5_2 has exactly two valid fillings). The masks are the game's art at rest — the game shipped
// these grids as-is; no repair is attempted (owner policy: store the game's own puzzles, deviations listed).
//
// No MEGA mode: no .DPC/.bdpc/.dpc2 pair files, no paired-line structure anywhere in the bundle (0 hits),
// `pixelCategory` has no band/pair encoding. Each category is a flat set of 5×5/10×10/15×15/20×20 grids.
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / an extracted folder all work — XAPK here is a zip holding the base APK
// `com.healingjam.catslave.apk` next to a `config.arm64_v8a.apk` ABI split). The real markers that decide are
//   - the binary AndroidManifest.xml containing the UTF-16LE package name "com.healingjam.catslave"
//     (also the XAPK manifest.json package_name), and
//   - the puzzle marker: a UnityFS bundle (data.unity3d) whose sharedassets0.assets holds both the
//     TextAsset "picross" decoding to a valid `<PicrossMap>` with `<Map uniqueMapName= dataRectangle= …/>`
//     records AND a Texture2D named "total" whose complete RGBA32 image spans those rectangles.
// Matching both in the same bundle is what identifies this game — never a file extension.
//
// Icon: res/mipmap-xxxhdpi-v4/app_icon.png (192×192) → the biggest launcher PNG decoded to RGBA
// (see VERIFIED.md; identical to the XAPK's own icon.png).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, PackIcon } from '../format';
import { unzipSync, unzlibSync, inflateSync } from 'fflate';
import { readBundle, readSerialized, textAsset } from '../../rom/unity';
import { objectName, textureSize } from '../../rom/unity-texture';
import { puzzleScore } from '../../game/difficulty';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.healingjam.catslave';
/** atlas-descriptor (TextAsset "picross") + atlas (Texture2D "total") serialized file, inside data.unity3d. */
const ATLAS_FILE = 'sharedassets0.assets';

/** true when the entries are a Cat Sitter container (manifest package + picross XML + total atlas). */
export function looksLike(entries: Entry[]): boolean {
  let hasManifest = false;
  for (const e of entries) {
    if (!hasManifest && /^(AndroidManifest\.xml|META-INF\/?[\w.-]*manifest.*\.xml)$/i.test(e.name)) {
      if (containsUtf16(e.data, PKG)) hasManifest = true;
    }
  }
  const bundle = bundleFromEntries(entries);
  return hasManifest && !!bundle && unityBundleLooksLike(bundle);
}

function containsUtf16(d: Uint8Array, needle: string): boolean {
  const nd = new TextEncoder().encode(needle);
  for (let i = 0; i + nd.length * 2 <= d.length; i += 2) {
    let all = true;
    for (let k = 0; k < nd.length; k++) if (d[i + k * 2] !== nd[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
    if (all) return true;
  }
  return false;
}

/** the UnityFS data.unity3d holding the puzzle bundle, wherever it hides in the container. */
export function bundleFromEntries(entries: Entry[]): Uint8Array | null {
  for (const e of entries) {
    if (/^assets\/bin\/Data\/data\.unity3d$/i.test(e.name)) return e.data;
    if (/^data\.unity3d$/i.test(e.name)) return e.data;
  }
  return null;
}

function unityBundleLooksLike(bundle: Uint8Array): boolean {
  try {
    const content = readBundle(bundle);
    const shared0 = content.get(ATLAS_FILE);
    if (!shared0) return false;
    const objs = readSerialized(shared0);
    let xmlOk = false, totalOk = false;
    for (const o of objs) {
      if (o.classId === 49) {
        const t = textAsset(o);
        if (t && t.name === 'picross') {
          const txt = new TextDecoder().decode(t.bytes);
          xmlOk = /<PicrossMap>[\s\S]*<Map\b[\s\S]*\buniqueMapName=[\s\S]*\bdataRectangle=/i.test(txt);
          if (xmlOk && countMaps(txt) < 10) xmlOk = false;
        }
      }
      if (o.classId === 28) {
        const name = objectName(o);
        if (name === 'total') {
          const ts = textureSize(o);
          if (ts && ts.w === 165 && ts.h === 600) totalOk = true;
        }
      }
    }
    return xmlOk && totalOk;
  } catch { return false; }
}

function countMaps(xml: string): number {
  let n = 0;
  const re = /<Map\b/g;
  while (re.exec(xml)) n++;
  return n;
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's marker set is on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 4) throw new Error('Too many nested containers.');
  let entries: Entry[] = [];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  const inner = entries.filter(e => /\.(apk|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && looksLike(sub)) return sub;
  }
  return entries;
}

// ——— XML + atlas reader ———

interface MapRecord {
  name: string; cat: string; x: number; y: number; w: number; h: number;
  ko: string; ja: string; en: string;
}

export function parseMaps(xml: string): MapRecord[] {
  const out: MapRecord[] = [];
  const re = /<Map\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const at: Record<string, string> = {};
    for (const mm of m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) at[mm[1]] = mm[2];
    const name = (at.uniqueMapName ?? '').trim();
    const cat = (at.pixelCategory ?? '').trim();
    const rect = (at.dataRectangle ?? '').split(',').map(Number);
    if (!name || !/^m\d+$/.test(cat)) continue;
    const [x, y, w, h] = rect;
    if (!(x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= 165 && y + h <= 600)) continue;
    const [ko = '', ja = '', en = ''] = (at.titleLabel ?? '').split(',');
    out.push({ name, cat, x, y, w, h, ko, ja, en });
  }
  return out;
}

/** rows of one map: the alpha mask of its atlas sub-rect (alpha ≥ 128 = filled).
 * The raw atlas pixels are vertically flipped (row 0 = picture bottom), so a map's logical
 * row y is stored at atlas row (AH-1-y). Each cell is one atlas pixel. */
export function rowsOfMask(atlas: Uint8Array, AW: number, AH: number, x: number, y: number, w: number, h: number): string[] {
  const rows: string[] = [];
  for (let j = 0; j < h; j++) {
    const logicalRow = y + j;                    // picture row (top = 0)
    const atlasRow = (AH - 1) - logicalRow;      // flipped in the raw bytes
    let s = '';
    for (let i = 0; i < w; i++) {
      const a = atlas[(atlasRow * AW + (x + i)) * 4 + 3];
      s += a >= 128 ? '#' : '.';
    }
    rows.push(s);
  }
  return rows;
}

function filledCount(rows: string[]): number {
  let n = 0;
  for (const r of rows) for (const c of r) if (c === '#') n++;
  return n;
}

interface Atlas { w: number; h: number; px: Uint8Array }

/** find the "total" RGBA32 atlas in a serialized file.
 * The inline image data (complete image, w*h*4 bytes RGBA32) sits somewhere after the Texture2D's
 * serialized header fields (m_Name … m_TextureFormat … m_StreamData … m_CompleteImageSize). Rather than
 * hard-code a Unity-version layout, scan the object for the unique w*h*4-byte window whose alpha bytes
 * are 100% binary (0/255) — the atlas is the solved picture, alpha = the solution mask. */
function findTotalAtlas(objs: Awaited<ReturnType<typeof readSerialized>>): Atlas | null {
  for (const o of objs) {
    if (o.classId !== 28) continue;
    const name = objectName(o);
    if (name !== 'total') continue;
    const ts = textureSize(o);
    if (!ts || ts.w !== 165 || ts.h !== 600) continue;
    const want = ts.w * ts.h * 4;
    if (want > o.data.length) continue;
    // scan for a want-byte window with every alpha (byte 3 of each RGBA) exactly 0 or 255.
    // The inline complete image is the LAST big serialized field, so take the FIRST such window
    // when scanning from the end (highest st) — a small all-empty grid region can pass early,
    // but the real atlas blob is the last qualifying window (offset 108 in this build).
    for (let st = o.data.length - want; st >= 0; st--) {
      const px = o.data.subarray(st, st + want);
      let binary = true;
      for (let i = 3; i < want; i += 4) { const a = px[i]; if (a !== 0 && a !== 255) { binary = false; break; } }
      if (binary) return { w: ts.w, h: ts.h, px };
    }
  }
  return null;
}

const CAT_TITLES: Record<string, { en: string; ja: string; ko: string }> = {
  m1: { en: 'Chapter 1', ja: '第1章', ko: '1장' },
  m2: { en: 'Chapter 2', ja: '第2章', ko: '2장' },
  m3: { en: 'Chapter 3', ja: '第3章', ko: '3장' },
  m4: { en: 'Chapter 4', ja: '第4章', ko: '4장' },
  m5: { en: 'Chapter 5', ja: '第5章', ko: '5장' },
  m6: { en: 'Chapter 6', ja: '第6章', ko: '6장' },
  m7: { en: 'Chapter 7', ja: '第7章', ko: '7장' },
  m8: { en: 'Chapter 8', ja: '第8章', ko: '8장' },
  m9: { en: 'Chapter 9', ja: '第9章', ko: '9장' },
  m10: { en: 'Chapter 10', ja: '第10章', ko: '10장' },
  m11: { en: 'Chapter 11', ja: '第11章', ko: '11장' },
  m12: { en: 'Chapter 12', ja: '第12章', ko: '12장' },
};

/** build the momogram pack from a Cat Sitter Unity bundle. */
export function packFromBundle(bundle: Uint8Array): Pack {
  const content = readBundle(bundle);
  const shared0 = content.get(ATLAS_FILE);
  if (!shared0) throw new Error('Cat Sitter bundle: sharedassets0.assets missing.');
  const objs = readSerialized(shared0);

  let xml: string | null = null;
  for (const o of objs) {
    const t = textAsset(o);
    if (t && t.name === 'picross') {
      xml = new TextDecoder().decode(t.bytes);
      break;
    }
  }
  if (!xml) throw new Error('Cat Sitter: TextAsset "picross" (PicrossMap descriptor) not found.');

  const atlas = findTotalAtlas(objs);
  if (!atlas) throw new Error('Cat Sitter: Texture2D "total" (165×600 RGBA32 atlas) not found.');

  const maps = parseMaps(xml);
  if (maps.length < 10) throw new Error('Cat Sitter: PicrossMap parsed with too few maps.');

  // group by pixelCategory, preserving game order (m1..m12)
  const byCat = new Map<string, MapRecord[]>();
  for (const m of maps) {
    let arr = byCat.get(m.cat);
    if (!arr) byCat.set(m.cat, arr = []);
    arr.push(m);
  }

  const levels: PackLevel[] = [];
  let total = 0;
  for (const [cat, list] of byCat) {
    if (!list.length) continue;
    const puzzles: PackPuzzle[] = [];
    for (const m of list) {
      const rows = rowsOfMask(atlas.px, atlas.w, atlas.h, m.x, m.y, m.w, m.h);
      if (!filledCount(rows)) continue; // (none of the 312 is blank, but stay safe)
      const name: Record<string, string> = {};
      if (m.en) name.en = m.en;
      if (m.ja) name.ja = m.ja;
      if (m.ko) name.ko = m.ko;
      puzzles.push({ id: m.name, width: m.w, height: m.h, rows, name });
    }
    if (!puzzles.length) continue;
    const t = CAT_TITLES[cat] ?? { en: cat, ja: cat, ko: cat };
    levels.push({
      id: `cats-${cat}`,
      title: { en: t.en, ja: t.ja, ko: t.ko },
      groupTitle: { en: t.en, ja: t.ja, ko: t.ko },
      group: 'cats-stages',
      rules: 'normal' as const,
      puzzles,
    });
    total += puzzles.length;
  }

  if (!levels.length) throw new Error('Cat Sitter: no usable nonogram grids from the 312 maps.');

  const pack: Pack = {
    format: 'momogram-pack',
    version: 1,
    id: 'android-cat-sitter',
    title: { en: 'Cat Sitter (+ nonogram)', ja: 'キャットシッター', ko: '캣싯터' },
    source: {
      game: 'Cat Sitter (+ nonogram)', platform: 'Android', developer: 'HealingJam', year: 2022,
      file: `${total} puzzles`, region: 'WW',
    },
    theme: {
      palette: {
        accent: '#f7a030', fill: '#fff6ea', bg: '#f6ede0', grid: '#d9c3a4', clue: '#5a4632',
        cursor: '#f28c28', style: 'default',
      },
    },
    levels,
  };
  return pack;
}

/** pack icon from the base APK's biggest launcher PNG (app_icon.png). */
function findIcon(entries: Entry[]): { icon: PackIcon; file: string } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/app_icon(?:\.png)?$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), file: `${best.name} ${px.w}x${px.h}` };
}

/** minimal PNG decoder (8-bit RGBA/RGB/grey, non-interlaced, multi-IDAT) — enough for launcher icons. */
function pngRgba(d: Uint8Array): { w: number; h: number; rgba: ArrayBuffer } | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50) return null;
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null;
  const w = (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19];
  const h = (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23];
  const depth = d[24], ctype = d[25];
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024) || depth !== 8) return null;
  let bpp = 0;
  if (ctype === 6) bpp = 4; else if (ctype === 2) bpp = 3; else if (ctype === 0) bpp = 1; else return null;
  const idats: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= d.length) {
    const len = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    if (type === 'IEND') break;
    if (type === 'IDAT') idats.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  if (!idats.length) return null;
  let tl = 0;
  for (const id of idats) tl += id.length;
  const all = new Uint8Array(tl);
  let at = 0;
  for (const id of idats) { all.set(id, at); at += id.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(all); }
  catch { try { raw = inflateSync(all); } catch { return null; } }
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x];
      cur[x] = filter === 0 ? f :
        filter === 1 ? (f + a) & 0xff :
        filter === 2 ? (f + b) & 0xff :
        filter === 3 ? (f + ((a + b) >> 1)) & 0xff :
        (f + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const ci = x * bpp, di = (y * w + x) * 4;
      if (ctype === 6) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = cur[ci + 3]; }
      else if (ctype === 2) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = 255; }
      else { const v = cur[ci]; out[di] = v; out[di + 1] = v; out[di + 2] = v; out[di + 3] = 255; }
    }
    prev.set(cur);
  }
  return { w, h, rgba: out.buffer };
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ——— entry points ———
registerImporter({
  name: 'Cat Sitter (+ nonogram) (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Cat Sitter (com.healingjam.catslave) APK: picross descriptor or total atlas missing.');
    const bundle = bundleFromEntries(entries);
    if (!bundle) throw new Error('Cat Sitter: data.unity3d not found.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(entries);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});

registerSetImporter({
  name: 'Cat Sitter (+ nonogram) (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder whose data.unity3d lives here
      if (/^assets\/bin\/Data\/data\.unity3d$/i.test(n)) roots.add(n.slice(0, n.indexOf('assets/')) || '.');
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !n.startsWith(root)) continue;
      let data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else all.push({ name: root === '.' ? n : n.slice(root.length + 1), data });
    }
    const bundle = bundleFromEntries(all);
    if (!bundle) throw new Error('Not a Cat Sitter (com.healingjam.catslave) APK: data.unity3d not found.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(all);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});
