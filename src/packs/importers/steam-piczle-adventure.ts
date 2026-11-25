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
import { Pack, PackLevel } from '../format';
import { puzzleScore } from '../../game/difficulty';
import { ueFString, ueSolutionGrids, cellRows } from '../../rom/uexp';
import { withPakPuzzles } from '../../rom/uepak';

const KEY = /^([A-Z]\d{3})_solution_([a-z]{2})$/;
/** the game's own board sizes for a given cell count (first entry = most common true orientation). */
const SIZES: Record<number, Array<[number, number]>> = {
  25: [[5, 5]], 50: [[5, 10], [10, 5]], 100: [[10, 10]], 150: [[15, 10], [10, 15]],
  225: [[15, 15]], 300: [[20, 15], [15, 20]],
};

registerSetImporter({
  name: 'Piczle Cross Adventure (Steam)',
  version: 2, // 2: reads the Steam pak (UE4 v8, zlib) as well as a loose uexp
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
    return [await packOf(data, opened.files, opened.root)];
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

async function packOf(data: Uint8Array, files: GameFiles, root: string): Promise<Pack> {
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

  // 3) pair by cell count; the puzzle texture gives the definitive width×height
  const cellsOf = new Map<string, number[]>();
  const dims = new Map<string, [number, number]>();
  const used = new Set<number>();
  for (const pid of order) {
    const t = await textureDims(files, root, pid);
    if (t) dims.set(pid, t);
    const target = t ? t[0] * t[1] : null;
    let chosen = -1;
    for (let gi = 0; gi < grids.length; gi++) {
      if (used.has(gi)) continue;
      if (target === null || grids[gi].count === target) { chosen = gi; break; }
    }
    if (chosen >= 0) { used.add(chosen); cellsOf.set(pid, grids[chosen].cells); }
  }

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

  return {
    format: 'momogram-pack',
    version: 1,
    id: 'steam-piczle-cross-adventure',
    title: { en: 'Piczle Cross Adventure' },
    source: { game: 'Piczle Cross Adventure', platform: 'Steam', developer: 'Score Studios' },
    theme: {
      palette: {
        style: 'logic',
        accent: '#2f9ee0',   // the game's sky blue (from its clue/UI art)
        fill: '#e63b49',     // the game's red filled cells (from the C001 solution art)
        grid: '#8ab6d0', cursor: '#f0b020', hint: '#2f9ee0', clue: '#202020', bg: '#eaf4fb',
      },
    },
    levels,
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
