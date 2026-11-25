// Squeakross: Home Squeak Home (Nintendo Switch) — nonogram puzzles from its Unity Addressables + resources.
//
// The game is an IL2CPP Unity title. Its puzzles live in Data/resources.assets as MonoBehaviours (class 114),
// one per puzzle, named "<Base name>_<W>x<H>[_Challenge]" (e.g. "Apple Hat_15x15", "Pizza_20x16_Challenge").
// There is no separate puzzle table: the game orders them procedurally by name/size. Names are English, embedded
// in the object's own name; no per-language table exists.
//
// Each puzzle MonoBehaviour carries the solution twice:
//   - a compact beauty-format string `"W|H,"` + cells (utf-16): ',' (0x002C empty) / 'Ĭ' (0x012C filled),
//     right after the "W|H" string; this is the canonical row-major picture.
//   - a raw array: u32 count = W*H then count bytes (0/1), stored transposed-and-vertically-flipped relative
//     to the canonical picture: canonical = transpose(vreverse(raw)) (verified on all 649 puzzles that store both).
// Prefer the beautified string; fall back to the transformed raw array when only it exists.
//
//   File (recognised by)                         Puzzles
//   Data/resources.assets (with streaming aa catalog.json / Switch bundles below it)
//       → every "<name>_<W>x<H>[_Challenge]" MonoBehaviour whose blob holds a W*H grid   650 (base v0.49a)
//         325 normal + 325 _Challenge, sizes ~5x5 … 30x30. The update (an Addressables catalog.bundle + the
//         game's own data bundle) is read the same way when the user picks base + update together.
//
// Challenge variants are the same subjects at other sizes; normal and Challenge are separate modes.
import { registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, PackAsset } from '../format';
import { readSerialized, audioClip } from '../../rom/unity';
import { fsbClipOgg } from '../../audio/fsb5';

registerSetImporter({
  name: 'Squeakross: Home Squeak Home (Switch)',
  version: 4, // 4: music files use safe ASCII names (no spaces / '!')
  find(names) {
    // Only this game: puzzles live in Data/resources.assets, and that same Data/ folder has an
    // Addressables catalog (catalog.json or catalog.bundle). A bare catalog is not enough —
    // other games ship one too (a Steam _Data folder must not be read as this game).
    // Paths may be "Data/resources.assets" (picked RomFS root) or "…/Data/resources.assets".
    const roots = new Set<string>();
    const catalog = /StreamingAssets\/aa\/catalog\.(json|bundle)$/i;
    for (const n of names) {
      if (!/(^|\/)Data\/resources\.assets$/i.test(n)) continue;
      const root = n.slice(0, -'resources.assets'.length);
      if (names.some(x => x.startsWith(root) && catalog.test(x))) roots.add(root);
    }
    // an update picked on its own: catalog.bundle plus the data bundle, no resources.assets
    for (const n of names) {
      if (!catalog.test(n) || !/squeak/i.test(n)) continue;
      const data = n.replace(/StreamingAssets\/aa\/catalog\.(json|bundle)$/i, '');
      if (![...roots].some(r => data.startsWith(r))) roots.add(data);
    }
    return [...roots].filter(r => ![...roots].some(o => o !== r && o.startsWith(r))).map(r => r.endsWith('/') ? r : r + '/');
  },
  async read(files: GameFiles, root: string): Promise<Pack[]> {
    const has = (n: string) => files.names.includes(n);
    // the file with the puzzles: resources.assets, or (update merges) any *resources* bundle/data file
    let ra = root + 'resources.assets';
    if (!has(ra)) {
      // look for the game's data bundle under aa/ whose MonoBehaviours hold the puzzles (update layout)
      const cand = files.names.filter(n => n.startsWith(root) && /\.bundle$/i.test(n) && !/\.manifest$/i.test(n));
      ra = cand.find(n => /resources|data|squeak/i.test(n)) ?? ra;
      if (!has(ra)) throw new Error('Squeakross: Data/resources.assets not found among the picked files.');
    }
    const data = await files.get(ra);
    if (!data) throw new Error('Squeakross: resources.assets could not be read.');

    // parse every MonoBehaviour that looks like a puzzle and collect its picture
    const puzzles: Array<{ name: string; w: number; h: number; rows: string[] }> = [];
    const seen = new Set<string>();
    try {
      for (const o of readSerialized(data)) {
        if (o.classId !== 114) continue;            // MonoBehaviour
        const p = puzzleFromBlob(o.data);
        if (!p) continue;
        if (seen.has(p.name)) continue;             // merge base + update: newest merge keeps the first copy
        seen.add(p.name);
        puzzles.push(p);
      }
    } catch (e: any) { /* partial read: keep what we got */ }
    if (!puzzles.length) throw new Error('Squeakross: no puzzle MonoBehaviours found in the data file.');

    // group: two modes (Normal, Challenge), each one level; within a level puzzles sorted by size then name
    const byMode = new Map<string, PackPuzzle[]>();
    for (const p of puzzles) {
      const challenge = /_(?:Challenge|C)$/i.test(p.name);
      const short = p.name.replace(/_[A-Za-z0-9 ]+$\d*/, ''); // unused
      const name = p.name.replace(/_(?:[A-Za-z0-9]+)_(\d+)x(\d+)(?:_.*)?$/, (m, w, h) => '')
        .replace(/_Challenge$/i, '');
      // a display name: the base ("Apple Hat"), English
      const disp = p.name.replace(/_\d+x\d+(?:_(?:Challenge|C))?$/i, '');
      const id = slug(disp) + (challenge ? '-c' : '');
      const pz: PackPuzzle = {
        id,
        width: p.w,
        height: p.h,
        rows: p.rows,
        name: { en: disp } as any,
      };
      const key = challenge ? 'challenge' : 'normal';
      const list = byMode.get(key) ?? byMode.set(key, []).get(key)!;
      list.push(pz as any);
    }
    if (!byMode.size) throw new Error('Squeakross: no usable puzzle grids.');

    // order each mode: by cell count, then by display name (stable)
    const level = (key: 'normal' | 'challenge', title: string, group: string): PackLevel => {
      const list = byMode.get(key)?.sort((a, b) => (a.width * a.height - b.width * b.height) || ((a as any).name.en < (b as any).name.en ? -1 : 1)) ?? [];
      return { id: group, title: { en: title }, group, groupTitle: { en: title }, rules: 'normal', puzzles: list };
    };
    const levels: PackLevel[] = [];
    if (byMode.has('normal')) levels.push(level('normal', 'Normal', 'squeakross-normal'));
    if (byMode.has('challenge')) levels.push(level('challenge', 'Challenge', 'squeakross-challenge'));
    if (levels.length > 1) (levels[0] as any).unlockAfter = 0, (levels[1] as any).unlockAfter = undefined;
    // Challenge unlocks after the normal mode: leave both open (they are parallel sets, not a progression).

    const counts = levels.map(l => `${l.puzzles.length} ${l.group}`).join(', ');
    const music = await gameMusic(files, root);
    return [{
      format: 'momogram-pack', version: 1,
      id: 'nsw-squeakross-home-squeak-home',
      title: { en: 'Squeakross: Home Squeak Home' },
      source: {
        game: 'Squeakross: Home Squeak Home', platform: 'Nintendo Switch',
        developer: 'Rude Ghost, LLC', year: 2024,
        file: `Addressables + resources.assets (${counts})`,
      },
      theme: {
        ...music.theme,
        palette: {
          // warm paper board, leafy green accents (logo / UI)
          style: 'notebook',
          accent: '#7ab65c',
          fill: '#3a3a33',
          bg: '#f6f1e3',
          cell: '#fbf7ec',
          grid: '#cbbf9e',
          clue: '#5a5547',
          cursor: '#9bc86e',
          cross: '#8a7050',
          board: {
            clueArea: '#f3ecd8', clueAreaAlt: '#e8dfc4', clueBg: '#e4f0d4', clueBgAlt: '#fbf7ec',
            grid5: '#7ab65c', bg: '#fbf7ec', cell: '#fbf7ec',
          },
          screen: { bg: '#efe6cf', panel: '#fbf7ec', top: '#d4e8b8' },
        },
      },
      levels,
      assets: music.assets.length ? music.assets : undefined,
    }];
  },
});

/** BGM clips of resources.assets → resources.resource (FSB5 Vorbis) as Ogg */
async function gameMusic(files: GameFiles, root: string): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const ra = root + 'resources.assets', rr = root + 'resources.resource';
  const assetsFile = await files.get(ra), res = await files.get(rr);
  if (!assetsFile || !res) return { theme: undefined, assets: [] };
  const title = 'Squeakross_Title_V3_Master';
  const skip = /^(Private_|Enemy_|Player_|Sergeant_|ui_|rod_|house_|decor_|Alblune_|Squeakross_Catalog|Squeakross_Editors_)/i;
  // Puzzle loops are Jazz, Breeze, Puffed, … The Squeakross_ prefix is the title, the catalog, and the editor cues.
  const play: string[] = [];
  const byName = new Map<string, { offset: number; size: number }>();
  for (const o of readSerialized(assetsFile)) {
    const a = audioClip(o);
    if (!a || !/resources\.resource$/i.test(a.source) || a.size < 200_000) continue;
    byName.set(a.name, { offset: a.offset, size: a.size });
    if (!skip.test(a.name) && a.name !== title && !/^Squeakross_/i.test(a.name)) play.push(a.name);
  }
  play.sort();
  const want = [title, ...play.slice(0, 8)];
  // file names must be path-safe (no spaces / '!'); theme refs use the same names
  const fileOf = (clip: string) => slug(clip).replace(/-/g, '_') + '.ogg';
  const assets: PackAsset[] = [], made = new Map<string, string>(); // clip → file
  let bytes = 0;
  const MAX_OGG = 32 * 1024 * 1024;
  for (const name of want) {
    const loc = byName.get(name); if (!loc) continue;
    try {
      const ogg = fsbClipOgg(res.subarray(loc.offset, loc.offset + loc.size), name);
      if (!ogg) continue;
      if (made.size && bytes + ogg.length > MAX_OGG) continue;
      bytes += ogg.length;
      const file = fileOf(name);
      assets.push({ name: file, data: ogg });
      made.set(name, file);
    } catch (e) { console.warn(`FSB5 ${name}: ${e instanceof Error ? e.message : e}`); }
  }
  if (!made.size) return { theme: undefined, assets: [] };
  const f = (c?: string) => (c && made.has(c) ? made.get(c)! : undefined);
  const tracks = play.filter(c => made.has(c)).map(c => made.get(c)!);
  const menu = f(title) ?? tracks[0];
  return {
    theme: {
      music: { title: menu, menu, play: tracks[0] },
      tracks, songs: [...made.values()].sort(),
    },
    assets,
  };
}

/** a puzzle out of a MonoBehaviour blob: (name, w, h, rows) or null. */
function puzzleFromBlob(b: Uint8Array): { name: string; w: number; h: number; rows: string[] } | null {
  const name = blobName(b);
  if (!name) return null;
  const m = /^(.+)_(\d+)x(\d+)(?:_(.*))?$/.exec(name);
  if (!m) return null;
  const nw = +m[2], nh = +m[3];
  if (!(nw >= 1 && nw <= 60 && nh >= 1 && nh <= 60)) return null;
  const wh = embedWh(b);                // the game's own "W|H" (may differ from the name, e.g. name not grid)
  const W = wh ? wh[0] : nw, H = wh ? wh[1] : nh;
  // 1) the beautified comma string
  const comma = commaGrid(b, W, H);
  if (comma) return { name, w: W, h: H, rows: toRows(comma, W, H) };
  // 2) the raw array (u32 count + bytes), transposed + vertically reversed → canonical
  const raw = rawGrid(b, W, H);
  if (raw) {
    const canon = norm(raw, W, H);
    return { name, w: W, h: H, rows: canon };
  }
  // 3) fall back to the name's size
  if (wh) {
    const c2 = commaGrid(b, nw, nh);
    if (c2) return { name, w: nw, h: nh, rows: toRows(c2, nw, nh) };
    const r2 = rawGrid(b, nw, nh);
    if (r2) return { name, w: nw, h: nh, rows: norm(r2, nw, nh) };
  }
  return null;
}

/** the MonoBehaviour's own name (its first string after the standard header fields). */
function blobName(b: Uint8Array): string | null {
  // the object's name is a length-prefixed string (the length counts the trailing NUL) somewhere in the header
  for (let p = 0; p + 4 < Math.min(b.length, 400); p += 4) {
    const n = le32(b, p);
    if (n < 4 || n > 80 || p + 4 + n > b.length) continue;
    const s = utf8(b.subarray(p + 4, p + 4 + n)).replace(/\0+$/, '');
    if (allPrint(s) && /_\d+x\d+/.test(s)) return s;
  }
  return null;
}
function allPrint(s: string) { return s.length > 0 && [...s].every(c => c.codePointAt(0)! >= 32 || c === 'ü' || c === 'é'); }

/** find the game's "W|H" as a utf-16 string. */
function embedWh(b: Uint8Array): [number, number] | null {
  for (let i = 0; i + 6 <= b.length; i += 2) {
    if (b[i + 1] !== 0 || b[i] !== 0x7c) continue;    // '|'
    let j = i;
    while (j - 2 >= 0 && isDigit(b, j - 2)) j -= 2;
    if (j >= i) continue;
    let Ws = ''; for (let q = j; q < i; q += 2) Ws += String.fromCharCode(b[q]);
    let k = i + 2;
    while (k + 2 <= b.length && isDigit(b, k)) k += 2;
    let Hs = ''; for (let q = i + 2; q < k; q += 2) Hs += String.fromCharCode(b[q]);
    if (!/^\d+$/.test(Ws) || !/^\d+$/.test(Hs)) continue;
    const W = +Ws, H = +Hs;
    if (W >= 1 && W <= 60 && H >= 1 && H <= 60) return [W, H];
  }
  return null;
}
function isDigit(b: Uint8Array, at: number) { return b[at + 1] === 0 && b[at] >= 0x30 && b[at] <= 0x39; }

/** the comma beauty grid: "W|H" then a run of ',' (empty) / 'Ĭ' (filled) as utf-16. */
function commaGrid(b: Uint8Array, W: number, H: number): string | null {
  const wh = `${W}|${H}`;
  const off = findUtf16(b, wh);
  if (off < 0) return null;
  let out = '', pos = off + wh.length * 2;
  while (pos + 2 <= b.length && out.length < W * H) {
    const b0 = b[pos], b1 = b[pos + 1];
    if (b0 === 0x2c && b1 === 1) out += '#';
    else if (b0 === 0x2c && b1 === 0) out += '.';
    else if (b1 === 0 && (b0 === 0x30 || b0 === 0x31)) out += b0 === 0x31 ? '#' : '.';
    else break;
    pos += 2;
  }
  return out.length === W * H ? out : null;
}
function findUtf16(b: Uint8Array, s: string): number {
  const target: number[] = [];
  for (const ch of s) target.push(ch.codePointAt(0)! & 0xff, (ch.codePointAt(0)! >> 8) & 0xff);
  outer: for (let i = 0; i + target.length <= b.length; i += 2) {
    for (let k = 0; k < target.length; k++) if (b[i + k] !== target[k]) continue outer;
    return i;
  }
  return -1;
}

/** the raw array: u32 count = W*H then that many 0/1 bytes (transposed + v-reversed). */
function rawGrid(b: Uint8Array, W: number, H: number): string | null {
  const n = W * H;
  let last = -1;
  for (let i = 0; i + 4 + n <= b.length; i++) {
    if (le32(b, i) === n) {
      let ok = true, ones = 0;
      for (let k = 0; k < n && ok; k++) { const v = b[i + 4 + k]; if (v > 1) ok = false; else if (v) ones++; }
      if (ok && ones) last = i;
    }
  }
  if (last < 0) return null;
  const seg = b.subarray(last + 4, last + 4 + n);
  let s = '';
  for (let k = 0; k < n; k++) s += seg[k] ? '#' : '.';
  return s;
}

/** canonical W×H picture. The raw bytes are stored H wide × W high: transpose(vreverse(raw)). */
function norm(raw: string, W: number, H: number): string[] {
  const flipped = rev(raw, H, W);
  return toRows(transpose(flipped, H, W), W, H);
}
function transpose(g: string, W: number, H: number): string {   // W wide, H high → H wide, W high
  let out = '';
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) out += g[y * W + x];
  return out;
}
function rev(g: string, W: number, H: number): string {         // flip rows
  let out = '';
  for (let y = H - 1; y >= 0; y--) out += g.slice(y * W, (y + 1) * W);
  return out;
}
function toRows(g: string, W: number, H: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < H; y++) rows.push(g.slice(y * W, (y + 1) * W));
  return rows;
}

function le32(b: Uint8Array, at: number): number { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }
function utf8(b: Uint8Array): string { return new TextDecoder().decode(b); }
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); }
