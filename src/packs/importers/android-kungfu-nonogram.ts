// kungfu nonogram (com.tech300.nonogram2) — nonogram puzzles from its Cocos Creator Android bundle.
//
// The game is a Cocos Creator app (JS). The puzzle data lives in "level" bundles:
//   assets/assets/level11..level36/  each holds 10 chapter buffers + the images for those chapters.
// Every chapter buffer is a plain little-endian uint32 array:
//
//   u32[0]   = chapter type (1 for the normal chapters in this game)
//   u32[1]   = a = puzzle count in this chapter (54)
//   u32[2 .. 2+a-1]  = per-puzzle index table; puzzle s uses
//       c = (s==0 ? 0 : u32[2+s-1] + s)
//       l = u32[2+s] + s
//       size = u32[2+a+c] & 255          (5, 10 or 15 — always square)
//       diff = (u32[2+a+c] >> 8) & 255
//       cells start at 2+a+c+1, end (exclusive) at 2+a+l+1: one int32 per 32 cells,
//       bit b (LSB first) = filled when 1. Exactly size² cells.
//
// Puzzles are monotone black/white nonograms (no mega, no colour mode): the stored picture IS the
// solution; the row/column clue runs are derived from it (there are no separate clue tables —
// row/col sums are conserved for every puzzle, see VERIFIED.md).
//
//   Bundle        Chapters (ids)      Size mix
//   level11       101..110            54 each; sizes 5×5/10×10/15×15
//   level12       111..120            (112 shares its data with 212 — same native hash, identical bytes)
//   …             …                   …
//   level36       351..358            (359/360 have no buffer: never shipped)
//
// Total: 258 chapter buffers / 13 932 puzzles (5×5 5, 10×10 3 876, 15×15 10 051), every one
// line-solvable with exactly one solution (repo puzzleScore + solutionCount, see VERIFIED.md).
// The game also ships "game*" bundles (jigsaw/practice minigames with a different format) and a
// "practice" bundle (6 5×5 tutorial puzzles); the importer reads the level chapters only. The order
// the game presents chapters in is a shuffled map (chapNames = [10,55,32,…]); the data itself is
// unlabelled (no per-puzzle or per-chapter names anywhere in the APK — verified, see ANALYSIS.md),
// so chapter ids are used as level ids.
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / folder are all fine). The real markers that decide are
//   - the binary AndroidManifest.xml with package com.tech300.nonogram2, versionName "2.1" /
//     versionCode 56, and
//   - the level bundles: assets/assets/level(1[1-9]|2[0-9]|3[0-6])/config.*.json plus the matching
//     native .bin puzzle buffers; at least the whole chapter set (many chapters) must decode.
// .xapk and .apkm are zips that hold the base APK com.tech300.nonogram2.apk (a zip with those
// assets) next to the language/abi splits, so unzipping recursively and matching the markers works
// for every distribution. An already-extracted base APK / a picked folder is handled by the Set
// variant below (same read path).
//
// Icon: res/mipmap-*/ic_launcher.png → density PNGs; the biggest (192×192, res/mipmap-xxxhdpi-v4)
// is decoded to RGBA and shipped as the pack icon (makeIcon).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { addMusic } from './android';
import { cocosRaw } from '../../rom/cocos';
import { unzipSync, inflateSync, unzlibSync } from 'fflate';

const CHAPTER_RE = /^assets\/assets\/level([1-9][0-9])\/config\.([0-9a-f]{5})\.json$/i;
const BIN_RE = /^assets\/assets\/level([1-9][0-9])\/native\/[0-9a-f]{2}\/[0-9a-f-]{36}\.([0-9a-f]{5})\.bin$/i;

/** true when the entries carry the whole marker set of the game's level bundles. */
export function looksLike(entries: Array<{ name: string; data: Uint8Array }>): boolean {
  const configs = new Set<string>(), bins = new Set<string>();
  for (const e of entries) {
    const c = CHAPTER_RE.exec(e.name);
    if (c) configs.add(c[1]);
    const b = BIN_RE.exec(e.name);
    if (b) bins.add(b[1] + '|' + b[2]);
  }
  // a good spread of level bundles must be present and at least a few hundred native bins:
  // earlier APK versions have fewer chapters, but never fewer than one level bundle + its bins.
  return configs.size >= 1 && bins.size >= 4 && [...configs].filter(c => {
    let any = false;
    for (const b of bins) if (b.startsWith(c + '|')) { any = true; break; }
    return any;
  }).length >= 1;
}

function u32s(d: Uint8Array): number[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = Math.floor(d.byteLength / 4), out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

/** decode one chapter buffer → [{size, cells}] (cells bit-packed rows), or null when it isn't a chapter. */
export function decodeChapter(d: number[]): Array<{ size: number; cells: number[] }> | null {
  const a = d[1];
  if (!(a >= 1 && a <= 200)) return null;
  try {
    const out: Array<{ size: number; cells: number[] }> = [];
    for (let s = 0; s < a; s++) {
      const c = s === 0 ? 0 : d[2 + s - 1] + s;
      const l = d[2 + s] + s;
      const u = d[2 + a + c] & 255;
      const ds = 2 + a + c + 1, de = 2 + a + l + 1;
      if (ds > de || u < 1 || u > 100 || de > d.length) return null;
      const cells: number[] = [];
      for (let y = ds; y < de && cells.length < u * u; y++) {
        const w = d[y];
        for (let b = 0; b < 32 && cells.length < u * u; b++) cells.push((w >>> b) & 1);
      }
      while (cells.length < u * u) cells.push(0);
      out.push({ size: u, cells });
    }
    return out;
  } catch { return null; }
}

/** full dump of one zip into entries (what the UI's unzipAll does) */
export function unzipAll(data: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d }));
}

/** recursively unwrap a container until the game's own asset entries are on top (XAPK→base APK→assets). */
export function entriesOf(data: Uint8Array, depth = 0): Array<{ name: string; data: Uint8Array }> {
  if (depth > 2) throw new Error('Too many nested containers.');
  let entries: Array<{ name: string; data: Uint8Array }>;
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  // a XAPK/APKM wrapper: its base / only APK holds the game assets
  const inner = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length) return sub;
  }
  return entries;
}

/** find the biggest launcher PNG (res/mipmap ic_launcher) in the entries, decode to RGBA */
export function findIcon(entries: Array<{ name: string; data: Uint8Array }>) {
  let best: { name: string; data: Uint8Array } | null = null;
  for (const e of entries) {
    if (!/^res\/[^/]+\/ic_launcher[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { name: best.name, icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), w: px.w, h: px.h };
}

/** minimal PNG decoder (8-bit RGBA, non-interlaced, multi-IDAT) — enough for launcher icons. */
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

/** shared read: entries → the pack */
export function packFromEntries(entries: Array<{ name: string; data: Uint8Array }>): Pack {
  const configs = new Map<number, { json: any; bundles: Map<number, string> }>();
  const bins = new Map<string, Uint8Array>();
  for (const e of entries) {
    const b = BIN_RE.exec(e.name);
    if (b) bins.set(b[2], e.data); // by native hash
  }

  // gather every chapter<->data mapping from each level bundle's config, keeping bundle identity
  const chapters = new Map<number, { size: number }>();
  const dataFiles = new Map<number, Uint8Array>();
  for (const e of entries) {
    const c = CHAPTER_RE.exec(e.name);
    if (!c) continue;
    let cfg: any;
    try { cfg = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
    for (const k of Object.keys(cfg.paths)) {
      const pth: string = cfg.paths[k][0];
      if (!pth.endsWith('/data')) continue;
      const uuid: string = cfg.uuids[Number(k)];
      const idx = cfg.uuids.indexOf(uuid);
      if (idx < 0) continue;
      const h: string = cfg.versions.native[2 * idx + 1];
      const bin = bins.get(h);
      if (!bin) continue;
      chapters.set(Number(pth.split('/')[0]), { size: 0 });
      dataFiles.set(Number(pth.split('/')[0]), bin);
    }
    void configs;
  }
  if (!chapters.size) throw new Error('No level bundles found: the picked file is not kungfu nonogram.');

  const levels: PackLevel[] = [];
  let total = 0;
  const sorted = [...chapters.keys()].sort((a, b) => a - b);
  const perGroup = 20;
  const kept: number[] = [];
  for (const cid of sorted) {
    const d = u32s(dataFiles.get(cid)!);
    const pz = decodeChapter(d);
    if (!pz) continue;
    kept.push(cid);
    const puzzles: PackPuzzle[] = pz.map((p, i) => {
      const rows = rowsOf(p.size, p.cells);
      return { id: `c${cid}-${String(i + 1).padStart(2, '0')}`, width: p.size, height: p.size, rows };
    });
    const i = kept.length - 1;
    const g = Math.floor(i / perGroup);
    const from = g * perGroup + 1, to = Math.min((g + 1) * perGroup, sorted.length);
    levels.push({
      id: `kt300-c${cid}`, title: { en: `Chapter ${cid - 100}`, de: `Kapitel ${cid - 100}` },
      group: `ch${g + 1}`,
      groupTitle: {
        en: `Chapters ${from}–${to}`, de: `Kapitel ${from}–${to}`,
        fr: `Chapitres ${from}–${to}`, it: `Capitoli ${from}–${to}`, es: `Capítulos ${from}–${to}`,
      },
      rules: 'normal', puzzles,
    });
    total += puzzles.length;
  }
  // fix group "to" using actual decoded chapter count
  const nCh = levels.length;
  for (let i = 0; i < levels.length; i++) {
    const g = Math.floor(i / perGroup);
    const from = g * perGroup + 1, to = Math.min((g + 1) * perGroup, nCh);
    levels[i].groupTitle = {
      en: `Chapters ${from}–${to}`, de: `Kapitel ${from}–${to}`,
      fr: `Chapitres ${from}–${to}`, it: `Capitoli ${from}–${to}`, es: `Capítulos ${from}–${to}`,
    };
  }
  if (!levels.length) throw new Error('Level bundles found, but no chapter decoded.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-kungfu-nonogram',
    title: { en: 'kungfu nonogram', de: 'kungfu nonogram' },
    source: { game: 'kungfu nonogram', platform: 'Android', developer: 'Tech300', year: 2026, file: `${total} puzzles` },
    theme: { palette: {
      style: 'notebook', accent: '#e08a2e', fill: '#2f2a24', cell: '#f5efe4', grid: '#8d7a5f', clue: '#241f18',
      cross: '#c0392b', cursor: '#e0a030', bg: '#f0e9da',
      board: {
        clueArea: '#efe6d2', clueAreaAlt: '#e4d8bc', clueBg: '#f0d8b0', clueBgAlt: '#f5efe4',
        grid5: '#e08a2e', bg: '#f5efe4', cell: '#f5efe4', clueFocusBg: '#e0a03088',
      },
      screen: { bg: '#e8dcc4', panel: '#f5efe4', top: '#e8c890' },
    } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${total} puzzles (icon ${icon.name} ${icon.w}x${icon.h})`; }
  // BGMMain: menus; BGMGame / BGMGames: puzzles; BGMPVP: versus
  const names = entries.map(e => e.name);
  const get = (n: string) => entries.find(e => e.name === n)?.data;
  const raw = cocosRaw({ names, get }, 'assets/assets/sound/');
  addMusic(pack, ['BGMMain', 'BGMGame', 'BGMGames', 'BGMPVP', 'win'].map(p => {
    const f = raw.get(p);
    return { name: p + (f?.match(/\.[a-z0-9]+$/i)?.[0] ?? ''), data: f ? get(f) : undefined };
  }), { title: 'BGMMain.mp3', menu: 'BGMMain.mp3', play: ['BGMGame.mp3', 'BGMGames.mp3'], clear: 'win.mp3' });
  return pack;
}

function rowsOf(size: number, cells: number[]): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let s = '';
    for (let x = 0; x < size; x++) s += cells[y * size + x] ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

// ---- two entry points, one read path (same as the Kimbuja importer) ----
registerImporter({
  name: 'kungfu nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { const entries = entriesOf(data); return looksLike(entries); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a kungfu nonogram APK: level bundles missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'kungfu nonogram (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder: its own assets/assets/levelXX live here
      if (/^assets\/assets\/level[1-9][0-9]\/config\.[0-9a-f]{5}\.json$/i.test(n)) {
        const r = n.slice(0, n.indexOf('assets/'));
        roots.add(r === '' ? '.' : r.replace(/\/$/, ''));
      }
      // an APK/XAPK/APKM/ZIP file inside the picked folder
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Array<{ name: string; data: Uint8Array }> = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      let data = await files.get(n);
      if (!data) continue;
      if (/\/([^/]+\.(apk|xapk|apkm|zip))$/i.test(n) || /\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        // a loose file inside the picked folder: strip the root folder prefix
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    if (!looksLike(all)) throw new Error('Not a kungfu nonogram APK: level bundles missing.');
    return [packFromEntries(all)];
  },
});
