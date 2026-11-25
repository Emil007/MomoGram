// Gem Nonogram (com.gemnonogram.sfgame) — nonogram puzzles from its Cocos Creator Android bundles.
//
// The game is a Cocos Creator app. The native (JS) game logic is compiled into libcocos2djs.so and the
// .jsc bundles are SFood-encrypted, but the puzzle data is shipped as plain cc.BufferAsset native buffers
// (assets/assets/<level>/native/<uuid>.<hash>.bin), one "data" buffer per level. Each "data" buffer is a
// little-endian uint32 array in the same little table format as kungfu nonogram:
//
//   u32[0]               = 1 (chapter/level marker)
//   u32[1]               = a = puzzle count in this level (54)
//   u32[2 .. 2+a-1]      = per-puzzle index table; puzzle s uses
//       c = (s==0 ? 0 : u32[2+s-1] + s)
//       l = u32[2+s] + s
//       size = u32[2+a+c] & 255          (5, 10 or 15 — always square)
//       diff = (u32[2+a+c] >> 8) & 255   (1..4 = the game's difficulty; not shown by MomoGram)
//       cells start at 2+a+c+1, end (exclusive) at 2+a+l+1: one int32 per 32 cells,
//       bit b (LSB first) = filled when 1. Exactly size² cells.
//
// Puzzles are monotone black/white nonograms: the stored picture IS the solution; row/column clue runs
// are derived from it (checked against all 8 640 imported pieces, see VERIFIED.md).
//
//   Bundle        Contents
//   assets/assets/101..260   160 levels × 54 puzzles each = 8 640 total.
//                             (5×5 5, 10×10 2 409, 15×15 6 226 — sizes 5/10/15, always square.)
//   assets/assets/practice   tutorial bundle: 6 5×5 puzzles (its "data" buffer decodes with a=6)
//   assets/assets/chapter    the story/section select: per-level jigsaw/thumbnails and index tables
//                            (1 926 native .jpg covers), no playable grid data.
//   assets/assets/challenge  seasonal challenge packs — procedurally generated (density parameters in their
//                            cc.JsonAsset), no stored grids: not imported.
//   assets/assets/jigsaw     "puzzle piece" mode: 1 552 pintu_* pictures (776 native images) — the
//                            assembled theme pictures, not nonogram grids: not imported.
//   assets/assets/game4/game5/newYear/other   UI, backgrounds and activity graphics only.
//   assets/assets/resSps     Cocos spine/skeleton assets (animation): not imported.
//
// No mega mode and no colour mode exist in this game's story data: the "data" buffers are all binary
// (0/1 bits, max cell value == 1 across all 8 640 puzzles) and there is no colour/mega companion set —
// confirmed by scanning every native buffer of every bundle (no .DPC/.bdpc/.dpc2 pair files, no second
// clue table anywhere; the i18n tables list Game modes Classic / Speed / Perfect / Gem Sudoku but no
// colour or mega mode). 25 levels (119..143) carry an extra per-puzzle "dataConfig" buffer: a table of
// one sub-record per puzzle whose values are high-entropy bytes that do not form a coherent small-palette
// colour grid (they are the game's encrypted per-puzzle accessory data — gem illustrations / solution
// overlays used by the reward flow); those extra buffers are ignored. See ANALYSIS.md for the evidence.
//
// Container-agnostic by design (owner requirement): detect/read never gates on the file extension
// (.apk / .xapk / .apkm / .zip / folder are all fine). The real markers that decide are
//   - the binary AndroidManifest.xml with the UTF-16LE package name "com.gemnonogram.sfgame"
//     (versionName "1.6" / versionCode 45), and
//   - the level bundles: assets/assets/<level>/config.*.json plus the matching native .bin puzzle
//     buffers; at least a whole level set (many levels) must decode as the uint32 table above.
// .xapk and .apkm are zips that hold the base APK com.gemnonogram.sfgame.apk (a zip with those assets)
// next to the language/abi splits, so unzipping recursively and matching the markers works for every
// distribution. An already-extracted base APK / a picked folder is handled by the Set variant below
// (same read path).
//
// Icon: the distribution manifest's icon.png (the XAPK/APKM carry it next to the split APKs — a 512×512
// RGBA launcher icon; there is no res/mipmap-* ic_launcher in any split, only a 72×72
// res/drawable-hdpi-v4/ic_launcher.png in the base). We take the biggest ic_launcher/icon.png we find
// (PNG preferred), decode to RGBA and ship it as the pack icon (see VERIFIED.md).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { addMusic } from './android';
import { cocosRaw } from '../../rom/cocos';
import { unzipSync, inflateSync, unzlibSync } from 'fflate';

const LVL_RE = /^assets\/assets\/([0-9]{2,4})\/config\.[0-9a-f]{5}\.json$/i;
const BIN_RE = /^assets\/assets\/([0-9]{2,4})\/native\/[0-9a-f]{2}\/([0-9a-f-]{36})\.([0-9a-f]{5})\.bin$/i;
/** the distribution icon.png that APKPure/APKMirror place at the XAPK/APKM root */
const ICON_RE = /^icon\.png$/i;

type Entry = { name: string; data: Uint8Array };

/** true when the entries carry Gem Nonogram's marker set (package + decodable level bundles). */
export function looksLike(entries: Entry[]): boolean {
  const needle = new TextEncoder().encode('gemnonogram');
  const needleUtf16 = new Uint8Array('gemnonogram'.length * 2);
  for (let i = 0; i < 'gemnonogram'.length; i++) { needleUtf16[i * 2] = 'gemnonogram'.charCodeAt(i) & 0xff; needleUtf16[i * 2 + 1] = 0; }
  const pkg = entries.some(e => /^AndroidManifest\.xml$/i.test(e.name) &&
    (containsBytes(e.data, needle) || containsBytes(e.data, needleUtf16)));
  if (!pkg) return false;
  const levels = new Set<string>();
  for (const e of entries) {
    const m = LVL_RE.exec(e.name);
    if (m && +m[1] >= 101 && +m[1] <= 260) levels.add(m[1]);
  }
  return levels.size >= 8; // a real installation ships 160 levels; be generous for an extracted subset
}

/** one buffer decompressed (already plain) → puzzles [[size, cells]] or null */
export function decodeLevel(d: Uint8Array): Array<{ size: number; diff: number; cells: number[] }> | null {
  if (d.length < 12) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = Math.floor(d.byteLength / 4);
  const u = (i: number) => dv.getUint32(i * 4, true);
  const a = u(1);
  if (u(0) !== 1 || !(a >= 1 && a <= 200)) return null;
  const out: Array<{ size: number; diff: number; cells: number[] }> = [];
  for (let s = 0; s < a; s++) {
    const c = s === 0 ? 0 : u(2 + s - 1) + s;
    const l = u(2 + s) + s;
    const dWord = 2 + a + c;
    if (dWord >= n) return null;
    const u32 = u(dWord), size = u32 & 255, diff = (u32 >> 8) & 255;
    const ds = dWord + 1, de = 2 + a + l + 1;
    if (ds > de || size < 1 || size > 50 || de > n || ds < 0) return null;
    const cells: number[] = [];
    for (let y = ds; y < de && cells.length < size * size; y++) {
      const w = u(y);
      for (let bit = 0; bit < 32 && cells.length < size * size; bit++) cells.push((w >>> bit) & 1);
    }
    while (cells.length < size * size) cells.push(0);
    if (cells.some(v => v !== 0 && v !== 1)) return null;
    out.push({ size, diff, cells });
  }
  return out;
}

/** full dump of one zip into entries (what the UI's unzipAll does) */
export function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d }));
}

/** recursively unwrap a container until the game's own assets are on top (XAPK→base APK→assets).
 *  Outer-container icons (the distribution's icon.png at the XAPK/APKM root) are kept in the result
 *  under a synthetic `__iconN__.png` name so the pack icon can still use the high-resolution one. */
export function entriesOf(data: Uint8Array, depth = 0, icons: Entry[] = []): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  // keep the container's own icons (distributions put a hi-res icon.png next to the split APKs)
  for (const e of entries) if (ICON_RE.test(e.name) || /^res\/[^/]+\/ic_launcher[0-9a-z_.]*\.png$/i.test(e.name)) icons.push(e);
  if (looksLike(entries)) {
    return [...entries, ...icons.map((ic, i) => ({ name: `__icon${i}__.png`, data: ic.data }))];
  }
  const inner = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1, icons);
    if (sub.length) return sub;
  }
  return entries;
}

/**
 * Group the level configs (assets/assets/<n>/config.*.json) and link each native bin by its hash to its
 * config path name ("data" vs "dataConfig"). Returns a Map level → the "data" bytes.
 */
export function dataByLevel(entries: Entry[]): Map<number, Uint8Array> {
  const bins = new Map<string, Uint8Array>(); // native hash → bytes
  for (const e of entries) {
    const m = BIN_RE.exec(e.name);
    if (m) bins.set(m[3], e.data);
  }
  const byLevel = new Map<number, Uint8Array>();
  for (const e of entries) {
    const m = LVL_RE.exec(e.name);
    if (!m) continue;
    const lvl = +m[1];
    if (!(lvl >= 101 && lvl <= 260)) continue;
    let cfg: any;
    try { cfg = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
    const verts: any[] = cfg.versions?.native ?? [];
    for (let i = 0; i + 1 < verts.length; i += 2) {
      const name = cfg.paths?.[verts[i]]?.[0];
      if (name !== 'data') continue; // skip dataConfig
      const h: string = verts[i + 1];
      const b = bins.get(h);
      if (b) { byLevel.set(lvl, b); break; }
    }
  }
  return byLevel;
}

/** the biggest launcher/icon PNG in the container (distribution icon.png preferred), decoded to RGBA */
export function findIcon(entries: Entry[]) {
  const cands = entries.filter(e => ICON_RE.test(e.name) || /^__icon\d+__\.png$/.test(e.name));
  // fall back to any ic_launcher png (none denser than 72×72 in this game)
  for (const e of entries) {
    if (!/^res\/[^/]+\/ic_launcher[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    cands.push(e);
  }
  // biggest by file size (density proxies size), keep only PNGs
  let best: { name: string; data: Uint8Array } | null = null;
  for (const e of cands) {
    if (e.data.length < 33 || e.data[0] !== 0x89 || e.data[1] !== 0x50) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { name: best.name, icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), w: px.w, h: px.h };
}

/** minimal PNG decoder (8-bit RGBA, non-interlaced, multi-IDAT) — enough for launcher icons. */
export function pngRgba(d: Uint8Array): { w: number; h: number; rgba: ArrayBuffer } | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50) return null;
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null;
  const w = (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19];
  const h = (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23];
  const depth = d[24], ctype = d[25];
  if (!(w >= 1 && w <= 2048 && h >= 1 && h <= 2048) || depth !== 8) return null;
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
      const aa = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev[x], cc = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x] ?? 0;
      cur[x] = filter === 0 ? f :
        filter === 1 ? (f + aa) & 0xff :
        filter === 2 ? (f + bb) & 0xff :
        filter === 3 ? (f + ((aa + bb) >> 1)) & 0xff :
        (f + paeth(aa, bb, cc)) & 0xff;
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

/** byte-substring test on typed arrays (Uint8Array.includes only takes a number). */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** shared read: entries → the pack */
export function packFromEntries(entries: Entry[]): Pack {
  const byLevel = dataByLevel(entries);
  if (!byLevel.size) throw new Error('No Gem Nonogram level bundles found: the picked file is not Gem Nonogram.');
  const levels: PackLevel[] = [];
  let total = 0;
  const sorted = [...byLevel.keys()].sort((a, b) => a - b);
  const perGroup = 20;
  for (const lvl of sorted) {
    const dec = decodeLevel(byLevel.get(lvl)!);
    if (!dec) continue;
    const puzzles: PackPuzzle[] = dec.map((p, i) => {
      const rows = rowsFromBits(p.size, p.size, (x, y) => p.cells[y * p.size + x] === 1);
      return { id: `c${lvl}-${String(i + 1).padStart(2, '0')}`, width: p.size, height: p.size, rows };
    });
    const i = levels.length;
    const g = Math.floor(i / perGroup);
    levels.push({
      id: `gn-c${lvl}`, title: { en: `Chapter ${lvl - 100}`, de: `Kapitel ${lvl - 100}` },
      group: `ch${g + 1}`,
      groupTitle: { en: 'Chapters', de: 'Kapitel' }, // filled after count known
      rules: 'normal', puzzles,
    });
    total += puzzles.length;
  }
  const nCh = levels.length;
  for (let i = 0; i < nCh; i++) {
    const g = Math.floor(i / perGroup);
    const from = g * perGroup + 1, to = Math.min((g + 1) * perGroup, nCh);
    levels[i].groupTitle = {
      en: `Chapters ${from}–${to}`, de: `Kapitel ${from}–${to}`,
      fr: `Chapitres ${from}–${to}`, it: `Capitoli ${from}–${to}`, es: `Capítulos ${from}–${to}`,
    };
  }
  if (!levels.length) throw new Error('Gem Nonogram level bundles found, but no chapter decoded.');
  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-gem-nonogram',
    title: { en: 'Gem Nonogram', de: 'Gem Nonogram' },
    source: { game: 'Gem Nonogram', platform: 'Android', developer: 'SF game', year: 2026, file: `${total} puzzles` },
    theme: { palette: {
      style: 'logic', accent: '#7c4dff', fill: '#2b2150', cell: '#f2eefe', grid: '#5d4a9e', clue: '#241c42',
      cross: '#e5396b', cursor: '#ffd54f', bg: '#efeafe',
      board: {
        clueArea: '#ebe4fa', clueAreaAlt: '#ddd4f4', clueBg: '#d8ccf8', clueBgAlt: '#f2eefe',
        grid5: '#7c4dff', bg: '#f2eefe', cell: '#f2eefe', clueFocusBg: '#ffd54f88',
      },
      screen: { bg: '#ddd4f4', panel: '#f2eefe', top: '#c8b8f0' },
    } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${total} puzzles (icon ${icon.name} ${icon.w}x${icon.h})`; }
  const names = entries.map(e => e.name);
  const get = (n: string) => entries.find(e => e.name === n)?.data;
  const raw = cocosRaw({ names, get }, 'assets/assets/sound/');
  addMusic(pack, ['BGMMain', 'BGMPvp', 'win'].map(p => {
    const f = raw.get(p);
    return { name: p + (f?.match(/\.[a-z0-9]+$/i)?.[0] ?? ''), data: f ? get(f) : undefined };
  }), { title: 'BGMMain.mp3', menu: 'BGMMain.mp3', play: ['BGMMain.mp3'], clear: 'win.mp3' });
  return pack;
}

// ---- two entry points, one read path (same as the kungfu importer) ----
registerImporter({
  name: 'Gem Nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { const entries = entriesOf(data); return looksLike(entries); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Gem Nonogram APK: level bundles missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Gem Nonogram (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (/^assets\/assets\/[0-9]{2,4}\/config\.[0-9a-f]{5}\.json$/i.test(n)) {
        const r = n.slice(0, n.indexOf('assets/'));
        roots.add(r === '' ? '.' : r.replace(/\/$/, ''));
      }
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
    if (!looksLike(all)) throw new Error('Not Gem Nonogram: level bundles missing.');
    return [packFromEntries(all)];
  },
});
