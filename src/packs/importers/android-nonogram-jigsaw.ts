// Nonogram+ Jigsaw Puzzle Game (com.yunbu.nonogram.puzzle, yunbu) for Android — nonogram
// solutions from its Cocos2d-x app bundle. The game is a "nonogram + jigsaw" hybrid: the
// user clears black/white nonogram picture puzzles to earn pieces that complete a separate
// jigsaw assembly. The puzzles imported here are the NONOGRAM grids (the jigsaw assembly is
// a picture-dragging minigame, no grid — not imported; see ANALYSIS.md).
//
// The APK is a plain zip (XAPK/APKM are zips holding the base APK next to language/ABI splits;
// an already-extracted base APK or folder is read by the Set variant below). Puzzle data ships
// as two CSV files per theme under assets/data/:
//
//   assets/data/<T>_puzzles.csv     u32 decompressed-length, then a zlib body of <T> lines,
//                                   each  "T|pid|rowSteps|colSteps|diff|w|h"  ('|' separated):
//                                     T   = theme id (101..220, 3001..3023, 4001..4006, 5003/5004)
//                                     pid = puzzle id within the theme (0..n-1)
//                                     w h = grid width/height
//                                     (the other three fields are hint/steps/difficulty meta)
//   assets/data/<T>_datas.csv       u32 puzzle count, then count u32 byte-offsets (×4), then one
//                                   little-endian record per puzzle, 4-byte aligned: the solved
//                                   picture, 1 bit per cell, row-major, LSB first order within each
//                                   byte (verified: this order is line-solvable / picture-correct —
//                                   MSB first is not). Not every puzzle in the theme holds a full
//                                   grid here: the hybrid game stores "jigsaw-piece" nonograms that
//                                   are only a fraction of the theme picture (record shorter than
//                                   w*h bits). Those are dropped (they are not solvable nonograms);
//                                   every record with the full w×h bits is a real nonogram.
//
// The puzzle rows (=solution pictures) are the authority: MomoGram derives row/column clues from
// them. Names: themes 101..144 (and the "pic" themes 2001..2006) have curated per-language names
// in assets/data/local_<lang>.csv (u32 len + zlib body, lines "T|Name"); the expanded themes
// 145..220, 3001..3023, 4001..4006 and 5003/5004 have no names anywhere in the APK (verified) and
// are titled by theme number. The game has no per-puzzle names at all.
//
//   Game / distribution                              Puzzles (full w×h grids, 8.4)
//   Nonogram+ Jigsaw: themes 101..220                101..144 named: 40-105 full each
//                                                   145..220 unnamed: 80-105 full each
//   Expedition packs 3001..3023 (20×20/25×25/30×30)  29 full of 30 each
//   "4001.." and "5003/5004" jigsaw-mixed themes     65-96 full of 100-120 each
//   Total (see VERIFIED.md):                        11808 full nonogram solutions
//                                                    (10162 unique, 9892 line-solvable with the
//                                                     repo puzzleScore, 11808 = all full grids)
//
// Marker set for detect (container-agnostic, no extension gating — owner requirement):
//   - a puzzle CSV set: assets/data/<T>_puzzles.csv + matching <T>_datas.csv with a valid count /
//     offset table / zlib body, and
//   - the binary AndroidManifest.xml carrying the package name "com.yunbu.nonogram.puzzle".
// .xapk/.apkm/.zip wrappers are unwrapped recursively (like the kungfu/nonogram.com importers).
//
// Icon: res/mipmap-*xxhdpi-v4/ic_launcher*.png → the biggest launcher PNG decoded to RGBA.
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, PackIcon, makeIcon } from '../format';
import { unzipSync, inflateSync, unzlibSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

/** 1 = confident the entries are Nonogram+ Jigsaw: many f\d+_puzzles.csv / _datas.csv pairs. The
 *  <T>_puzzles.csv + <T>_datas.csv pair (per theme) is the game's own marker; no other app ships
 *  assets/data/\d+_datas.csv/.csv pairs. (The AndroidManifest package check is only used by detect,
 *  not here, so an already-extracted folder without the manifest still imports — like the kungfu importer.) */
export function looksLike(entries: Entry[]): boolean {
  let csvPairs = 0;
  for (const e of entries) {
    if (!/^assets\/data\/(\d+)_puzzles\.csv$/i.test(e.name)) continue;
    const tid = +e.name.match(/^assets\/data\/(\d+)_puzzles\.csv$/i)![1];
    if (entries.some(x => x.name === `assets/data/${tid}_datas.csv`)) csvPairs++;
  }
  return csvPairs >= 8;
}

/** detect only: also require the binary AndroidManifest to carry the game's package name. */
function hasManifest(entries: Entry[]): boolean {
  for (const e of entries) {
    if (!/^AndroidManifest\.xml$/i.test(e.name)) continue;
    // binary AndroidManifest: the package name is stored UTF-16LE in the string pool
    const full = 'com.yunbu.nonogram.puzzle'.split('').map(c => c.charCodeAt(0));
    const d = e.data;
    outer:
    for (let i = 0; i + full.length * 2 - 1 < d.length; i++) {
      for (let k = 0; k < full.length; k++) {
        const pos = i + k * 2;
        if (d[pos] !== (full[k] & 0xff) || d[pos + 1] !== (full[k] >> 8)) continue outer;
      }
      return true;
    }
  }
  return false;
}

/** inflate a CSV file: u32 decompressed-length, then a zlib body occupying the rest of the file. */
export function zlibBody(d: Uint8Array): Uint8Array {
  // unzlibSync (zlib-aware): the CSV streams are {0x78 0x9c} zlib members whose compressed length is
  // often < the u32 at offset 0 (that u32 is the DECOMPRESSED byte count), so inflateSync (which wants the
  // stream to end exactly at input EOF) fails; unzlibSync tolerates the padding.
  return unzlibSync(d.subarray(4));
}

/** decode the datas record table → per-index records (bytes). */
export function datasRecords(d: Uint8Array): Uint8Array[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const count = dv.getUint32(0, true);
  const offs: number[] = [];
  for (let i = 0; i < count; i++) offs.push(dv.getUint32(4 + i * 4, true) * 4);
  const payload = d.subarray(4 + count * 4);
  const recs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const lo = offs[i], hi = i + 1 < count ? offs[i + 1] : payload.length;
    recs.push(payload.subarray(lo, Math.max(lo, Math.min(hi, payload.length))));
  }
  return recs;
}

/** one row string of a solved grid, LSB-first bit order within each byte. */
export function rowsOf(rec: Uint8Array, w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      s += (rec[i >> 3] >> (i & 7)) & 1 ? '#' : '.';
    }
    rows.push(s);
  }
  return rows;
}

/** full dump of one zip into entries (what the UI's unzipAll does). */
export function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d }));
}

/** recursively unwrap a container until the game's own entries are on top (XAPK→base APK→assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  const inner = entries.filter(e => /\.(apk|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && looksLike(sub)) return sub;
  }
  return entries;
}

/** multi-language theme names from local_<lang>.csv. */
const NAME_LANGS: Array<[keyof { en: string; de: string; fr: string; it: string; es: string; ja: string; ko: string }, string]> = [
  ['en', 'en'], ['de', 'de'], ['fr', 'fr'], ['it', 'it'], ['es', 'es'], ['ja', 'jp'], ['ko', 'ko'],
];

function themeNames(entries: Entry[]): Map<number, Partial<Record<string, string>>> {
  const out = new Map<number, Partial<Record<string, string>>>();
  for (const [key, file] of NAME_LANGS) {
    const e = entries.find(x => x.name === `assets/data/local_${file}.csv`);
    if (!e) continue;
    let body: Uint8Array;
    try { body = zlibBody(e.data); } catch { continue; }
    const txt = new TextDecoder('utf-8').decode(body);
    for (const line of txt.split('\n')) {
      const m = /^(\d+)\|(.*)$/.exec(line);
      if (!m) continue;
      const tid = +m[1], name = m[2].trim();
      if (!name) continue;
      // templates like "<NAME>-Chapter <N>" are not theme titles; keep only concrete names
      if (name.includes('<NAME>') || name.includes('%d') || name.includes('%s')) continue;
      let v = out.get(tid);
      if (!v) { v = {}; out.set(tid, v); }
      v[key as string] = name;
    }
  }
  return out;
}

/** find the biggest launcher PNG and decode to RGBA for the pack icon. */
function findIcon(entries: Entry[]): { icon: PackIcon; file: string } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/ic_launcher(?:_[a-z]+)?\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
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

/** theme title from the localized tables, or a neutral fallback. */
function themeTitle(themeNo: number, names: Map<number, Partial<Record<string, string>>>): Partial<Record<string, string>> {
  const n = names.get(themeNo);
  if (n && Object.keys(n).length) return n;
  // expanded packs have no names anywhere in the APK; label with the game's own theme number
  return { en: `Theme ${themeNo}` };
}

/** shared read: entries → the pack (drop non-full jigsaw-piece records). */
export function packFromEntries(entries: Entry[]): Pack {
  const names = themeNames(entries);
  const themes = new Map<number, { puzzles: Array<{ w: number; h: number; rows: string[] }>; full: number; drop: number }>();

  const track = (list: Uint8Array[], ps: Array<{ w: number; h: number }>, total: number) => {
    for (let i = 0; i < list.length; i++) {
      const w = ps[i].w, h = ps[i].h;
      const need = (w * h + 7) >> 3;
      if (list[i].length < need) continue;         // jigsaw-piece nonograms: not full solvable grids
      themes.set(total, themes.get(total) ?? { puzzles: [], full: 0, drop: 0 });
      themes.get(total)!.puzzles.push({ w, h, rows: rowsOf(list[i], w, h) });
      themes.get(total)!.full++;
    }
  };

  const seen = new Set<number>();
  for (const e of entries) {
    const pm = /^assets\/data\/(\d+)_puzzles\.csv$/i.exec(e.name);
    if (!pm) continue;
    const tid = +pm[1];
    if (seen.has(tid)) continue;
    const dm = entries.find(x => x.name === `assets/data/${tid}_datas.csv`);
    if (!dm) continue;
    let body: Uint8Array;
    try { body = zlibBody(e.data); } catch { continue; }
    const lines = new TextDecoder('utf-8').decode(body).split('\n').filter(Boolean);
    const csv: Array<{ w: number; h: number }> = [];
    for (const line of lines) {
      const f = line.split('|');
      if (f.length < 7) continue;
      const w = +f[5], h = +f[6];
      if (!(w >= 1 && w <= 64 && h >= 1 && h <= 64)) continue;
      csv.push({ w, h });
    }
    if (csv.length !== lines.length) continue;
    let recs: Uint8Array[] = [];
    try {
      const dv = new DataView(dm.data.buffer, dm.data.byteOffset, dm.data.byteLength);
      const count = dv.getUint32(0, true);
      if (count === csv.length) recs = datasRecords(dm.data);
    } catch { continue; }
    if (recs.length !== csv.length) continue;
    seen.add(tid);
    track(recs, csv, tid);
  }

  if (!themes.size) throw new Error('No Nonogram+ Jigsaw puzzle sets found: the picked file is not the game.');

  const levels: PackLevel[] = [];
  let total = 0;
  const themeIds = [...themes.keys()].sort((a, b) => a - b);
  const perGroup = 20;
  const groups = Math.ceil(themeIds.length / perGroup);
  let open = 0;
  for (const tid of themeIds) {
    const t = themes.get(tid)!;
    const puzzles: PackPuzzle[] = t.puzzles.map((p, i) => ({
      id: `${tid}-${String(p.w)}x${p.h}-${String(i + 1).padStart(3, '0')}`,
      width: p.w, height: p.h, rows: p.rows,
    }));
    const g = Math.floor(open / perGroup);
    const from = g * perGroup + 1, to = Math.min((g + 1) * perGroup, themeIds.length);
    levels.push({
      id: `nbjig-${tid}`,
      title: themeTitle(tid, names),
      group: groups < 2 ? 'nonogram' : `themes-${g + 1}`,
      groupTitle: groups < 2
        ? { en: 'Nonogram', de: 'Nonogramm' }
        : { en: `Themes ${from}–${to}`, de: `Themen ${from}–${to}` },
      rules: 'normal',
      unlockAfter: open === 0 ? undefined : 1,
      puzzles,
    });
    total += puzzles.length;
    open++;
  }
  if (!levels.length) throw new Error('Puzzle sets found, but no full nonogram decoded.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-nonogram-jigsaw',
    title: { en: 'Nonogram+ Jigsaw Puzzle Game', de: 'Nonogram+ Jigsaw Puzzle Game' },
    source: {
      game: 'Nonogram+ Jigsaw Puzzle Game', platform: 'Android', developer: 'yunbu', year: 2026,
      file: `${total} puzzles`, region: 'WW',
    },
    theme: {
      palette: {
        accent: '#4a90d9', fill: '#f7f3ea', cell: '#fdfcf7', grid: '#cfc7b4', clue: '#2c3e50',
        cross: '#c0392b', cursor: '#e67e22', bg: '#efe9dc', style: 'logic',
      },
    },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${total} puzzles (icon ${icon.file})`; }
  return pack;
}

// ---- two entry points, one read path (like the kungfu / nonogram.com importers) ----
registerImporter({
  name: 'Nonogram+ Jigsaw Puzzle Game (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { const e = entriesOf(data); return looksLike(e) && hasManifest(e); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonogram+ Jigsaw APK: assets/data/*_puzzles.csv + *_datas.csv missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Nonogram+ Jigsaw Puzzle Game (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder: its assets/data/*_puzzles.csv live here
      if (/^assets\/data\/\d+_puzzles\.csv$/i.test(n)) {
        roots.add(n.slice(0, n.indexOf('assets/')) || '.');
      }
      // an APK/XAPK/APKM/ZIP file inside the picked folder
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      // root '.' = the whole picked folder; otherwise only files under the root
      if (root !== '.' && !n.startsWith(root)) continue;
      let data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else all.push({ name: root === '.' ? n : n.slice(root.length + 1), data });
    }
    if (!looksLike(all)) throw new Error('Not a Nonogram+ Jigsaw APK: assets/data/*_puzzles.csv + *_datas.csv missing.');
    return [packFromEntries(all)];
  },
});
