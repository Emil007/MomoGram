// Nonogram.com (com.easybrain.nonogram, Easybrain) — nonogram puzzles from its Android app bundles.
//
// The game is a Unity (il2cpp) app. Its puzzles live in Easybrain's proprietary ".ebr" resource bundles
// (built by the com.easybrain.ebr Unity package, "GeneratedContainer" codegen). An .ebr file is:
//
//   +0  u8[4]  magic   E4 07 E8 03   (little-endian u16 0x07E4 0x03E8 = format marker)
//   +4  u8      container kind (0x02 here)
//   +5  u32     category count (not needed for reading)
//   +9  u32     resource count
//   +13 …       the resource payloads, one after another, each a gzip member
//               (1f 8b 08 …). No per-resource length table: the resources tile the file
//               as concatenated gzip members (verified: every member count == the u32 at +9).
//
// Base APK 5.35.0 ships four such bundles under assets/:
//
//   NGData.ebr          17 785 members: loc(17) + 8 094 classic flag=8 + 7 981 multicolor flag=0
//                        level bins (interleaved), plus ~1 700 small 4-byte "difficulty"
//                        records and truncated large-bin stubs that are not puzzles.
//   NGLayeredLevels.ebr 57 members: manifest + 40 "unique" LAYERED-level bins + loc(16).
//                        The layered bins start "01 0a 00 01" and are a separate stack format
//                        (not the plain cell grid) — see ANALYSIS.md; not imported.
//   NGParts4Levels.ebr  701 members: manifest + 227 classic + 228 multicolor level bins (levels/1,
//                        levels/2) + ~200 difficulty records + loc(17). Not imported by the first
//                        stream; imported here (they are extra themed levels).
//   OneLineData.ebr     9 members: 8 one-line-picture bins (non-grid format) + version.
//                        Not imported (see ANALYSIS.md).
//
// Level bin (classic, flag 8 or 12):   (ee 07 e8 03)
//   +0  u8[4]  magic EE 07 E8 03
//   +4  u16    height
//   +6  u16    width
//   +8  u8     flag: 8 = classic black/white, 12 = black/white (same grid layout), 0 = multicolor
//   +9  u32    puzzle number ("Indexes" in the game's NGLevelData log) — NOTE: this is the grid
//              area in classic bins (side²) and 3×side² in multicolor bins, NOT a unique id.
//   +13 …      name: "NN. <tag>_<localizationkey>" NUL-terminated (classic only), NN = puzzle number
//   …          zero padding up to a fixed marker
//   +77        FF FF FF FF 00 00 00 FF   (8-byte sentinel before the grid)
//   +85        width×height bytes: 0 = empty, 1 = filled   (the solved picture)
//   (grid offset is a fixed +85 from the record start, verified on all classic grids)
//
// Level bin (multicolor, flag 0):   (ee 07 e8 03)
//   +0  u8[4]  magic
//   +4  u16    height
//   +6  u16    width
//   +8  u8     flag 0
//   +9  u32    grid area (3×side² here, not a unique id)
//   +13 …      width×height×3 bytes, row by row, one RGB triple per cell
//              (0,0,0) = empty, anything else = that cell's colour
//
// The colour mode is a real multicolor game mode: every level has a colour version (cell values > 1
// are colours — clue block colours follow the cell colour; see src/game/color.ts). The importer keeps
// the black/white projection (rows) and the colour picture (color.palette + color.rows) for every
// multicolor level with ≤ 32 colours (MomoGram's colour-puzzle ceiling for colorGame, color.ts); the
// few photo-like multicolor pictures with > 32 colours have no black/white twin and are imported in
// their black/white projection so no puzzle is lost.
//
// Stable ids: classic puzzles carry the game's own globally-unique name ("NN. tag_locKey", unique
// across both bundles — verified 0 collisions), used as the puzzle id. Multicolor puzzles carry no
// name, so they get a stable per-size sequence id (m<size>-NNNN). The "grid area" u32 at +9 is NOT
// unique and is never used as an id.
//
// Names: the classic name "100. 4x1_fouronejulcounter" carries the localization key (the part after
// the last '_', case-insensitive); the game's 16-language localization files (NGData.ebr members 1..16)
// give the puzzle's name per language. Multicolor levels carry no name, so they are listed by number.
//
// Container-agnostic (owner requirement): detect/read never depends on the file extension. The real
// markers that decide are
//   - the AndroidManifest.xml (binary XML) containing the UTF-16LE package name "com.easybrain.nonogram",
//   - the assets/*.ebr puzzle bundles: at least NGData.ebr (and optionally NGParts4Levels.ebr) with
//     the magic + a decoded level record set.
// .xapk / .apkm / .zip are zips that hold the base APK (a zip with those assets); the importer unwraps
// outer containers recursively (like the kungfu importer), and an already-extracted folder is read by
// the Set variant below (same read path). The separate "Nonogram Color" app has a different package
// (com.easybrain.nonogram.color) and no NGData.ebr, so the two importers never overlap.
//
// Icon: this app's launcher icon is NOT ic_launcher*.png — it ships as res/mipmap-*/app_icon.png and
// app_icon_round.png (plus an adaptive app_icon.xml at anydpi). The importer picks the biggest of
// app_icon*/ic_launcher* (the standalone PNGs, never the adaptive foreground/background layers),
// decoded to RGBA for pack.icon. Note: these PNGs are zlib streams (0x78 0xda), so they need
// unzlibSync (raw inflate reads garbage on them).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync, gunzipSync, unzlibSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

const EBR = [0xe4, 0x07, 0xe8, 0x03];
const LVL = [0xee, 0x07, 0xe8, 0x03];

/** true when the entries carry Nonogram.com's marker set (manifest package + ebr bundles). */
export function looksLike(entries: Entry[]): boolean {
  let hasManifest = false, hasEbr = false;
  for (const e of entries) {
    if (!hasManifest && /^AndroidManifest\.xml$/i.test(e.name)) {
      const d = e.data;
      const needle = new TextEncoder().encode('com.easybrain.nonogram');
      for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
        let all = true;
        for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
        if (all) { hasManifest = true; break; }
      }
    }
    if (/^assets\/NGData\.ebr$/i.test(e.name) || /^assets\/NGLayeredLevels\.ebr$/i.test(e.name) ||
        /^assets\/NGParts4Levels\.ebr$/i.test(e.name)) {
      const d = e.data;
      if (d.length >= 13 && d[0] === EBR[0] && d[1] === EBR[1] && d[2] === EBR[2] && d[3] === EBR[3]) hasEbr = true;
    }
    if (hasManifest && hasEbr) return true;
  }
  return hasManifest && hasEbr;
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's own assets are on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  const inner = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length) return sub;
  }
  return entries;
}

/** split a gzip-member stream (the EBR resource payload area) into individual members.
 *  fflate's gunzipSync() stops at the first deflate-block flush when the input carries trailing
 *  member data (concatenated gzip streams), so each member is decompressed over its own exact
 *  byte range (from its 1f 8b 08 magic up to the next magic): slicing forces a single, complete
 *  member per call and the whole per-language / per-puzzle resource is recovered. */
export function splitGzipMembers(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const starts: number[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0x1f && data[i + 1] === 0x8b && data[i + 2] === 0x08) starts.push(i);
  }
  for (let k = 0; k < starts.length; k++) {
    const begin = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : data.length;
    try { out.push(gunzipSync(data.subarray(begin, end))); } catch { /* false positive */ }
  }
  return out;
}

/** the 16 localization languages, in EBR member order (NGData/NGParts/NGLayered all use it). */
const LANGS: (string | null)[] = [
  'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pl',
  'pt', 'pt', 'ru', 'th', 'tr', 'vi', 'zh-Hans', 'zh-Hant',
];

function u32(d: Uint8Array, o: number): number { return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); }
function u16(d: Uint8Array, o: number): number { return d[o] | (d[o + 1] << 8); }

interface LevelBin {
  h: number; w: number; flag: number; num: number;   // num = game puzzle number (grid area field)
  name?: string;          // classic: "NN. <tag>_<key>" (globally unique)
  locKey?: string;        // classic localization key
  mono?: Uint8Array;      // classic: h*w 0/1 grid
  rgb?: Uint8Array;       // multicolor: h*w*3 RGB
}

/** decode a classic or multicolor level bin; null when it isn't one. */
export function parseLevelBin(b: Uint8Array): LevelBin | null {
  if (b.length < 13 || b[0] !== LVL[0] || b[1] !== LVL[1] || b[2] !== LVL[2] || b[3] !== LVL[3]) return null;
  const h = u16(b, 4), w = u16(b, 6), flag = b[8], num = u32(b, 9);
  if (!(h >= 2 && h <= 60 && w >= 2 && w <= 60)) return null;
  if (flag === 8 || flag === 12) {
    const g = b.subarray(85, 85 + h * w);
    if (g.length !== h * w) return null;
    for (let i = 0; i < g.length; i++) if (g[i] !== 0 && g[i] !== 1) return null;
    let ne = 13;
    for (let i = 13; i < b.length && i < 85; i++) if (b[i] === 0) { ne = i; break; }
    const name = new TextDecoder().decode(b.subarray(13, ne)).trim();
    const lm = /_([a-zA-Z][a-zA-Z0-9_]*)$/.exec(name);
    return { h, w, flag, num, name: name || undefined, locKey: lm?.[1], mono: g };
  }
  if (flag === 0) {
    const g = b.subarray(13, 13 + h * w * 3);
    if (g.length !== h * w * 3) return null;
    return { h, w, flag, num, rgb: g };
  }
  return null;
}

function monoRows(w: number, h: number, g: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += g[y * w + x] ? '#' : '.';
    rows.push(r);
  }
  return rows;
}

// MomoGram's colour ceiling for colorGame puzzles (src/game/color.ts colorOf()): 32.
const MAX_COLOR_GAME = 32;

/** multicolor grid (w*h*3 RGB) → MomoGram colour picture (palette + rows) and mono basis rows.
 *  Returns null when the picture uses more than MAX_COLOR_GAME distinct colours (those stay mono). */
function colorParts(w: number, h: number, rgb: Uint8Array):
  { palette: string[]; rows: string[]; mono: string[]; nColors: number } | null {
  const map = new Map<string, string>();
  const palette: string[] = [];
  const cro = Array.from({ length: h }, () => new Array<string>(w).fill('.'));
  const mono = Array.from({ length: h }, () => new Array<string>(w).fill('.'));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = rgb[(y * w + x) * 3], g = rgb[(y * w + x) * 3 + 1], bl = rgb[(y * w + x) * 3 + 2];
    if (r === 0 && g === 0 && bl === 0) continue;
    mono[y][x] = '#';
    const key = r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + bl.toString(16).padStart(2, '0');
    let idx = map.get(key);
    if (idx === undefined) {
      idx = palette.length.toString(36);
      palette.push('#' + key);
      map.set(key, idx);
    }
    cro[y][x] = idx;
  }
  if (palette.length === 0 || palette.length > MAX_COLOR_GAME) return null;
  return { palette, rows: cro.map(r => r.join('')), mono: mono.map(r => r.join('')), nColors: palette.length };
}

/** find the biggest standalone launcher PNG (app_icon* / ic_launcher*, not adaptive layers) and decode to RGBA. */
function findIcon(entries: Entry[]) {
  let best: Entry | null = null;
  for (const e of entries) {
    // res/<density>/{app_icon,app_icon_round,ic_launcher,ic_launcher_round}.png — never
    // the *_foreground / *_background adaptive layers or the .9 patches.
    if (!/^res\/[^/]+\/(?:app_icon|ic_launcher)[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (/(?:foreground|background)\.png$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { name: best.name, icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), w: px.w, h: px.h };
}

/** minimal PNG decoder (8-bit RGBA / RGB / grey, non-interlaced, multi-IDAT).
 *  Android launcher PNGs store the scanlines as a single zlib stream (0x78), so the IDAT payload is
 *  read with unzlibSync — raw inflate (inflateSync) produces garbage on these files. */
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
  try { raw = unzlibSync(all); } catch { return null; }
  const stride = w * bpp;
  const want = (stride + 1) * h;
  if (raw.length < want) return null;
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
      const ci = x * bpp;
      const di = (y * w + x) * 4;
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

interface RawBundles { ndata: Uint8Array[]; nparts: Uint8Array[] }

function ebrBundles(entries: Entry[]): RawBundles {
  const out: RawBundles = { ndata: [], nparts: [] };
  for (const e of entries) {
    if (/^assets\/NGData\.ebr$/i.test(e.name)) out.ndata = splitGzipMembers(e.data);
    else if (/^assets\/NGParts4Levels\.ebr$/i.test(e.name)) out.nparts = splitGzipMembers(e.data);
  }
  return out;
}

/** shared read: entries → the pack */
export function packFromEntries(entries: Entry[]): Pack {
  const bundles = ebrBundles(entries);
  if (!bundles.ndata.length) throw new Error('Nonogram.com NGData.ebr not found.');

  // localization: NGData members 1..16 are the 16 languages.
  const loc = new Map<number, Record<string, string>>();
  for (let i = 0; i < 16; i++) {
    const raw = bundles.ndata[i + 1];
    const lang = LANGS[i];
    if (!lang || !raw) continue;
    try {
      const obj = JSON.parse(new TextDecoder().decode(raw));
      const table: Record<string, string> = {};
      for (const x of obj.localizationList || []) table[String(x.key)] = String(x.value);
      if (Object.keys(table).length > 100) loc.set(i, table);
    } catch { /* not a localization member */ }
  }

  /** gather classic + multicolor level bins from an ebr member list. */
  const gather = (members: Uint8Array[]): { classic: (LevelBin & { src: number })[]; color: (LevelBin & { src: number })[] } => {
    const classic: any[] = [], color: any[] = [];
    for (let i = 0; i < members.length; i++) {
      const p = parseLevelBin(members[i]);
      if (!p) continue;
      if (p.mono) classic.push({ ...p, src: i });
      else if (p.rgb) color.push({ ...p, src: i });
    }
    return { classic, color };
  };

  const nd = gather(bundles.ndata);
  const np = gather(bundles.nparts);

  const allClassic = [...nd.classic, ...np.classic];
  const allColor = [...nd.color, ...np.color];

  /** puzzle name lookup: <key> → { lang: value }, else a generic title. */
  const nameFor = (locKey: string | undefined, fallback: string): Record<string, string> | undefined => {
    if (!locKey) return undefined;
    const out: Record<string, string> = {};
    let any = false;
    for (const [li, table] of loc) {
      const lang = LANGS[li];
      if (!lang) continue;
      const v = table[locKey.toLowerCase()] ?? table[locKey];
      if (v) { out[lang] = v; any = true; }
    }
    if (any) return out;
    return { en: fallback };
  };

  /** stable, unique id from a classic bin's globally-unique game name ("100. 4x1_fouronejulcounter"). */
  const classicId = (p: { w: number; h: number; name?: string }) => {
    const base = (p.name || `${p.w}x${p.h}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return `c-${base}`;
  };

  const puzzlesForSize = (classic: (LevelBin & { src: number })[], color: (LevelBin & { src: number })[]): PackPuzzle[] => {
    const puzzles: PackPuzzle[] = [];
    // classic black/white
    for (const p of classic) {
      const pz: PackPuzzle = {
        id: classicId(p), width: p.w, height: p.h,
        rows: monoRows(p.w, p.h, p.mono!),
        name: nameFor(p.locKey, `${p.w}×${p.h}`),
      };
      if (!pz.name || Object.keys(pz.name).length === 0) delete pz.name;
      puzzles.push(pz);
    }
    // multicolor; the very colourful pictures (> MAX_COLOR_GAME colours) fall back to their mono
    // projection as classic puzzles so nothing is lost.
    let mSeq = 0, cSeq = 0;
    for (const p of color) {
      const cp = colorParts(p.w, p.h, p.rgb!);
      if (!cp) {
        // too many colours for a colour picture — keep the black/white projection as a classic puzzle
        puzzles.push({
          id: `c-mono${p.num}-${++cSeq}`, width: p.w, height: p.h,
          rows: monoRowsOf(p.w, p.h, p.rgb!),
        });
        continue;
      }
      if (cp.nColors <= 1) {
        // a single colour is just a black/white puzzle
        puzzles.push({ id: `c-mono${p.num}-${++cSeq}`, width: p.w, height: p.h, rows: cp.mono });
        continue;
      }
      puzzles.push({
        id: `m-${p.w}x${p.h}-${++mSeq}`, width: p.w, height: p.h,
        rows: cp.mono, colorGame: true, colorOnly: true, color: { palette: cp.palette, rows: cp.rows },
        name: { en: `${p.w}×${p.h} #${p.num}` },
      });
    }
    return puzzles;
  };

  const levels: PackLevel[] = [];
  const bySize = new Map<string, { cl: (LevelBin & { src: number })[]; co: (LevelBin & { src: number })[] }>();
  for (const p of allClassic) {
    const k = `${p.w}x${p.h}`;
    if (!bySize.has(k)) bySize.set(k, { cl: [], co: [] });
    bySize.get(k)!.cl.push(p);
  }
  for (const p of allColor) {
    const k = `${p.w}x${p.h}`;
    if (!bySize.has(k)) bySize.set(k, { cl: [], co: [] });
    bySize.get(k)!.co.push(p);
  }
  for (const k of [...bySize.keys()].sort((a, b) => {
    const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
    return aw * ah - bw * bh;
  })) {
    const { cl, co } = bySize.get(k)!;
    if (!cl.length && !co.length) continue;
    const label = k.replace('x', '×');
    const puzzles = puzzlesForSize(cl, co);
    levels.push(...numberedLevels(puzzles, {
      id: `size-${k}`, group: `size-${k}`, groupTitle: { en: label, de: label },
    }));
  }

  if (!levels.length) throw new Error('Nonogram.com level data not found.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-nonogram-com',
    title: { en: 'Nonogram.com', de: 'Nonogram.com' },
    source: {
      game: 'Nonogram.com', platform: 'Android', developer: 'Easybrain',
      file: `${allClassic.length} classic + ${allColor.length} colour = ${allClassic.length + allColor.length} puzzles`,
    },
    theme: { palette: {
      accent: '#4a90d9', fill: '#2b2b2b', cell: '#ffffff', grid: '#c9d4e0', clue: '#202020',
      cross: '#e05050', cursor: '#ffb340', bg: '#f4f7fa', style: 'default',
    } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${allClassic.length} classic + ${allColor.length} colour (icon ${icon.name} ${icon.w}x${icon.h})`; }
  return pack;
}

// mono projection of an RGB grid (used for the >32-colour pictures)
export function monoRowsOf(w: number, h: number, rgb: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      r += (rgb[i] !== 0 || rgb[i + 1] !== 0 || rgb[i + 2] !== 0) ? '#' : '.';
    }
    rows.push(r);
  }
  return rows;
}

registerImporter({
  name: 'Nonogram.com (Android)',
  version: 2,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonogram.com APK: marker bundles missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Nonogram.com (Android)',
  version: 2,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (/^assets\/NGData\.ebr$/i.test(n)) {
        // an already-extracted base APK folder: its assets/NGData.ebr lives here with the manifest
        roots.add(n.slice(0, n.indexOf('assets/')) || '.');
      } else if (/^AndroidManifest\.xml$/i.test(n)) {
        roots.add('.');
      }
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
    if (!looksLike(all)) throw new Error('Not a Nonogram.com APK: marker bundles missing.');
    return [packFromEntries(all)];
  },
});
