// Nonogram Crossing Logic Puzzle (com.twodesperados.pic.cross.picross.logic, Two Desperados) —
// nonogram puzzles from its Unity 6 il2cpp + Addressables Android build.
//
// The game ships its whole catalogue as plain serialized TextAssets (class 49) under
// `assets/bin/Data/<32-hex>` in the `split_UnityDataAssetPack.apk`, one per puzzle, named by the
// game's own Addressables asset id (a 32-hex hash — no extension). Each TextAsset decodes to a JSON
// level object (everything is plaintext at rest; no encryption, no runtime fetch):
//
//   levelName       the puzzle's English name ("Flamingo", "Water Hydrant", "Cutting Board", …)
//   levelPattern    H rows × W columns of 0/1 — the black-and-white solution grid (this IS the puzzle;
//                   the row/column clue runs are derived from it, MomoGram's normal model)
//   levelImage      H × W of {r,g,b,a} — the game's coloured reveal picture (shown after solving,
//                   also used to tint the filled cells in-game); Bernoulli-compatible with the B/W
//                   grid: same size, and the non-background art colours land on the filled cells; the
//                   puzzle itself is B/W (all levelPattern values are 0/1, verified over all 22 756)
//   levelVersion    an edit counter (not a play grid)
//   difficulty      "very easy" … "super hard" (not shown by MomoGram, kept as-is)
//   gameMode        1 normal, 5 timed, 6 timed/hard variants of the same named level
//   levelType       0 normal, 3 "very hard/super hard", 5 (12 puzzles), 1 (2)
//   IsNoMistake / IsHardLevel / TimedLevelTime / lives  … rules of that level (not imported: the
//   worms / bees / frost / slime / hedge / shells / soap / bosses / bombTimers / …  gimmick patterns
//   of the level's event modes — not part of the playable grid)
//
//   TextAsset name          Meaning                          Puzzles
//   Level<N>                campaign level N (each file is  16 039 (5×5 27, 10×10 7 226, 15×15 8 786;
//                             its own puzzle; several share      the same Level<N> number across the
//                             the same gameMode/numbering)       timed (5/6) and normal (1) variants)
//   0 / 1 / 2 / 3 / 4      classic/organic "random" set      6 566 (0:2 935, 1:2 935, 2:673, 3:20, 4:3)
//   ClashLevel<N>          "Nono Clash" multiplayer levels   100 (10×10; 79 have unique pictures)
//   EndlessLevel<N>        endless mode levels                10
//   Tutorial*              teaching levels (gimmick rules)    41 (not imported)
//
// Only the puzzle-bearing TextAssets matter: 22 756 of the 29 355 `assets/bin/Data/*` files (the rest
// are Unity config / performance / billing TextAssets and the game's textures/audio/resources — no
// puzzle tables anywhere else; the 89 Addressables .bundle files hold cosmetics, fonts and
// localisation only, verified). The catalogue Addressables catalog.bin is not needed: the puzzle
// files are directly discoverable by their level JSON.
//
// The coloured `levelImage` is shipped as the pack's colour picture (`color.palette` + `color.rows`,
// base36 indices). MomoGram then offers a colour version of a B/W puzzle when it uses few enough
// colours to be told apart at a glance; the B/W puzzle itself stays the game's own playable grid.
//
// Icon: the distribution's 512×512 `icon.png` at the APKM root (the XAPK/APKM carry it next to the
// split APKs); fall back to the biggest `res/mipmap-*/app_icon.png` in the base APK.
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / folder are all fine). The real markers that decide are
//   - the binary AndroidManifest.xml with the UTF-16LE package name "com.twodesperados.pic.cross.picross.logic"
//     (versionName 1.149.15 / versionCode 1036114915) in the base APK, and
//   - the puzzle set: a nested APK holding assets/bin/Data/<32-hex> TextAssets that decode as level
//     JSON with a levelPattern grid; at least many files must decode.
// .xapk and .apkm are zips that hold the base APK next to the language/abi splits and the fat
// `split_UnityDataAssetPack.apk` (a zip with those Data files), so unzipping recursively and matching
// the markers works for every distribution. An already-extracted base / a picked folder is handled by
// the Set variant below (same read path).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, PackIcon } from '../format';
import { numberedLevels } from './android';
import { unzipSync, unzlibSync } from 'fflate';
import { readSerialized, textAsset } from '../../rom/unity';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.twodesperados.pic.cross.picross.logic';
/** Data file names: the game's serialized TextAssets, `assets/bin/Data/<32 lowercase hex>`. */
const isDataName = (n: string) => /^assets\/bin\/Data\/[0-9a-f]{32}$/i.test(n);

/** true when the entries carry the game's marker set (manifest package + decodable puzzle set). */
export function looksLike(entries: Entry[]): boolean {
  let manifest = false, enough = false;
  const needle = new TextEncoder().encode(PKG);
  const needle16 = new Uint8Array(PKG.length * 2);
  for (let i = 0; i < PKG.length; i++) { needle16[i * 2] = PKG.charCodeAt(i) & 0xff; needle16[i * 2 + 1] = PKG.charCodeAt(i) >> 8; }
  let data = 0, decoded = 0;
  for (const e of entries) {
    if (!manifest && /^AndroidManifest\.xml$/i.test(e.name) &&
        (containsBytes(e.data, needle) || containsBytes(e.data, needle16))) manifest = true;
    if (isDataName(e.name)) {
      data++;
      // a Data file is a serialized file with one TextAsset naming a level (JSON "levelPattern")
      if (decoded < 8 && isLevelBytes(e.data)) decoded++;
    }
    if (manifest && data >= 8 && decoded >= 2) return true;
  }
  return manifest && data >= 8 && decoded >= 2;
}

/** do the bytes of a Data file decode to a level JSON (Cheap first marker, then a real parse)? */
function isLevelBytes(d: Uint8Array): boolean {
  try {
    for (const o of readSerialized(d)) {
      const ta = textAsset(o);
      if (ta && containsBytes(ta.bytes, B_LEVEL)) return levelFromBytes(ta.bytes) !== null;
    }
  } catch { /* not serialized / not a level */ }
  return false;
}
const B_LEVEL = new TextEncoder().encode('"levelPattern"');

interface Level { hash: string; name: string; w: number; h: number; rows: string[]; color: PackPuzzle['color']; mode: 'campaign' | 'classic' | 'clash' | 'endless' }

/** parse one TextAsset bytes into a level (null when not a level JSON or unusable grid). */
export function levelFromBytes(b: Uint8Array): Level | null {
  const txt = new TextDecoder().decode(b);
  if (txt.indexOf('"levelPattern"') < 0) return null;
  let j: any;
  try { j = JSON.parse(txt); } catch { return null; }
  const pat = j?.levelPattern;
  if (!Array.isArray(pat) || !pat.length || !Array.isArray(pat[0])) return null;
  const h = pat.length, w = pat[0].length;
  if (!(w >= 2 && w <= 60 && h >= 2 && h <= 60)) return null;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    const r = pat[y];
    if (!Array.isArray(r) || r.length !== w) return null;
    let s = '';
    for (let x = 0; x < w; x++) { const v = r[x]; if (v !== 0 && v !== 1) return null; s += v ? '#' : '.'; }
    rows.push(s);
  }
  const img = j?.levelImage;
  let color: PackPuzzle['color'];
  if (Array.isArray(img) && img.length === h && Array.isArray(img[0]) && img[0].length === w) {
    const pal: string[] = []; const idx = new Map<string, number>();
    const rowsIdx: string[] = [];
    let usable = true;
    for (let y = 0; y < h && usable; y++) {
      let s = '';
      for (let x = 0; x < w; x++) {
        const c = img[y][x];
        if (!c || typeof c.r !== 'number') { usable = false; break; }
        const key = `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a ?? 255)}`;
        let k = idx.get(key);
        if (k === undefined) {
          if (pal.length >= 36) { usable = false; break; } // base36 palette indices
          k = pal.length; idx.set(key, k);
          pal.push(rgbHex(c));
        }
        s += k.toString(36);
      }
      if (usable) rowsIdx.push(s);
    }
    if (usable && pal.length) color = { palette: pal, rows: rowsIdx };
  }
  return { hash: '', name: String(j.levelName ?? '').trim(), w, h, rows, color, mode: 'campaign' };
}

/** per-mode group of a TextAsset by its asset name; null → skip */
function groupOf(name: string, lvl: Level): Level['mode'] | null {
  if (/^Level\d+$/.test(name)) return 'campaign';
  if (/^\d+$/.test(name)) return 'classic';
  if (/^ClashLevel\d+$/.test(name)) return 'clash';
  if (/^EndlessLevel\d+$/.test(name)) return 'endless';
  return null; // Tutorial* and anything else
}

/** the mode label / source description */
const MODE_TITLE: Record<Level['mode'], { title: string; group: string; id: string }> = {
  campaign: { title: 'Campaign', group: 'Levels', id: 'campaign' },
  classic: { title: 'Classic', group: 'Classic', id: 'classic' },
  clash: { title: 'Clash', group: 'Clash', id: 'clash' },
  endless: { title: 'Endless', group: 'Endless', id: 'endless' },
};

// ---- container unwrapping (same family as the other Android importers) ----

export function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's own assets are on top (APKM → base + Unity data APK). */
export function entriesOf(data: Uint8Array, depth = 0, icons: Entry[] = []): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  for (const e of entries) if (/^icon\.png$/i.test(e.name)) icons.push(e);
  if (looksLike(entries)) return [...entries, ...icons.map((ic, i) => ({ name: `__icon${i}__.png`, data: ic.data }))];
  // plyzone: keep descending into the biggest nested APK (the base APK, then the fat Unity data APK)
  const inner = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1, icons);
    if (sub.length) return sub;
  }
  return entries;
}

/** all puzzle levels from a set of entries (their Data files), in a stable order. */
export function levelsFromEntries(entries: Entry[]): Level[] {
  const out: Level[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isDataName(e.name)) continue;
    let lvl: Level | null = null;
    try {
      for (const o of readSerialized(e.data)) {
        const ta = textAsset(o);
        if (ta && ta.bytes.length && containsBytes(ta.bytes, B_LEVEL)) {
          const l = levelFromBytes(ta.bytes);
          if (l) {
            l.hash = e.name.slice('assets/bin/Data/'.length);
            const m = groupOf(ta.name, l);
            if (!m) break; // Tutorial*/unknown: skip this puzzle
            l.mode = m;
            lvl = l; break;
          }
        }
      }
    } catch { /* not serialized */ }
    if (lvl && lvl.rows.length && !seen.has(lvl.hash) && groupOfByHashKey(lvl)) { seen.add(lvl.hash); out.push(lvl); }
  }
  return out;
}
function groupOfByHashKey(l: Level): boolean { return l.mode === 'campaign' || l.mode === 'classic' || l.mode === 'clash' || l.mode === 'endless'; }

/** build the pack: one level per mode, each grouped by grid size, in a stable order. */
export function packFromLevels(levels: Level[]): Pack {
  if (!levels.length) throw new Error('Not a Two Desperados Crossing Logic APK: no puzzles found.');
  const byMode = new Map<Level['mode'], Map<string, PackPuzzle[]>>();
  for (const l of levels) {
    const key = l.mode;
    const bySize = byMode.get(key) ?? byMode.set(key, new Map()).get(key)!;
    const sk = `${l.w}x${l.h}`;
    const list = bySize.get(sk) ?? bySize.set(sk, []).get(sk)!;
    const pz: PackPuzzle = {
      id: `${key === 'campaign' ? 'l' : key === 'classic' ? 'c' : key === 'clash' ? 'cl' : 'e'}-${l.hash.slice(0, 12)}`,
      width: l.w, height: l.h, rows: l.rows,
      name: l.name ? { en: l.name } : undefined,
      color: l.color,
    };
    list.push(pz);
  }
  const levelsPack: PackLevel[] = [];
  const modeOrder: Level['mode'][] = ['campaign', 'classic', 'clash', 'endless'];
  for (const m of modeOrder) {
    const bySize = byMode.get(m);
    if (!bySize) continue;
    const title = MODE_TITLE[m];
    // stable size order: by cell count; split huge size buckets into numbered tabs/folders
    for (const [sk, puzzles] of [...bySize.entries()].sort((a, b) => {
      const aa = sizeOf(a[0]), bb = sizeOf(b[0]);
      return aa[0] * aa[1] - bb[0] * bb[1];
    })) {
      const sorted = puzzles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const label = sk.replace('x', '×');
      levelsPack.push(...numberedLevels(sorted, {
        id: `${title.id}-${sk}`,
        group: `${title.group}-${sk}`,
        groupTitle: { en: `${title.title} · ${label}`, de: `${title.title} · ${label}` },
      }));
    }
  }
  if (!levelsPack.length) throw new Error('Nonogram Crossing Logic: no playable puzzle sizes.');
  const total = levelsPack.reduce((n, l) => n + l.puzzles.length, 0);
  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-picross-crossing-logic',
    title: { en: 'Nonogram Crossing Logic', de: 'Nonogram Crossing Logic' },
    source: {
      game: 'Nonogram Crossing Logic Puzzle', platform: 'Android',
      developer: 'Two Desperados', year: 2026,
      file: `${total} puzzles`,
    },
    theme: { palette: {
      accent: '#fc0c2c',   // the app's brand red (apkm accent_color)
      fill: '#1f2333',     // dark board from the game's screenshots
      cell: '#f3f4fa', bg: '#eef0f7', grid: '#b9bfd4', clue: '#23273a',
      cross: '#e06060', cursor: '#ffb340', style: 'default',
    } },
    levels: levelsPack,
  };
  return pack;
}
function sizeOf(sk: string): [number, number] { const i = sk.indexOf('x'); return [+sk.slice(0, i), +sk.slice(i + 1)]; }

/** find the pack icon (APKM-root icon.png first, then the biggest base app_icon png).
 *  Returns { icon, name } or null. */
function findIcon(entries: Entry[]): { icon: PackIcon; name: string } | null {
  const cands: Entry[] = entries.filter(e => /^__icon\d+__\.png$/.test(e.name));
  for (const e of entries) {
    if (/^res\/mipmap-[^/]+\/app_icon[0-9a-z_.]*\.png$/i.test(e.name)) {
      if (/\.9\.png$/i.test(e.name)) continue;
      cands.push(e);
    }
  }
  let best: Entry | null = null;
  for (const e of cands) {
    if (e.data.length < 33 || e.data[0] !== 0x89 || e.data[1] !== 0x50) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  // corner: icon.png may be a webp named .png on some distributions; PNG magic required
  const px = pngRgba(best.data);
  if (!px) return null;
  return { icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), name: best.name };
}
/** minimal PNG decoder (8-bit RGBA/RGB/grey, non-interlaced, multi-IDAT). */
function pngRgba(d: Uint8Array): { w: number; h: number; rgba: ArrayBuffer } | null {
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
import { inflateSync } from 'fflate';

/** byte-substring test on typed arrays. */
export function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (!needle.length) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
/** #rrggbb from a {r,g,b,a} art pixel. */
function rgbHex(c: { r: number; g: number; b: number; a?: number }): string {
  const h = (v: number) => ((v < 0 ? 0 : v > 255 ? 255 : v) | 0).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// ---- entry points ----
registerImporter({
  name: 'Nonogram Crossing Logic (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonogram Crossing Logic APK: puzzle files missing.');
    const levels = levelsFromEntries(entries);
    const pack = packFromLevels(levels);
    const icon = findIcon(entries);
    if (icon) { pack.icon = icon.icon; pack.source.file = `${pack.source.file} (icon ${icon.name})`; }
    return [pack];
  },
});

registerSetImporter({
  name: 'Nonogram Crossing Logic (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted game folder: its assets/bin/Data/<hash> level files live here
      if (isDataName(n)) roots.add(n.slice(0, n.indexOf('assets/')) || '.');
      // a picked distribution file: only the file itself as root (never shadow real folders)
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
    if (!looksLike(all)) throw new Error('Not a Nonogram Crossing Logic APK: puzzle files missing.');
    const levels = levelsFromEntries(all);
    const pack = packFromLevels(levels);
    const icon = findIcon(all);
    if (icon) { pack.icon = icon.icon; pack.source.file = `${pack.source.file} (icon ${icon.name})`; }
    return [pack];
  },
});
