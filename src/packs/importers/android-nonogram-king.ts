// Nonogram King (com.mobirix.nonogram, v1.3.6) — nonogram puzzles from its plain-ASCII Android assets.
//
// The game is a native Android/Kotlin app (mobirix, Seoul). Its puzzles are stored as the SOLVED PICTURE —
// plain ASCII files of '0'/'1' cells, one char per board cell — under three difficulty folders plus a
// "Special" mosaic room (see ANALYSIS.md for the reverse engineering). Row/column clues are derived from
// each stored picture (there is no separate clue table; row/col clue sums are conserved for every puzzle,
// see VERIFIED.md).
//
//   assets/Easy/Easy0..                  16 files 5×5  + 192 files 10×10   (208 puzzles, "Easy")
//   assets/Normal/Normal0..              209 files 15×15                    ("Normal")
//   assets/Hard/Hard0..                  208 files 20×20                    ("Hard")
//   assets/Special/<size>_<M>/<k>_<n>    3537 files — the SPECIAL room: "<size>_<M>" is a picture size
//     (tile size M² tiles per picture), <k> is the picture id, <n> the tile index (0..M²-1, row-major).
//     Every tile is an independent nonogram (the game plays it as one grid), like the "Big mosaic" room
//     of the Eyes importer in this folder. 12 size classes: 10_2..20_5, 160 pictures in total.
//
// Total: 4 162 independent nonograms (5×5 x16, 10×10 x456, 15×15 x483, 20×20 x3207).
//
// No colour mode: every cell across all 4 162 files is '0' or '1' (verified byte-by-byte — there is no
// separate colour-clue channel and no per-cell colour value > 1 anywhere, see ANALYSIS.md). No Mega mode:
// there are no paired-row/column files (no .DPC/.bdpc/.dpc2), no Jupiter-pair structure, and the Special
// room is a mosaic of independent ordinary nonograms, not a Mega line-pairing mode.
//
// Honest solvability reality (source, unchanged): the repo's line solver (`puzzleScore`) finishes 39.8%
// of the 4 162 puzzles; the rest need guessing. That IS how the game ships them — these are picture-art
// nonograms (characters / drawings), not a hand-crafted logic-curriculum set (Easy 44.7%, Normal 40.7%,
// Hard 24.0%, Special 10× 60-73%, 15× 69-88%, 20× 34-56%; see VERIFIED.md). Uniqueness holds where the
// solver can decide: ~63% of the sampled puzzles have exactly one solution for their clues, ~33% have two
// or more (the game's own arbitrariness), the rest stay unresolved within budget. We import the stored
// pictures faithfully; the solvability split is flagged as source reality, not a parse artefact.
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / an extracted folder all work). The real markers that decide are
//   - the binary AndroidManifest.xml holding the UTF-16LE package name "com.mobirix.nonogram" (also in
//     the XAPK's manifest.json package_name), and
//   - the puzzle marker: at least one difficulty folder (assets/(Easy|Normal|Hard)/<name>) and/or at
//     least one Special size folder, whose files are non-empty ASCII strings of only '0'/'1' in a perfect
//     square length. We require both markers (manifest package + a real decodable set of square 0/1 files).
// .xapk / .apkm / .zip are zips holding the base APK (com.mobirix.nonogram.apk, itself a zip with these
// assets) next to the language/ABI splits; unzipping recursively and matching the markers works for every
// distribution. An already-extracted base APK / folder is handled by the Set variant below.
//
// Icon: res/mipmap-xxxhdpi-v4/ic_launcher.png (192×192) — the biggest launcher PNG, decoded to RGBA and
// shipped as the pack icon (also identical to the XAPK's own icon.png; see VERIFIED.md).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync, unzlibSync, inflateSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

/** true when an entry's bytes hold our package name as UTF-16LE (binary AndroidManifest.xml). */
export function hasManifestPackage(entries: Entry[]): boolean {
  const needle = new TextEncoder().encode('com.mobirix.nonogram');
  for (const e of entries) {
    if (!/^(AndroidManifest\.xml|META-INF\/?(manifest|.*manifest.*)\.xml)$/i.test(e.name)) continue;
    const d = e.data;
    for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
      let all = true;
      for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
      if (all) return true;
    }
  }
  return false;
}

/** the puzzle file names as the game ships them. */
const EASY_RE = /^assets\/Easy\/Easy(\d+)$/i;
const NORMAL_RE = /^assets\/Normal\/Normal(\d+)$/i;
const HARD_RE = /^assets\/Hard\/Hard(\d+)$/i;
const SPECIAL_RE = /^assets\/Special\/(10|15|20)_([2-5])\/(\d+)_(\d+)$/i;

/** decode an ASCII '0'/'1' grid into rows ('#' filled, '.' empty); null when it isn't a square 0/1 grid. */
export function decodeGrid(b: Uint8Array): { size: number; rows: string[] } | null {
  if (b.length < 25) return null;
  let s = '';
  for (const c of b) {
    if (c !== 0x30 && c !== 0x31) return null;   // only '0' and '1'
    s += c === 0x31 ? '#' : '.';
  }
  const size = Math.round(Math.sqrt(s.length));
  if (size * size !== s.length || size < 5 || size > 30) return null;
  const rows: string[] = [];
  for (let y = 0; y < size; y++) rows.push(s.slice(y * size, (y + 1) * size));
  return { size, rows };
}

interface Hits { easy: number; normal: number; hard: number; special: number; folders: Set<string> }

function hits(entries: Entry[]): Hits {
  const h: Hits = { easy: 0, normal: 0, hard: 0, special: 0, folders: new Set() };
  for (const e of entries) {
    if (EASY_RE.test(e.name)) { h.easy++; continue; }
    if (NORMAL_RE.test(e.name)) { h.normal++; continue; }
    if (HARD_RE.test(e.name)) { h.hard++; continue; }
    const m = SPECIAL_RE.exec(e.name);
    if (m) { h.special++; h.folders.add(m[1] + '_' + m[2]); }
  }
  return h;
}

/** the marker set: at least one difficulty or Special folder with >=1 square 0/1 file, and manifest package. */
export function looksLike(entries: Entry[]): boolean {
  const h = hits(entries);
  if (h.easy + h.normal + h.hard + h.special < 4) return false;
  // confirm at least one difficulty file (or Special file) actually decodes square
  let ok = false;
  for (const e of entries) {
    if (EASY_RE.test(e.name) || NORMAL_RE.test(e.name) || HARD_RE.test(e.name) || SPECIAL_RE.test(e.name)) {
      if (decodeGrid(e.data)) { ok = true; break; }
    }
  }
  return ok && hasManifestPackage(entries);
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
  const inner = entries.filter(e => /\.(apk|apks|xapk|apkm|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && (hasManifestPackage(sub) || looksLike(sub))) return sub;
  }
  return entries;
}

// ---- puzzle reading ----

interface One { id: string; size: number; rows: string[]; name?: string }

function puzzleOf(name: string, data: Uint8Array, id: string): One | null {
  const d = decodeGrid(data);
  if (!d) return null;
  return { id, size: d.size, rows: d.rows };
}

/** build the pack from the entry set that carries the game assets. */
export function packFromEntries(entries: Entry[]): Pack {
  const levels: PackLevel[] = [];
  let total = 0;

  // Easy / Normal / Hard
  const diff = [
    { re: EASY_RE, id: 'easy', title: { en: 'Easy', de: 'Leicht' }, size: 0 },
    { re: NORMAL_RE, id: 'normal', title: { en: 'Normal', de: 'Normal' }, size: 0 },
    { re: HARD_RE, id: 'hard', title: { en: 'Hard', de: 'Schwer' }, size: 0 },
  ];
  for (const d of diff) {
    const items: Array<{ idx: number; p: One }> = [];
    for (const e of entries) {
      const m = d.re.exec(e.name);
      if (!m) continue;
      const p = puzzleOf(e.name, e.data, `${d.id}-${m[1]}`);
      if (p) items.push({ idx: +m[1], p });
    }
    if (!items.length) continue;
    items.sort((a, b) => a.idx - b.idx);
    const puzzles: PackPuzzle[] = items.map(({ p }) => ({ id: p.id, width: p.size, height: p.size, rows: p.rows }));
    levels.push(...numberedLevels(puzzles, {
      id: 'nk-' + d.id, group: 'nk-classic', groupTitle: { en: 'Main', de: 'Hauptspiel' },
      title: (from, to) => ({ en: `${d.title.en} ${from}–${to}`, de: `${d.title.de} ${from}–${to}` }),
    }));
    total += puzzles.length;
  }

  // Special: group by size class (10_2 … 20_5) — every tile is one independent nonogram
  const special = new Map<string, Array<{ pic: number; n: number; p: One }>>();
  for (const e of entries) {
    const m = SPECIAL_RE.exec(e.name);
    if (!m) continue;
    const p = puzzleOf(e.name, e.data, `sp-${m[1]}_${m[2]}-${m[3]}-${m[4]}`);
    if (!p) continue;
    const key = `${m[1]}_${m[2]}`;
    if (!special.has(key)) special.set(key, []);
    special.get(key)!.push({ pic: +m[3], n: +m[4], p });
  }
  for (const key of [...special.keys()].sort()) {
    const items = special.get(key)!;
    items.sort((a, b) => a.pic - b.pic || a.n - b.n);
    const [sz, M] = key.split('_').map(Number);
    const puzzles: PackPuzzle[] = items.map(({ p, pic, n }) => ({
      id: p.id,
      width: p.size, height: p.size, rows: p.rows,
      name: { en: `Picture ${pic} · part ${n + 1}/${M * M}` },
    }));
    levels.push(...numberedLevels(puzzles, {
      id: 'nk-sp-' + key,
      group: 'nk-special',
      groupTitle: { en: 'Special', de: 'Spezial' },
      title: (from, to) => ({ en: `Special ${sz}×${sz} ${from}–${to}`, de: `Spezial ${sz}×${sz} ${from}–${to}` }),
    }));
    total += puzzles.length;
  }

  if (!levels.length) throw new Error('No Nonogram King puzzles found: not a com.mobirix.nonogram asset set.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-nonogram-king',
    title: { en: 'Nonogram King', de: 'Nonogram King' },
    source: {
      game: 'Nonogram King', platform: 'Android', developer: 'mobirix', year: 2026,
      file: `${total} puzzles`,
    },
    theme: {
      palette: {
        // muted board colours from the game's flat UI / launcher art
        accent: '#3f51b5', fill: '#eef0f6', bg: '#e3e6ee', cell: '#fbfbfd',
        grid: '#c3c8d8', clue: '#23305a', cursor: '#5c6bc0', style: 'default',
      },
    },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; (pack.source as any).file = `${pack.source.file} (icon ${icon.file})`; }
  return pack;
}

// ---- icon ----

function findIcon(entries: Entry[]): { icon: ReturnType<typeof makeIcon>; file: string } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/ic_launcher(?:_[a-z0-9]+)?\.png$/i.test(e.name)) continue;
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
  try { raw = unzlibSync(all); } catch { try { raw = inflateSync(all); } catch { return null; } }
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

// ---- entry points ----
registerImporter({
  name: 'Nonogram King (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonogram King APK: com.mobirix.nonogram markers missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Nonogram King (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder: its assets/Easy|Normal|Hard|Special live here
      if (/^assets\/(Easy|Normal|Hard)\/[A-Za-z]+\d+$/i.test(n) || /^assets\/Special\/\d+_\d+\/\d+_\d+$/i.test(n)) {
        const r = n.slice(0, n.indexOf('assets/'));
        roots.add(r === '' ? '.' : r.replace(/\/$/, ''));
      }
      // an APK/XAPK/APKM/ZIP file inside the picked folder
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      let data = await files.get(n);
      if (!data) continue;
      if (/\/([^/]+\.(apk|xapk|apkm|apks|zip))$/i.test(n) || /\.(apk|xapk|apkm|apks|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    if (!looksLike(all)) throw new Error('Not a Nonogram King APK: com.mobirix.nonogram markers missing.');
    return [packFromEntries(all)];
  },
});
