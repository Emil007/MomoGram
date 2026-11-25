// Somnus : Nonogram (com.gamefox.somnus, Gamefox) — nonogram puzzles from its Unity 6 (il2cpp) Android app.
//
// The game is a Unity 6000.1.17f1 (Unity 6) il2cpp app. Its puzzles are stored the same way as the other
// Gamefox engine games (Eyes Nonogram, NonoBot):
//
//   1. an XML atlas descriptor — a TextAsset named "imgInfo" in resources.assets:
//
//        <data>
//          <number_maxcount>4</number_maxcount>
//          <img_atlas imgPath='somnus_normal map' atlasCode='2' blankAlphaValue='0' blankColorValue='0x304655' …>
//            <img w="10" h="10" x="0" y="0" key="1001" name_kr="토마토" name_en="Tomato" …/>   NORMAL puzzles
//          <img_atlas imgPath='somnus_bigmap' atlasCode='3' …>
//            <img w="50" h="50" x="0" y="0" size="10" key="10001" name_en="Following a Bluebird" …>  BIGMAP story pictures
//
//      Two atlas sections: NORMAL (atlasCode '2', 243 whole-grid records, each cell = one atlas pixel,
//      w/h = grid size in cells) and BIGMAP (atlasCode '3', 33 story pictures that are solved area by area:
//      each record has a `size` attr = the independent 10×10 / 15×15 / 20×20 area nonogram size; every
//      picture tiles into a 5×5 grid of areas — 50×50 / 75×75 / 100×100).
//   2. the atlas textures — two Texture2D (class 28), RGBA32 ("Uncompressed"), inline in resources.assets
//      (same serialized file as the imgInfo TextAsset — not a separate sharedassetsN.assets):
//        "somnus_normal map"   512×256   RGBA32, 524 288 B of pixels
//        "somnus_bigmap"     1024×256   RGBA32, 1 048 576 B of pixels
//
//   The stored picture IS the solution: a cell is filled when alpha ≈ 255 (real cells are alpha 0 or 255,
//   verified binary histogram). The atlas rows are stored Y-flipped (bottom-up, as every Unity-built texture
//   is at rest in the file; the GPU upload flips it when the game renders). Row/column clue runs are derived
//   from the filled mask — there are no clue tables (row/col sums are conserved for every puzzle).
//
//   Playable content (see ANALYSIS.md / VERIFIED.md)
//     Mode                        Level id       Puzzles (grids)
//     NORMAL whole grids          su-normal      243 (10×10 ×138, 15×15 ×72, 20×20 ×27, 10×20, 30×10 ×2,
//                                                30×30 ×2, 40×40 ×1)
//     BIGMAP story pictures       su-bigmap      825 area grids (33 pictures × 25 areas of 10×10 / 15×15 / 20×20)
//     Total                                      1068 playable nonogram grids.
//
//   The "Big Map" is a top-down story map (a girl following a bluebird through her dreams); each picture is
//   solved area by area, every area is an independent ordinary nonogram. There is no colour mode and no Mega
//   (line-pairing) mode: the atlas alpha is binary 0/1 across all 1068 grids, no .DPC/.bdpc/.dpc2 pair files
//   or mega strings exist in the game code (checked in global-metadata.dat, see ANALYSIS.md), and the only
//   "ColorMode" strings are Unity TMP / Android config noise.
//
//   Container-agnostic by design (owner requirement): detect/read never gate on the file extension
//   (.apk / .xapk / .apkm / .zip / an extracted folder all work). The real markers that decide are
//     - the binary AndroidManifest.xml with the UTF-16LE package name "com.gamefox.somnus"
//       (versionName "10.7" / versionCode 127, confirmed with aapt), and
//     - the puzzle marker: the "imgInfo" TextAsset (an XML with <img_atlas …/> and <img w= h= x= y= key= …/>
//       records) next to the two atlas Texture2D "somnus_normal map" and "somnus_bigmap" inside
//       resources.assets of the data.unity3d UnityFS bundle.
//   .xapk / .apkm / .zip are zips that hold the base APK (com.gamefox.somnus.apk, a zip with those assets)
//   next to the ABI config split; unzipping recursively and matching the markers works for every
//   distribution. An already-extracted base APK / folder is handled by the Set variant below.
//
// Icon: res/mipmap-xxxhdpi-v4/app_icon.png (192×192) — the biggest launcher PNG (identical to the XAPK's own
// icon.png), decoded to RGBA (see VERIFIED.md).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync, unzlibSync, inflateSync } from 'fflate';
import { readBundle, readSerialized, textAsset } from '../../rom/unity';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.gamefox.somnus';

/** the binary AndroidManifest with the UTF-16LE package name com.gamefox.somnus */
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

/** full dump of one zip into entries (what the UI's unzipAll does) */
export function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data as any);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** the game's own assets are on top when the package marker and the data.unity3d bundle are present. */
export function isOurs(entries: Entry[]): boolean {
  return hasManifestPackage(entries) && entries.some(e => /^assets\/bin\/Data\/data\.unity3d$/i.test(e.name));
}

/** recursively unwrap a container until the game's own asset entries are on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 4) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (isOurs(entries)) return entries;
  const inner = entries.filter(e => /\.(apk|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && isOurs(sub)) return sub;
  }
  return entries;
}

/** the data.unity3d bundle bytes from a set of entries (loose or nested in an APK/XAPK). */
export function bundleFromEntries(entries: Entry[]): Uint8Array | null {
  const e = entries.find(x => /^assets\/bin\/Data\/data\.unity3d$/i.test(x.name));
  if (e) return e.data;
  for (const x of entries) {
    if (!/\.(apk|zip)$/i.test(x.name)) continue;
    try {
      const sub = unzipAll(x.data);
      const inner = sub.find(y => /^assets\/bin\/Data\/data\.unity3d$/i.test(y.name));
      if (inner) return inner.data;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---- XML/atlas reader ----

interface Img {
  key: string; w: number; h: number; x: number; y: number;
  size?: number; // the independent area nonogram size (bigmap mosaic pictures only)
  name?: Partial<Record<'en' | 'de' | 'ja' | 'fr' | 'es' | 'ko' | 'ru', string>>;
}

/** parse the <img …/> records of an <img_atlas> block (self-closing and open-close forms). */
function parseImg(xml: string): Img[] {
  const out: Img[] = [];
  const re = /<img\s+([^>]*?)(?:\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const at: Record<string, string> = {};
    for (const mm of m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g)) at[mm[1] ?? mm[3]] = mm[2] ?? mm[4];
    const key = at.key ?? '';
    const w = +at.w, h = +at.h, x = +at.x, y = +at.y;
    if (!key || !(w >= 1 && w <= 400 && h >= 1 && h <= 400)) continue;
    if (!(x >= 0 && y >= 0)) continue;
    out.push({
      key, w, h, x, y,
      size: at.size !== undefined ? +at.size : undefined,
      name: Object.assign({},
        at.name_en && { en: at.name_en },
        at.name_de && { de: at.name_de },
        at.name_ja && { ja: at.name_ja },
        at.name_fr && { fr: at.name_fr },
        at.name_es && { es: at.name_es },
        at.name_kr && { ko: at.name_kr },
        at.name_ru && { ru: at.name_ru },
      ),
    });
  }
  return out;
}

/** the records of one <img_atlas> block (by its atlasCode value). */
function recordsOf(xml: string, atlasCode: string): Img[] {
  const i = xml.indexOf(`atlasCode='${atlasCode}'`);
  if (i < 0) return [];
  const next = xml.indexOf('<img_atlas', i + 1);
  return parseImg(xml.slice(i, next < 0 ? undefined : next).replace(/^[^>]*>/, ''));
}

interface Atlas { w: number; h: number; px: Uint8Array }

/** a Texture2D object's leading name string. */
function objectNameOf(o: { classId: number; data: Uint8Array; le: boolean }): string | null {
  if (o.classId !== 28) return null;
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getInt32(0, true);
  if (!(len > 0 && len < 256 && 4 + len <= d.length)) return null;
  return new TextDecoder().decode(d.subarray(4, 4 + len));
}

/** parse w/h/complete/format from the Unity 6 Texture2D header after the name. */
function textureHeader(o: { data: Uint8Array }):
  { w: number; h: number; complete: number; format: number } | null {
  const d = o.data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const len = dv.getInt32(0, true);
  if (!(len > 0 && len < 256 && 4 + len <= d.length)) return null;
  let p = (4 + len + 3) & ~3;            // aligned end of the name string
  p += 1;                                 // m_IsAlphaChannelOptional (bool)
  p = (p + 3) & ~3;                       // padding
  if (p + 20 > d.length) return null;
  const w = dv.getInt32(p, true), h = dv.getInt32(p + 4, true);
  const complete = dv.getInt32(p + 8, true), format = dv.getInt32(p + 16, true);
  if (!(w >= 1 && w <= 4096 && h >= 1 && h <= 4096)) return null;
  return { w, h, complete, format };
}

/** raw RGBA32 pixels of a Unity 6 inline Texture2D object. The pixels sit at the object's end minus exactly
 *  16 bytes (the m_StreamData StreamingInfo tail: 4+4 bytes + an empty string), verified on both atlases
 *  (raw.length - w*h*4 - 16 .. raw.length - 16 matches UnityPy's decoded image byte-for-byte). */
function atlasImage(o: { data: Uint8Array }, w: number, h: number): Uint8Array | null {
  const d = o.data;
  const want = w * h * 4;
  const start = d.length - want - 16;
  if (want <= 0 || start < 0 || start + want > d.length) return null;
  return d.subarray(start, start + want);
}

/** find a Texture2D by exact name in the serialized files of a bundle; null when missing. */
function findAtlas(content: Map<string, Uint8Array>, name: string): Atlas | null {
  for (const [n, v] of content) {
    if (!/\.assets$/i.test(n) && !/^CAB-/.test(n)) continue;
    let objs: Awaited<ReturnType<typeof readSerialized>> = [];
    try { objs = readSerialized(v) as any; } catch { continue; }
    for (const o of objs) {
      if (o.classId !== 28) continue;
      if (objectNameOf(o) !== name) continue;
      const hh = textureHeader(o);
      if (!hh) continue;
      const px = atlasImage(o, hh.w, hh.h);
      if (!px) continue;
      return { w: hh.w, h: hh.h, px };
    }
  }
  return null;
}

/** an atlas cell: filled when alpha ≥ 128; the stored rows are Y-flipped (bottom-up). */
function atlasPixel(px: Uint8Array, AW: number, AH: number, x: number, y: number): boolean {
  const yy = AH - 1 - y;   // picture row y (top-down) is atlas row AH-1-y in the file
  if (x < 0 || yy < 0 || x >= AW || yy >= AH) return false;
  return px[(yy * AW + x) * 4 + 3] >= 128;
}

function rowsOfRegion(px: Uint8Array, AW: number, AH: number, x: number, y: number, w: number, h: number): string[] {
  const rows: string[] = [];
  for (let j = 0; j < h; j++) {
    let s = '';
    for (let i = 0; i < w; i++) s += atlasPixel(px, AW, AH, x + i, y + j) ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

function filledCount(rows: string[]): number {
  let n = 0;
  for (const r of rows) for (const c of r) if (c === '#') n++;
  return n;
}

/** the imgInfo XML among the bundle's serialized files. */
function xmlOf(content: Map<string, Uint8Array>): string | null {
  for (const [n, v] of content) {
    if (!/\.assets$/i.test(n) && !/^CAB-/.test(n)) continue;
    let objs: any[] = [];
    try { objs = readSerialized(v) as any; } catch { continue; }
    for (const o of objs) {
      const t = textAsset(o);
      if (t && t.name === 'imgInfo' && t.bytes.length > 1000) return new TextDecoder().decode(t.bytes);
    }
  }
  return null;
}

/** build the pack from the extracted bundle (data.unity3d). */
export function packFromBundle(bundle: Uint8Array): Pack {
  const content = readBundle(bundle);
  if (!content.size) throw new Error('Somnus: data.unity3d bundle empty.');

  const xml = xmlOf(content);
  if (!xml) throw new Error('Somnus: imgInfo XML atlas descriptor not found.');

  const normAtlas = findAtlas(content, 'somnus_normal map');
  const bigAtlas = findAtlas(content, 'somnus_bigmap');
  if (!normAtlas && !bigAtlas) throw new Error('Somnus: atlas textures (somnus_normal map / somnus_bigmap) not found.');

  const nImgs = recordsOf(xml, '2');
  const bImgs = recordsOf(xml, '3');
  if (!normAtlas && !nImgs.length) throw new Error('Somnus imgInfo has no normal records.');
  if (!bigAtlas && !bImgs.length) throw new Error('Somnus imgInfo has no bigmap records.');

  const levels: PackLevel[] = [];
  let pTotal = 0;

  // ---- NORMAL: whole grids (one nonogram per record) ----
  if (normAtlas) {
    const whole: Array<{ im: Img; rows: string[] }> = [];
    for (const im of nImgs) {
      const r = rowsOfRegion(normAtlas.px, normAtlas.w, normAtlas.h, im.x, im.y, im.w, im.h);
      if (!filledCount(r)) continue;      // fully empty grid — never a nonogram
      if (r.length !== im.h) continue;
      if (r.some(row => row.length !== im.w)) continue;
      whole.push({ im, rows: r });
    }
    if (whole.length) {
      const puzzles = whole.map(p => ({
        id: `n-${p.im.key}`,
        width: p.im.w, height: p.im.h, rows: p.rows,
        ...(p.im.name && Object.keys(p.im.name).length ? { name: p.im.name } : {}),
      }));
      levels.push(...numberedLevels(puzzles, {
        id: 'su-normal', group: 'su-normal', groupTitle: { en: 'Nonogram', de: 'Nonogramm' },
      }));
      pTotal += whole.length;
    }
  }

  // ---- BIGMAP: story pictures as independent area nonograms (the `size` attr is the area size) ----
  if (bigAtlas && bImgs.length) {
    const puzzles: PackPuzzle[] = [];
    for (const im of bImgs) {
      const A = im.size ?? 0;
      if (!(A >= 5 && A <= 30)) continue;      // 10 / 15 / 20 in this game
      const cols = Math.floor(im.w / A), rows = Math.floor(im.h / A);
      if (cols < 1 || rows < 1) continue;
      for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
        const w = A, h = A;
        const r = rowsOfRegion(bigAtlas.px, bigAtlas.w, bigAtlas.h, im.x + rx * A, im.y + ry * A, w, h);
        if (!filledCount(r)) continue;       // blank area — not a nonogram
        const no = ry * cols + rx + 1;
        puzzles.push({
          id: `b-${im.key}-${String(no).padStart(2, '0')}`,
          width: A, height: A, rows: r,
          ...(im.name && Object.keys(im.name).length ? { name: im.name } : {}),
        });
      }
    }
    if (puzzles.length) {
      levels.push(...numberedLevels(puzzles, {
        id: 'su-bigmap', group: 'su-bigmap', groupTitle: { en: 'Big Map', de: 'Big Map' },
      }));
      pTotal += puzzles.length;
    }
  }

  if (!levels.length) throw new Error('Somnus imgInfo decoded, but no usable nonogram grids.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-somnus-nonogram',
    title: { en: 'Somnus : Nonogram', de: 'Somnus : Nonogramm' },
    source: { game: 'Somnus : Nonogram', platform: 'Android', developer: 'Gamefox', year: 2026, file: `${pTotal} puzzles` },
    theme: {
      palette: {
        // dreamy dusk-bloom board (from the launcher's soft flower-blue gradient)
        accent: '#7e9bd0', fill: '#f7f3ec', cell: '#fbf8f1', grid: '#cdd8ea', clue: '#35476b',
        cross: '#df8080', cursor: '#ffb34d', bg: '#eef1f7', style: 'logic' as const,
      },
    },
    levels,
  };
  return pack;
}

// ---- icon ----

/** the biggest app_icon.png / ic_launcher.png (192×192 app_icon), decoded to RGBA */
function findIcon(entries: Entry[]): { icon: ReturnType<typeof makeIcon>; file: string } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/(app_icon|ic_launcher)[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (/(?:foreground|background)\.png$/i.test(e.name)) continue;
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
  try { raw = unzlibSync(all); } catch { try { raw = inflateSync(all); } catch { return null; } }
  const stride = w * bpp;
  const want = (stride + 1) * h;
  if (raw.length < want) return null;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++] ?? 0;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x] ?? 0;
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

// ---- entry points ----
registerImporter({
  name: 'Somnus : Nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try {
      const entries = entriesOf(data);
      const bundle = bundleFromEntries(entries);
      return !!bundle && isOurs(entries);
    } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    const bundle = bundleFromEntries(entries);
    if (!bundle) throw new Error('Not a Somnus Nonogram APK: assets/bin/Data/data.unity3d not found.');
    if (!hasManifestPackage(entries)) throw new Error(`Not a Somnus Nonogram APK: package ${PKG} missing.`);
    const pack = packFromBundle(bundle);
    const icon = findIcon(entries);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});

registerSetImporter({
  name: 'Somnus : Nonogram (Android)',
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
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      const data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    const bundle = bundleFromEntries(all);
    if (!bundle) throw new Error('Not a Somnus Nonogram APK: assets/bin/Data/data.unity3d not found.');
    if (!hasManifestPackage(all)) throw new Error(`Not a Somnus Nonogram APK: package ${PKG} missing.`);
    const pack = packFromBundle(bundle);
    const icon = findIcon(all);
    if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
    return [pack];
  },
});
