// Eyes Nonogram (com.gamefox.eyes, Gamefox) — nonogram puzzles from its Unity (il2cpp) Android app.
//
// The game is a Unity 6000.x app (il2cpp "Il2Cpp" backend, "libil2cpp.so" in the config split).
// Its puzzles are stored as a mix of two things (see ANALYSIS.md for the reverse-engineering):
//
//   1. an XML atlas descriptor  (TextAsset)
//        resources.assets → TextAsset "Nonogram_Normal"  (421 <img> records)
//        resources.assets → TextAsset "Nonogram_Big"     (48  <img> records)
//   2. RGBA32 texture atlases (Texture2D, class 28) in sharedassets1.assets
//        "sactx-0-512x512-Uncompressed-NonoNormal"       (512×512 RGBA32, 1 048 736 B object)
//        "sactx-0-512x512-Uncompressed-NonoBig"          (512×512 RGBA32)
//        "sactx-1-256x256-Uncompressed-NonoBig"          (256×256 RGBA32, a downscaled copy)
//
// Each <img> record is one puzzle: an atlas sub-rectangle, with
//   w h          grid width / height in CELLS
//   x y          top-left pixel position in the atlas (each cell is exactly 1 atlas pixel)
//   key          the puzzle id (0000..0005 tutorials, 1xxx/2xxx/3xxx/4xxx/5xxx normal chapters,
//                10001..30017 "Big" 50×50/75×75 pictures)
//   difficulty   a per-AREA difficulty digit string (mosaic pictures only; one digit per area)
//   area_size    the mosaic tile size (10 or 15): the picture is solved area by area, each area an
//                independent 10×10 / 15×15 nonogram (the union of all areas is the finished picture)
//   notUseArea   comma list of areas not part of the picture (empty picture, kept out)
//
// The atlas pixels form the solved picture: a cell is FILLED when its alpha ≥ 128 (the game draws
// the illustration on a transparent background; the filled silhouette is the solution). White/blank
// atlas cells are empty. The atlas is RGBA32 "Uncompressed", so the cell mask is read straight off
// the per-cell alpha. Row/column clues are derived from the filled mask (there are no clue tables —
// row/col clue sums are conserved for every puzzle, see VERIFIED.md).
//
//   Game / distribution                    Puzzles
//   Eyes Nonogram Normal (Normal_Normal)   421 <img> records
//     - whole-grid nonograms               390 (32 empty-cell ones? none: 1 is fully empty → dropped)
//         size mix 5×5 x6, 10×10 x227, 10×20 x5, 15×15 x156, 15×30 x4, 20×10 x6, 20×20 x5,
//                    20×50 x3, 30×15 x4, 30×30 x2, 30×75 x2   (389 non-empty whole grids)
//     - mosaic pictures (area_size set)    31 pictures = 116 independent area nonograms (10x10/15x15)
//   Eyes Nonogram Big (Nonogram_Big)       48 pictures = 1 200 independent area nonograms
//         size mix 50×50 x? / 75×75 x?  area 10×10 x775, 15×15 x425
//
// No color-picross mode: the atlas cells are the flat RGBA illustration; each cell is one pixel of
// the final picture, there is no separate color-clue channel (verified: colour histogram per puzzle
// is continuous/anti-aliased art, not a discrete per-cell palette — see ANALYSIS.md). No Mega pairs
// (Jupiter-style 2-cells-merged clues): the "Big" mode is a mosaic of independent ordinary nonograms,
// not a Mega line-pairing mode (see ANALYSIS.md).
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / an extracted folder all work). The real markers that decide are
//   - the binary AndroidManifest.xml containing the UTF-16LE package name "com.gamefox.eyes"
//     (also in the XAPK manifest.json package_name), and
//   - the puzzle marker: a UnityFS bundle, data.unity3d (or an asset bundle app), holding
//     resources.assets whose TextAssets "Nonogram_Normal" / "Nonogram_Big" decode to a valid
//     <data><img …/></data> record set, next to a sharedassets1.assets with the matching
//     "sactx-…-NonoNormal" / "sactx-…-NonoBig" RGBA32 atlas texture.
// .xapk / .apkm / .zip are zips that hold the base APK (com.gamefox.eyes.apk, a zip with those
// assets) next to the ABI config split; unzipping recursively and matching the markers works for
// every distribution. An already-extracted base APK / folder is handled by the Set variant below.
//
// Icon: res/mipmap-xxxhdpi-v4/app_icon.png (192×192) → the biggest launcher PNG decoded to RGBA
// (see VERIFIED.md; this is also the XAPK's own icon.png).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync } from 'fflate';
import { readBundle, readSerialized, textAsset } from '../../rom/unity';
import { puzzleScore } from '../../game/difficulty';
import { solutionCount } from '../../game/unique';

type Entry = { name: string; data: Uint8Array };

/** the marker set of Eyes Nonogram: manifest package + the two puzzle atlases/XML in resources/sharedassets1. */
export function hasManifestPackage(entries: Entry[]): boolean {
  for (const e of entries) {
    if (!/^(AndroidManifest\.xml|META-INF\/?(manifest|.*manifest.*)\.xml)$/i.test(e.name)) continue;
    const d = e.data;
    const needle = new TextEncoder().encode('com.gamefox.eyes');
    for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
      let all = true;
      for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
      if (all) return true;
    }
  }
  return false;
}

/** true when the entries carry the puzzle marker: a Unity data.unity3d with Nonogram XML + atlas. */
export function looksLike(entries: Entry[]): boolean {
  // quick path: named game marker files sitting loose
  if (entries.some(e => /^assets\/bin\/Data\/data\.unity3d$/i.test(e.name))) {
    return unityBundleLooksLike(entries.map(e => e.data).find((_, i) => /^assets\/bin\/Data\/data\.unity3d$/i.test(entries[i].name)! ) ?? new Uint8Array());
  }
  return false;
}

function unityBundleLooksLike(bundle: Uint8Array): boolean {
  try {
    const content = readBundle(bundle);
    const resources = content.get('resources.assets');
    const shared1 = content.get('sharedassets1.assets');
    if (!resources || !shared1) return false;
    const objs = readSerialized(resources);
    let hasNormal = false, hasBig = false;
    for (const o of objs) {
      const t = textAsset(o);
      if (t && (t.name === 'Nonogram_Normal' || t.name === 'Nonogram_Big')) {
        const xml = new TextDecoder().decode(t.bytes);
        if (/<data>[\s\S]*<img\b[\s\S]*\bkey=/.test(xml) && /\bw="/.test(xml) && /\bh="/.test(xml)) {
          if (t.name === 'Nonogram_Normal') hasNormal = true; else hasBig = true;
        }
      }
    }
    if (!hasNormal && !hasBig) return false;
    // atlas textures
    let atlasN = false, atlasB = false;
    for (const o of readSerialized(shared1)) {
      if (o.classId !== 28) continue;
      const name = objectNameOf(o);
      if (!name) continue;
      if (/sactx-\d+-\d+x\d+-Uncompressed-NonoNormal-/i.test(name)) atlasN = true;
      if (/sactx-\d+-\d+x\d+-Uncompressed-NonoBig-/i.test(name)) atlasB = true;
    }
    return hasNormal && atlasN || hasBig && atlasB;
  } catch { return false; }
}

function objectNameOf(o: { classId: number; data: Uint8Array; le: boolean }): string | null {
  if (o.classId !== 28) return null;
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, o.le ?? true);
  if (!(len > 0 && len < 256 && 4 + len <= d.length)) return null;
  return new TextDecoder().decode(d.subarray(4, 4 + len));
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
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

// ---- XML/atlas reader ----

interface Img {
  key: string; w: number; h: number; x: number; y: number;
  area?: number; notuse: number[]; diff: string;
}

function parseImg(xml: string): Img[] {
  const out: Img[] = [];
  const re = /<img\s+([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const at: Record<string, string> = {};
    for (const mm of m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g)) at[mm[1] ?? mm[3]] = mm[2] ?? mm[4];
    const key = at.key ?? '';
    const w = +at.w, h = +at.h, x = +at.x, y = +at.y;
    if (!key || !(w >= 1 && w <= 200 && h >= 1 && h <= 200)) continue;
    if (!(x >= 0 && y >= 0 && x + w <= 1024 && y + h <= 1024)) continue;
    out.push({
      key, w, h, x, y,
      area: at.area_size !== undefined ? +at.area_size : undefined,
      notuse: (at.notUseArea ?? '').split(',').filter(Boolean).map(Number),
      diff: (at.difficulty ?? '').replace(/\s+/g, ''),
    });
  }
  return out;
}

/** rows of a whole-grid puzzle: the filled mask of the atlas sub-rect (alpha ≥ 128 = filled). */
function rowsOfMask(atlas: Uint8Array, AW: number, x: number, y: number, w: number, h: number): string[] {
  const rows: string[] = [];
  for (let j = 0; j < h; j++) {
    let s = '';
    for (let i = 0; i < w; i++) {
      const a = atlas[((y + j) * AW + (x + i)) * 4 + 3];
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

/** the atlas pixel rows of a texture object: object length - w*h*4 (RGBA32 inline, verified header = 160). */
function atlasPixels(o: { data: Uint8Array }, w: number, h: number): Uint8Array {
  const want = w * h * 4;
  return o.data.subarray(o.data.length - want);
}

interface Atlas { w: number; px: Uint8Array }

/** find the NonoNormal / NonoBig atlas texture in a serialized file; null when missing. */
function findAtlas(objs: Awaited<ReturnType<typeof readSerialized>>, nameRe: RegExp): Atlas | null {
  for (const o of objs) {
    if (o.classId !== 28) continue;
    const name = objectNameOf(o);
    if (!name || !nameRe.test(name)) continue;
    const m = /(\d+)x(\d+)/.exec(name);
    if (!m) continue;
    const w = +m[1], h = +m[2];
    if (!(w >= 1 && w <= 2048 && h >= 1 && h <= 2048)) continue;
    if (o.data.length < w * h * 4) continue;
    return { w, px: atlasPixels(o, w, h) };
  }
  return null;
}

// ---- levels ----

function levelRow(prefix: string, size: string): string {
  return `${prefix}-${size}`;
}

/** build the pack from a bundle (data.unity3d) that holds the puzzle resources + sharedassets1 atlas. */
export function packFromBundle(bundle: Uint8Array): Pack {
  const content = readBundle(bundle);
  const resources = content.get('resources.assets');
  const shared1 = content.get('sharedassets1.assets');
  if (!resources || !shared1) throw new Error('Eyes Nonogram bundle: resources.assets / sharedassets1.assets missing.');

  const resObjs = readSerialized(resources);
  let xmlN: string | null = null, xmlB: string | null = null;
  for (const o of resObjs) {
    const t = textAsset(o);
    if (t && t.name === 'Nonogram_Normal') xmlN = new TextDecoder().decode(t.bytes);
    if (t && t.name === 'Nonogram_Big') xmlB = new TextDecoder().decode(t.bytes);
  }
  if (!xmlN && !xmlB) throw new Error('Eyes Nonogram XML data (Nonogram_Normal/Big) not found.');

  const shared1Objs = readSerialized(shared1);
  const atlasN = findAtlas(shared1Objs, /sactx-\d+-\d+x\d+-Uncompressed-NonoNormal-/i);
  const atlasB = findAtlas(shared1Objs, /sactx-\d+-\d+x\d+-Uncompressed-NonoBig-/i);
  if (!atlasN && !atlasB) throw new Error('Eyes Nonogram atlas textures (NonoNormal/NonoBig) not found.');

  const imgsN = xmlN ? parseImg(xmlN) : [];
  const imgsB = xmlB ? parseImg(xmlB) : [];
  if (!imgsN.length && !imgsB.length) throw new Error('Eyes Nonogram XML decoded with no <img> records.');

  const normal: PackLevel[] = [];
  const big: PackLevel[] = [];
  let pTotal = 0;

  // Normal: whole-grid records (no area_size -> one nonogram each) + mosaic records (area_size -> one per area)
  if (atlasN) {
    const whole: Array<{ key: string; w: number; h: number; rows: string[] }> = [];
    const mosaic: Array<{ key: string; area: number; parts: Array<{ rx: number; ry: number; w: number; h: number; rows: string[] }> }> = [];
    for (const im of imgsN) {
      if (im.area) {
        // mosaic picture: split into area_size×area_size independent grids
        const A = im.area;
        const cols = Math.ceil(im.w / A), rows = Math.ceil(im.h / A);
        const parts: typeof mosaic[number]['parts'] = [];
        for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
          const w = Math.min(A, im.w - rx * A), h = Math.min(A, im.h - ry * A);
          if (w <= 0 || h <= 0) continue;
          const r = rowsOfMask(atlasN.px, atlasN.w, im.x + rx * A, im.y + ry * A, w, h);
          if (!filledCount(r)) continue;      // blank area (empty) — not a nonogram
          parts.push({ rx, ry, w, h, rows: r });
        }
        if (parts.length) mosaic.push({ key: im.key, area: A, parts });
      } else {
        const r = rowsOfMask(atlasN.px, atlasN.w, im.x, im.y, im.w, im.h);
        if (!filledCount(r)) continue;         // 2037 is a fully-empty grid the game ships — drop it
        whole.push({ key: im.key, w: im.w, h: im.h, rows: r });
      }
    }

    const groupTitle = { en: 'Nonogram', de: 'Nonogramm' };
    if (whole.length) {
      const puzzles = whole.map(p => ({
        id: `n-${p.key}`,
        width: p.w, height: p.h, rows: p.rows,
        name: { en: `Puzzle ${p.key}` },
      }));
      normal.push(...numberedLevels(puzzles, {
        id: levelRow('eyes-n', 'classic'), group: 'eyes-normal', groupTitle,
      }));
      pTotal += whole.length;
    }
    // mosaic: area pieces split into numbered tabs so the puzzle screen stays usable
    if (mosaic.length) {
      const puzzles: PackPuzzle[] = [];
      for (const m0 of mosaic) {
        for (let k = 0; k < m0.parts.length; k++) {
          const part = m0.parts[k];
          puzzles.push({
            id: `b-${m0.key}-${String(k + 1).padStart(2, '0')}`,
            width: part.w, height: part.h, rows: part.rows,
            name: { en: `Mosaic ${m0.key} part ${k + 1}` },
          });
        }
      }
      normal.push(...numberedLevels(puzzles, {
        id: levelRow('eyes-n', 'mosaic'), group: 'eyes-normal', groupTitle,
      }));
      pTotal += puzzles.length;
    }
  }

  // Big: every picture is a mosaic of 10×10 / 15×15 areas
  if (atlasB) {
    const puzzles: PackPuzzle[] = [];
    for (const im of imgsB) {
      const A = im.area ?? 0;
      if (!A) continue;
      const cols = Math.ceil(im.w / A), rows = Math.ceil(im.h / A);
      for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
        const w = Math.min(A, im.w - rx * A), h = Math.min(A, im.h - ry * A);
        if (w <= 0 || h <= 0) continue;
        // areas in notUseArea are outside the picture
        const areaNo = ry * cols + rx + 1;
        if (im.notuse.includes(areaNo)) continue;
        const r = rowsOfMask(atlasB.px, atlasB.w, im.x + rx * A, im.y + ry * A, w, h);
        if (!filledCount(r)) continue;
        puzzles.push({
          id: `big-${im.key}-${String(areaNo).padStart(2, '0')}`,
          width: w, height: h, rows: r,
          name: { en: `Big ${im.key} · ${w}×${h}` },
        });
      }
    }
    if (puzzles.length) {
      big.push(...numberedLevels(puzzles, {
        id: levelRow('eyes-b', 'mosaic'),
        group: 'eyes-big', groupTitle: { en: 'Big', de: 'Groß' },
      }));
      pTotal += puzzles.length;
    }
  }

  if (!normal.length && !big.length) throw new Error('Eyes Nonogram XML decoded, but no usable nonogram grids.');

  const pack: Pack = {
    format: 'momogram-pack',
    version: 1,
    id: 'android-eyes-nonogram',
    title: { en: 'Eyes Nonogram' },
    source: {
      game: 'Eyes Nonogram', platform: 'Android', developer: 'Gamefox', year: 2026,
      file: `${pTotal} puzzles`, region: 'WW',
    },
    theme: {
      palette: {
        accent: '#7a4a9a', fill: '#f4efe6', bg: '#ece2d2',
        style: 'logic', grid: '#cbb89a', clue: '#3a2a4a', cursor: '#a06ab0',
      },
    },
    levels: [...normal, ...big],
  };
  return pack;
}

/** pack icon from the base APK's biggest launcher PNG (app_icon.png / ic_launcher.png). */
function findIcon(entries: Entry[]): { icon: ReturnType<typeof makeIcon>; file: string } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/app_icon(?:\.png)?$/i.test(e.name) && !/^res\/mipmap[^/]*\/ic_launcher(?:_[a-z]+)?\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), file: `${best.name} ${px.w}x${px.h}` };
}

/** minimal PNG decoder (8-bit RGBA/RGB/grey, non-interlaced, multi-IDAT) — enough for launcher icons. */
function pngRgba(d: Uint8Array, inflate = false): { w: number; h: number; rgba: ArrayBuffer } | null {
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
  try { raw = unzlibRaw(all); }
  catch { try { raw = inflateRaw(all); } catch { return null; } }
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
      else { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = 255; }
    }
    prev.set(cur);
  }
  return { w, h, rgba: out.buffer };
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
// zlib/raw inflate via fflate
import { unzlibSync as unzlibRaw, inflateSync as inflateRaw } from 'fflate';

function bundleFromEntries(entries: Entry[]): Uint8Array | null {
  let e = entries.find(x => /^assets\/bin\/Data\/data\.unity3d$/i.test(x.name));
  if (e) return e.data;
  // nested: an APK that holds assets/bin/Data/data.unity3d
  for (const x of entries) {
    if (/\.apk$/i.test(x.name)) {
      try {
        const sub = unzipAll(x.data);
        const inner = sub.find(y => /^assets\/bin\/Data\/data\.unity3d$/i.test(y.name));
        if (inner) return inner.data;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// ---- entry points ----
registerImporter({
  name: 'Eyes Nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try {
      const entries = entriesOf(data);
      const bundle = bundleFromEntries(entries);
      return !!bundle && looksLike([{ name: 'assets/bin/Data/data.unity3d', data: bundle }]);
    } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    const bundle = bundleFromEntries(entries);
    if (!bundle) throw new Error('Not an Eyes Nonogram APK: assets/bin/Data/data.unity3d not found.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(entries);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});

registerSetImporter({
  name: 'Eyes Nonogram (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder: its assets/bin/Data/data.unity3d live here
      if (/^assets\/bin\/Data\/data\.unity3d$/i.test(n)) roots.add(n.slice(0, n.indexOf('assets/')) || '.');
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) roots.add(n);
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
    if (!bundle) throw new Error('Not an Eyes Nonogram APK: assets/bin/Data/data.unity3d not found.');
    const pack = packFromBundle(bundle);
    const icon = findIcon(all);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});
