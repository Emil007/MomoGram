// Piczle Cross Adventure (Steam) — nonograms by Score Studios, engine Unreal Engine 4 (cooked DataTable).
//
// The puzzles live in a cooked UE4 DataTable export:
// `Content/PiczleCrossAdventure/puzzles/puzzledata.uexp` (363 KB), loose or inside
// `PiczleCrossAdvntr_p-WindowsNoEditor.pak` (UE4 pak v8, zlib — the importer unpacks it).
// Each puzzle is stored as one
// record per language, and a record is a series of FStrings:
//
//   FString "puzzledata"                the DataTable's struct owner (package) name
//   FString "<id>_solution_<lang>"      the row name: P001…P220, C001…C099; lang en/de/fr/it/sp/jp
//   FString "<localized title>"         the name shown once the puzzle is solved
//   3 × int32 metadata                  (a table index, 0, the constant 666)
//
// An FString is length-prefixed: int32 len ≥ 0 → UTF-8/ASCII, len bytes incl. the trailing NUL;
// len < 0 → UTF-16LE with -len code units incl. the NUL. The 6 language rows of one puzzle are
// contiguous; all 319 puzzles then follow in order (P001…P011, C001…, etc.).
//
// The solution grid is NOT repeated per language: it is the value of one TextProperty stored in
// the export's shared data tail as an FString of space-separated 0/1 cells, row-major:
//   "0 1 1 1 0 1 0 1 0 1 …"  (= 25 cells for a 5×5). Every puzzle has exactly one such grid.
// The pairing is by cell count (width×height), which is unique per puzzle — this is what makes
// the grid match correct even for the puzzles whose grid is not adjacent to their own rows
// (P066, C021). C098 and C099 have titles but no grid (they are the two bonus Dr. Mona grids).
//
// The board's width and height are not in the DataTable — they come from the puzzle's texture
// asset `puzzles/solutions/<id>.uexp` (a UE4 Texture2D whose SX/SY sit right before its "PF_…"
// format string). When those textures are not picked, the game's own sizes (5/10/15/20 per side)
// are used, and for the ambiguous counts (50, 150, 300) the orientation that is line-solvable is
// kept (measured with the repo's puzzleScore: 41 of the 41 one-sided ambiguous puzzles resolve
// to the true orientation; a wrong-side grid is never the line-solvable one).
//
//   File (recognised by)                                Puzzles
//   puzzledata.uexp (UE4 DataTable, "…_solution_…")     317 (220 P + 97 C; C098/C099 no grid)
//   + puzzles/solutions/<id>.uexp (width/height only, optional)
//
// Pure black/white nonograms: every solution cell is 0 or 1. No mega-picross, no color-picross.

import { registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackAsset } from '../format';
import { puzzleScore } from '../../game/difficulty';
import { ueFString, ueSolutionGrids, cellRows } from '../../rom/uexp';
import { withPakPuzzles, readUe4Pak } from '../../rom/uepak';

const KEY = /^([A-Z]\d{3})_solution_([a-z]{2})$/;
/** the game's own board sizes for a given cell count (first entry = most common true orientation). */
const SIZES: Record<number, Array<[number, number]>> = {
  25: [[5, 5]], 50: [[5, 10], [10, 5]], 100: [[10, 10]], 150: [[15, 10], [10, 15]],
  225: [[15, 15]], 300: [[20, 15], [15, 20]],
};

registerSetImporter({
  name: 'Piczle Cross Adventure (Steam)',
  version: 4, // 4: texture pairing, loose bgm uexp, Ogg trimmed to its last page
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (/WindowsNoEditor\.pak$/i.test(n)) {
        const m = n.match(/^(.*?PiczleCrossAdvntr[^/]*\/)/i);
        roots.add(m ? m[1] : n.slice(0, n.lastIndexOf('/') + 1) || '.');
      } else if (/\/puzzledata\.uexp$/i.test(n) && !/PiczleCrossAdvntr/i.test(n)) {
        roots.add(n.slice(0, n.lastIndexOf('/') + 1) || '.');
      }
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string): Promise<Pack[]> {
    const opened = await withPakPuzzles(files, root);
    const pre = opened.root === '.' ? '' : opened.root;
    const uexp = opened.files.names.find(n => n.startsWith(pre) && /\/puzzledata\.uexp$/i.test(n));
    if (!uexp) throw new Error('puzzledata.uexp not in the picked files.');
    const data = await opened.files.get(uexp);
    if (!data) throw new Error('puzzledata.uexp could not be read.');
    return [await packOf(data, opened.files, opened.root, files, root)];
  },
});

/** the dimensions of a puzzle, from its sibling texture (SX/SY before the "PF_…" format string). */
async function textureDims(files: GameFiles, root: string, pid: string): Promise<[number, number] | undefined> {
  const pre = root === '.' ? '' : root;
  const n = files.names.find(x => x.startsWith(pre) && new RegExp(`/(?:solutions/)?${pid}\\.uexp$`).test(x));
  if (!n) return undefined;
  const d = await files.get(n);
  if (!d) return undefined;
  const pf = indexOfBytes(d, new TextEncoder().encode('PF_'));
  if (pf < 16) return undefined;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const sx = dv.getInt32(pf - 16, true), sy = dv.getInt32(pf - 12, true);
  if (sx >= 3 && sx <= 40 && sy >= 3 && sy <= 40) return [sx, sy];
  return undefined;
}

function indexOfBytes(d: Uint8Array, pat: Uint8Array): number {
  outer: for (let i = 0; i + pat.length <= d.length; i++) {
    for (let k = 0; k < pat.length; k++) if (d[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

/** bytes of one Ogg bitstream, stopping at the end-of-stream page (no trailing uexp). */
function oggBytes(d: Uint8Array, start: number): Uint8Array | null {
  let p = start, end = start;
  while (p + 27 <= d.length && d[p] === 0x4f && d[p + 1] === 0x67 && d[p + 2] === 0x67 && d[p + 3] === 0x53) {
    const segs = d[p + 26];
    if (p + 27 + segs > d.length) break;
    let body = 0;
    for (let i = 0; i < segs; i++) body += d[p + 27 + i];
    const next = p + 27 + segs + body;
    if (next > d.length) break;
    end = next;
    const eos = (d[p + 5] & 4) !== 0;
    p = next;
    if (eos) break;
  }
  return end - start >= 10_000 ? d.subarray(start, end) : null;
}

/** Ogg Vorbis payloads cooked into SoundWave .uexp. Loose bgms/*.uexp count; the Windows pak is the fallback. */
async function gameMusic(files: GameFiles, root: string): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const pre = root === '.' ? '' : root;
  const waves = new Map<string, Uint8Array>();
  for (const n of files.names) {
    if (!n.startsWith(pre) || !/\/bgms\/[^/]+\.uexp$/i.test(n) || /_Cue\.uexp$/i.test(n)) continue;
    const d = await files.get(n);
    if (d) waves.set(n, d);
  }
  if (!waves.size) {
    const pakName = files.names.find(n => n.startsWith(pre) && /WindowsNoEditor\.pak$/i.test(n))
      ?? files.names.find(n => n.startsWith(pre) && /\.pak$/i.test(n) && !/-Switch\.pak$/i.test(n));
    if (pakName) {
      try {
        const pak = await files.get(pakName);
        if (pak) for (const [k, v] of readUe4Pak(pak, n => /\/bgms\/[^/]+\.uexp$/i.test(n) && !/_Cue\.uexp$/i.test(n))) waves.set(k, v);
      } catch (e) { console.warn(`pak ${pakName}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  if (!waves.size) return { theme: undefined, assets: [] };
  const assets: PackAsset[] = [], made = new Set<string>();
  for (const [path, d] of waves) {
    if (d.length < 10_000) continue;
    let ogg = -1;
    for (let i = 0; i + 4 <= d.length; i++) if (d[i] === 0x4f && d[i + 1] === 0x67 && d[i + 2] === 0x67 && d[i + 3] === 0x53) { ogg = i; break; }
    const slice = ogg < 0 ? null : oggBytes(d, ogg);
    if (!slice) continue;
    const name = path.replace(/^.*\//, '').replace(/\.uexp$/i, '') + '.ogg';
    assets.push({ name, data: slice });
    made.add(name);
  }
  if (!made.size) return { theme: undefined, assets: [] };
  const has = (n: string) => made.has(n) ? n : undefined;
  const play = ['puzzlebgm_1', 'puzzlebgm_2', 'puzzlebgm_3', 'puzzlebgm_4', 'puzzlebgm_5', 'puzzlebgm_6']
    .map(n => n + '.ogg').filter(n => made.has(n));
  const menu = has('titlebgm_1.ogg') ?? has('titlebgm_0.ogg') ?? play[0];
  const songs = [...made].sort();
  return {
    theme: {
      music: { title: menu, menu, play: play[0], clear: has('creditsbgm_1.ogg') },
      tracks: play.length ? play : songs.filter(s => /puzzlebgm|worldbgm/.test(s)),
      songs,
    },
    assets,
  };
}

async function packOf(data: Uint8Array, files: GameFiles, root: string, allFiles?: GameFiles, allRoot?: string): Promise<Pack> {
  // 1) rows: every "<id>_solution_<lang>" in file order, with its localized title. We find the row
  //    names by their bytes (…_solution_xx\0 with a valid length prefix) and re-read them as FStrings,
  //    so the owner (table) name does not matter — this reads puzzledata / _demo / _gb alike.
  const recs = new Map<string, { id: string; langs: Map<string, string> }>();
  const order: string[] = [];
  const SOL = new TextEncoder().encode('_solution_');
  for (let i = 0; i + SOL.length + 3 <= data.length; i++) {
    let k = 0; for (; k < SOL.length; k++) if (data[i + k] !== SOL[k]) break;
    if (k < SOL.length) continue;
    // row name before "_solution_": "<A-Z><3 digits>_" (5 bytes), after: "<lang>\0" (3 bytes)
    const before = i - 4;
    if (before < 0 || data[i + SOL.length + 2] !== 0) continue;
    if (data[before] < 0x41 || data[before] > 0x5a) continue;
    const d1 = data[before + 1], d2 = data[before + 2], d3 = data[before + 3];
    if (d1 < 0x30 || d1 > 0x39 || d2 < 0x30 || d2 > 0x39 || d3 < 0x30 || d3 > 0x39) continue;
    if (data[before + 4] !== 0x5f) continue;
    const l1 = data[i + SOL.length], l2 = data[i + SOL.length + 1];
    if (l1 < 0x61 || l1 > 0x7a || l2 < 0x61 || l2 > 0x7a) continue;
    const key = ueFString(data, before - 4);
    if (!key || key.next !== i + SOL.length + 3) continue;
    const km = KEY.exec(key.s);
    if (!km) continue;
    const title = ueFString(data, key.next);
    const pid = km[1];
    let r = recs.get(pid);
    if (!r) { r = { id: pid, langs: new Map() }; recs.set(pid, r); order.push(pid); }
    r.langs.set(km[2], title?.s ?? '');
  }
  if (!recs.size) throw new Error('Puzzle table not found.');

  // 2) every solution grid in the export (space-separated 0/1, row-major)
  const grids = ueSolutionGrids(data);

  // 3) pair by cell count. Textures claim their grid first (P066/C021 are out of file order).
  //    A missing texture must not take the next grid of any size — that shifts every later puzzle.
  const cellsOf = new Map<string, number[]>();
  const dims = new Map<string, [number, number]>();
  const used = new Set<number>();
  const pending: string[] = [];
  for (const pid of order) {
    const t = await textureDims(files, root, pid);
    if (!t) { pending.push(pid); continue; }
    dims.set(pid, t);
    const target = t[0] * t[1];
    let chosen = -1;
    for (let gi = 0; gi < grids.length; gi++) {
      if (used.has(gi) || grids[gi].count !== target) continue;
      chosen = gi; break;
    }
    if (chosen >= 0) { used.add(chosen); cellsOf.set(pid, grids[chosen].cells); }
    else pending.push(pid);
  }
  const left: number[] = [];
  for (let gi = 0; gi < grids.length; gi++) if (!used.has(gi)) left.push(gi);
  for (let i = 0; i < pending.length && i < left.length; i++) cellsOf.set(pending[i], grids[left[i]].cells);

  // 4) puzzles in file order, grouped into size levels
  const bySize = new Map<string, PackLevel>();
  for (const pid of order) {
    const r = recs.get(pid)!;
    const en = r.langs.get('en') ?? '', de = r.langs.get('de') ?? '';
    const name: { en?: string; de?: string } = {};
    if (en) name.en = en;
    if (de) name.de = de;
    const cells = cellsOf.get(pid);
    if (!cells) continue; // no solution grid in the game's data (C098/C099 bonus puzzles)
    // orientation: texture wins; otherwise the most common true orientation, line-solvable one kept
    let w = dims.get(pid)?.[0] ?? SIZES[cells.length]?.[0][0] ?? 15;
    let h = dims.get(pid)?.[1] ?? SIZES[cells.length]?.[0][1] ?? 15;
    if (!dims.has(pid) && puzzleScore(cellRows(cells, w, h)).solvable === false) {
      const sw = cellRows(cells, h, w);
      if (puzzleScore(sw).solvable) [w, h] = [h, w];
    }
    const rows = cellRows(cells, w, h);
    const sz = `${w}x${h}`;
    const level = get(bySize, sz);
    level.puzzles.push({ id: pid.toLowerCase(), width: w, height: h, rows, name });
  }
  const levels = [...bySize.values()].sort((a, b) => a.puzzles.length - b.puzzles.length || a.id.localeCompare(b.id));
  if (!levels.length) throw new Error('No puzzles found.');

  const music = await gameMusic(allFiles ?? files, allRoot ?? root);
  return {
    format: 'momogram-pack',
    version: 1,
    id: 'steam-piczle-cross-adventure',
    title: { en: 'Piczle Cross Adventure' },
    source: { game: 'Piczle Cross Adventure', platform: 'Steam', developer: 'Score Studios' },
    theme: {
      ...music.theme,
      palette: {
        style: 'logic',
        accent: '#2f9ee0',   // the game's sky blue (from its clue/UI art)
        fill: '#e63b49',     // the game's red filled cells (from the C001 solution art)
        grid: '#8ab6d0', cursor: '#f0b020', hint: '#2f9ee0', clue: '#202020', bg: '#eaf4fb',
        cell: '#ffffff', cross: '#7090a8',
        board: {
          clueArea: '#eaf4fb', clueAreaAlt: '#dceaf6', clueBg: '#d0e6f4', clueBgAlt: '#ffffff',
          grid5: '#2f9ee0', bg: '#ffffff', cell: '#ffffff', clueFocusBg: '#f0b02088',
        },
        screen: { bg: '#d0e4f4', panel: '#ffffff', top: '#9ecce8' },
      },
    },
    levels,
    assets: music.assets.length ? music.assets : undefined,
  };
}

function get(m: Map<string, PackLevel>, key: string): PackLevel {
  let l = m.get(key);
  if (!l) {
    l = { id: `pl-${key}`, title: { en: `Piczle ${key.replace('x', '×')}` }, group: 'piczle', groupTitle: { en: 'Piczle Cross Adventure' }, rules: 'normal' as const, puzzles: [] };
    m.set(key, l);
  }
  return l;
}
