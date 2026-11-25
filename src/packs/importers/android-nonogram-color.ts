// Nonogram Color (com.easybrain.nonogram.color, Easybrain) — colour nonogram puzzles from its Android app bundles.
//
// The game is a Unity (il2cpp) app like its black/white sibling Nonogram.com. Its puzzles live in Easybrain's
// proprietary ".ebr" resource bundles (built by the com.easybrain.ebr Unity package, "GeneratedContainer" codegen).
// An .ebr file is:
//
//   +0  u8[4]  magic   E4 07 E8 03   (little-endian u16 0x07E4 0x03E8 = format marker)
//   +4  u8      container kind (0x02 here)
//   +5  u32     category count (not needed for reading)
//   +9  u32     resource count
//   +13 …       the resource payloads, one after another, each a gzip member
//               (1f 8b 08 …). No per-resource length table: the resources tile the file
//               as concatenated gzip members.
//
// Base APK 3.31.0 (2-arch .apkm) ships its whole catalogue in one bundle:
//
//   assets/NGData_Multicolor.ebr   14 865 gzip members:
//                                     member 0: JSON version ("3.1")
//                                     members 1..16: the 16 language localization tables (localizationList)
//                                     members 17+: 7 424 "named" colour level bins (flags 12/16/20/24)
//                                       and 7 424 flag=0 photo-fill RGB bins, interleaved (all counted).
//   assets/OneLineData_Multicolor.ebr  2 members: version + packed "One Line" tracing data (not a grid game).
//
// Colour level bin (named, flags 12/16/20/24):   (ee 07 e8 03)
//   +0  u8[4]  magic  EE 07 E8 03
//   +4  u16    height
//   +6  u16    width
//   +8  u8     flag: 12 = 2 colours, 16 = 3 colours, 20 = 4 colours, 24 = 5 colours  (flag = 4×(colours+1))
//   +9  u32    grid area (side², NOT a unique id — only 3 distinct values over all 7 424 bins)
//   +13 …      name: "<num>. <prefix>_<localizationKey>" NUL-terminated (the full name is globally unique,
//                verified 0 collisions; the suffix after the last '_' is the localization key)
//   …          zero padding (no fixed sentinel — the name is NUL-terminated and the rest is zeros)
//   +77        palette: (flag/4) RGBA entries, each = [R G B A]  — index 0 is the background/backdrop colour,
//              indices 1..nCol are the puzzle colours. (gridStart = 77 + flag, verified on all 7 424 bins.)
//   +77+flag   grid: width×height bytes, one palette index per cell (0 = empty/backdrop, 1..nCol = colour).
//
// So flag encodes the colour count directly: flag 12 → 2 colours, 16 → 3, 20 → 4, 24 → 5.
//
// The flag=0 bins (7 424) are the game's photo-fill "colour by number"-style renderings (97.7% are fully filled;
// the few with empty cells have no consistent line structure). They are not playable logic puzzles: the 
// playable colour puzzles are the named bins, which carry real names, localization, a palette and a 
// non-trivial grid (93.2% line-solvable, colour-unique 94.7%). The importer imports exactly the named bins.
//
// Modes: the game's COLOR mode only (every named bin is a colour puzzle; MomoGram marks them colorGame +
// colorOnly). There is NO black/white mode and NO Mega/Jupiter mode — verified in the il2cpp metadata
// (only "someGameObject" / "MegabytesToBytes" hits, no nonogram "mega"; there is a separate OneLine tracing
// mode whose data is OneLineData_Multicolor.ebr, a non-grid format like the black/white game — not imported).
//
// The colours come straight from the game: index 0 = backdrop, 1..nCol = the palette colours, so every bin's
// own palette is used verbatim (≤ 5 colours, well under MomoGram's 32-colour ceiling for colorGame puzzles).
//
// Stable ids: every named bin has a globally-unique game name ("<num>. <tag>_<locKey>", 0 collisions), used as
// the puzzle id, exactly like the black/white Nonogram.com importer.
//
// Names: the localization key (the part after the last '_') is looked up in the 16-language tables (members 1..16),
// giving the puzzle's name per language (the tables carry 7 326 keys each and cover all puzzle locKeys).
//
// Container-agnostic (owner requirement): detect/read never depends on the file extension. The real markers are
//   - the AndroidManifest.xml (binary XML) containing the UTF-16LE package name "com.easybrain.nonogram.color",
//   - the assets/NGData_Multicolor.ebr puzzle bundle: EBR magic + ≥ 1 decoded named colour level bin.
// .xapk / .apkm / .zip are zips that hold the base APK (a zip with those assets); the importer unwraps outer
// containers recursively, and an already-extracted folder is read by the Set variant below (same read path).
// The separate black/white "Nonogram" app (com.easybrain.nonogram, android-nonogram-com.ts) has NGData.ebr but
// no NGData_Multicolor.ebr, and this app has no NGData.ebr — the two importers never overlap.
//
// Icon: like the black/white sibling, this app's launcher icon is NOT ic_launcher*.png but res/mipmap-*/app_icon.png
// and app_icon_round.png (plus adaptive app_icon.xml at anydpi). The importer picks the biggest of app_icon*/
// ic_launcher* (the standalone PNGs, never the adaptive foreground/background layers), decoded to RGBA for
// pack.icon. These PNGs are zlib streams (0x78 0xda), so they need unzlibSync (raw inflate reads garbage on them).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync, gunzipSync, unzlibSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

const EBR = [0xe4, 0x07, 0xe8, 0x03];
const LVL = [0xee, 0x07, 0xe8, 0x03];
const PKG = 'com.easybrain.nonogram.color';
const NAMED_FLAGS = new Set([12, 16, 20, 24]);

/** true when the entries carry Nonogram Color's marker set (manifest package + the multicolor EBR bundle). */
export function looksLike(entries: Entry[]): boolean {
  let hasManifest = false, hasEbr = false;
  for (const e of entries) {
    if (!hasManifest && /^AndroidManifest\.xml$/i.test(e.name)) {
      const d = e.data;
      const needle = new TextEncoder().encode(PKG);
      for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
        let all = true;
        for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
        if (all) { hasManifest = true; break; }
      }
    }
    if (!hasEbr && /^assets\/NGData_Multicolor\.ebr$/i.test(e.name)) {
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

/** recursively unwrap a container until the game's own assets are on top (APKM → base APK → assets).
 *  An .apkm bundles base.apk + config splits; only base.apk carries assets/NGData_Multicolor.ebr, the config
 *  splits are native libs. We prefer the inner apk that actually contains an assets/NGData_Multicolor.ebr entry
 *  (avoids descending into a large config split that has no puzzle data). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  const inners = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length);
  // prefer an inner apk that (when unzipped) already contains the EBR marker
  for (const inner of inners) {
    try {
      const subFiles = unzipAll(inner.data);
      if (subFiles.some(e => /^assets\/NGData_Multicolor\.ebr$/i.test(e.name))) {
        const sub = entriesOf(inner.data, depth + 1);
        if (sub.length) return sub;
      }
    } catch { /* unreadable inner */ }
  }
  for (const inner of inners) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length) return sub;
  }
  return entries;
}

/** split a gzip-member stream (the EBR resource payload area) into individual members (see android-nonogram-com). */
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

/** the 16 localization languages, in EBR member order (identified by the content of each member). */
const LANGS: (string | null)[] = [
  'tr', 'ja', 'de', 'ru', 'pl', 'pt', 'it', 'en',
  'fr', 'ko', 'zh-Hans', 'vi', 'zh-Hant', 'pt', 'th', 'es',
];

function u16(d: Uint8Array, o: number): number { return d[o] | (d[o + 1] << 8); }

/** a named colour level bin — the game's playable colour puzzle. */
interface ColorBin {
  h: number; w: number; flag: number;       // flag 12/16/20/24 → nCol = flag/4 - 1 colours
  name: string;                             // "<num>. <tag>_<locKey>" (globally unique)
  locKey?: string;                          // localization key (part after the last '_')
  pal: string[];                            // 1 + nCol colours (#rrggbb); index 0 = backdrop/empty
  grid: Uint8Array;                         // w*h palette indices (0 = empty)
}

/** decode a named colour bin; null when it isn't one. */
export function parseColorBin(b: Uint8Array): ColorBin | null {
  if (b.length < 77 + 4 || b[0] !== LVL[0] || b[1] !== LVL[1] || b[2] !== LVL[2] || b[3] !== LVL[3]) return null;
  const h = u16(b, 4), w = u16(b, 6), flag = b[8];
  if (!NAMED_FLAGS.has(flag)) return null;
  if (!(h >= 5 && h <= 20 && w >= 5 && w <= 20)) return null;
  const gridStart = 77 + flag;            // palette of flag/4 RGBA entries, then the grid
  const nCol = flag / 4 - 1;              // 3 → 2 colours, 4 → 3, 5 → 4, 6 → 5
  if (gridStart + w * h !== b.length) return null;
  let ne = 13;
  for (let i = 13; i < b.length && i < 77; i++) if (b[i] === 0) { ne = i; break; }
  const name = new TextDecoder().decode(b.subarray(13, ne)).trim();
  const lm = /_([a-zA-Z0-9][a-zA-Z0-9_]*)$/.exec(name);
  const pal: string[] = [];
  for (let i = 0; i < 1 + nCol; i++) {
    const r = b[77 + i * 4], g = b[77 + i * 4 + 1], bl = b[77 + i * 4 + 2];
    pal.push('#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + bl.toString(16).padStart(2, '0'));
  }
  return { h, w, flag, name: name || `unknown`, locKey: lm?.[1], pal, grid: b.slice(gridStart, gridStart + w * h) };
}

/** find the biggest standalone launcher PNG (app_icon* / ic_launcher*, not adaptive layers) and decode to RGBA. */
function findIcon(entries: Entry[]) {
  let best: Entry | null = null;
  for (const e of entries) {
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

/** minimal PNG decoder (8-bit RGBA / RGB / grey, non-interlaced, multi-IDAT); zlib streams (see sibling importer). */
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

/** gather the named colour bins from an .ebr member list. */
function gather(members: Uint8Array[]): ColorBin[] {
  const out: ColorBin[] = [];
  for (const m of members) {
    const p = parseColorBin(m);
    if (p) out.push(p);
  }
  return out;
}

/** the localization tables (members 1..16) — same 16-language list as the black/white game. */
function localization(members: Uint8Array[]): Map<string, Record<string, string>> {
  const loc = new Map<string, Record<string, string>>();
  for (let i = 1; i <= 16; i++) {
    const raw = members[i];
    const lang = LANGS[i - 1];
    if (!lang || !raw) continue;
    try {
      const obj = JSON.parse(new TextDecoder().decode(raw));
      const table: Record<string, string> = {};
      for (const x of obj.localizationList || []) table[String(x.key)] = String(x.value);
      if (Object.keys(table).length > 100) loc.set(lang, table);
    } catch { /* not a localization member */ }
  }
  return loc;
}

/** shared read: entries → the pack */
export function packFromEntries(entries: Entry[]): Pack {
  let raw = null;
  for (const e of entries) if (/^assets\/NGData_Multicolor\.ebr$/i.test(e.name)) raw = e.data;
  if (!raw) throw new Error('Nonogram Color NGData_Multicolor.ebr not found.');
  const members = splitGzipMembers(raw);
  const bins = gather(members);
  if (!bins.length) throw new Error('Nonogram Color level data not found.');

  const loc = localization(members);

  // puzzle name lookup: locKey → { lang: value }, else a generic title.
  const nameFor = (locKey: string | undefined, fallback: string): Record<string, string> | undefined => {
    if (!locKey) return undefined;
    const out: Record<string, string> = {};
    let any = false;
    for (const [lang, table] of loc) {
      const v = table[locKey.toLowerCase()] ?? table[locKey];
      if (v) { out[lang] = v; any = true; }
    }
    if (any) return out;
    return { en: fallback };
  };

  /** stable, unique id from a bin's globally-unique game name ("12. h_multhousemult"). */
  const stableId = (p: ColorBin) => {
    const base = (p.name || `${p.w}x${p.h}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return `c-${base}`;
  };

  const bySize = new Map<string, ColorBin[]>();
  for (const p of bins) {
    const k = `${p.w}x${p.h}`;
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k)!.push(p);
  }

  const levels: PackLevel[] = [];
  for (const k of [...bySize.keys()].sort((a, b) => {
    const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
    return aw * ah - bw * bh;
  })) {
    const list = bySize.get(k)!;
    const puzzles: PackPuzzle[] = [];
    for (const p of list) {
      const rows: string[] = [];
      const colorRows: string[] = [];
      for (let y = 0; y < p.h; y++) {
        let r = '', cr = '';
        for (let x = 0; x < p.w; x++) {
          const v = p.grid[y * p.w + x];
          if (v > 0) { r += '#'; cr += (v - 1).toString(36); }
          else { r += '.'; cr += '.'; }
        }
        rows.push(r); colorRows.push(cr);
      }
      puzzles.push({
        id: stableId(p), width: p.w, height: p.h, rows,
        colorGame: true, colorOnly: true,
        color: { palette: p.pal.slice(1), rows: colorRows },
        name: nameFor(p.locKey, `${p.w}×${p.h}`),
      });
    }
    const label = k.replace('x', '×');
    levels.push(...numberedLevels(puzzles, {
      id: `size-${k}`, group: `size-${k}`, groupTitle: { en: label, de: label },
    }));
  }

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-nonogram-color',
    title: { en: 'Nonogram Color', de: 'Nonogram Color' },
    source: {
      game: 'Nonogram Color', platform: 'Android', developer: 'Easybrain',
      file: `${bins.length} colour puzzles`,
    },
    theme: { palette: {
      accent: '#3878e0', fill: '#2b2b2b', cell: '#ffffff', grid: '#c9d4e0', clue: '#202020',
      cross: '#e05050', cursor: '#ffb340', bg: '#f4f7fa', style: 'default',
    } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${bins.length} colour puzzles (icon ${icon.name} ${icon.w}x${icon.h})`; }
  return pack;
}

registerImporter({
  name: 'Nonogram Color (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonogram Color APK: marker bundles missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Nonogram Color (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // claim a folder only when it already carries this game's own marker bundle — claiming `.` on any
      // AndroidManifest.xml would steal the root from every other Android game in the same pick (the
      // Set import loop hands a root to the first importer that claims it). A picked folder can be
      // the base APK itself (root '.') or an enclosing folder ('.*/(assets/…)').
      const m = /^(.*?)(?:\/|^)assets\/NGData_Multicolor\.ebr$/i.exec(n);
      if (m) {
        const dir = m[1].replace(/\/$/, '');
        roots.add(dir || '.');
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
    if (!looksLike(all)) throw new Error('Not a Nonogram Color APK: marker bundles missing.');
    return [packFromEntries(all)];
  },
});
