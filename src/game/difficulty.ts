// Measured puzzle difficulty: how much work MomoGram's line solver needs, combined with the size.
// 1 = easy, 2 = medium, 3 = hard. Puzzles that line logic alone can't finish are always hard.
import { analyzeLine, lineClues, EMPTY, FILL, CROSS } from './board';

export type Diff = 1 | 2 | 3;
const cache = new Map<string, Diff>();

export function puzzleScore(rows: string[]): {
  solvable: boolean; passes: number; area: number; grid: Uint8Array;
  filled: number; forcedPerPass: number[];
} {
  const h = rows.length, w = rows[0]?.length ?? 0;
  const sol = rows.map(r => [...r].map(c => c === '#'));
  const filled = sol.reduce((n, r) => n + r.reduce((a, c) => a + (c ? 1 : 0), 0), 0);
  const rc = sol.map(r => lineClues(r)), cc = [...Array(w)].map((_, x) => lineClues(sol.map(r => r[x])));
  const g = new Uint8Array(w * h);
  let passes = 0, changed = true;
  const forcedPerPass: number[] = [];
  while (changed && passes < 200) {
    changed = false; passes++;
    let decided = 0;
    const before = g.slice();
    for (let y = 0; y < h; y++) changed = apply(rc[y], [...Array(w)].map((_, x) => y * w + x)) || changed;
    for (let x = 0; x < w; x++) changed = apply(cc[x], [...Array(h)].map((_, y) => y * w + x)) || changed;
    for (let i = 0; i < g.length; i++) if (before[i] === EMPTY && g[i] !== EMPTY) decided++;
    forcedPerPass.push(decided);
  }
  return { solvable: !g.includes(EMPTY), passes, area: w * h, grid: g, filled, forcedPerPass };
  function apply(clue: number[], idx: number[]): boolean {
    const li = analyzeLine(clue.length ? clue : [0], idx.map(i => g[i]));
    let ch = false;
    idx.forEach((i, k) => {
      if (g[i] !== EMPTY) return;
      const zero = !clue.length || (clue.length === 1 && clue[0] === 0);
      if (zero || (li.canEmpty && !li.canFill?.[k])) { g[i] = CROSS; ch = true; }
      else if (li.canFill && li.canEmpty && !li.canEmpty[k]) { g[i] = FILL; ch = true; }
    });
    return ch;
  }
}

export function puzzleLevel(p: { rows: string[] }): Diff {
  const key = p.rows.join('/');
  let d = cache.get(key);
  if (!d) {
    const s = puzzleScore(p.rows);
    const density = s.area ? s.filled / s.area : 0;
    const effArea = s.area * (0.20 + 0.80 * Math.min(1, Math.max(0, density / 0.45)));
    const work = Math.max(25, 0.65 * effArea * Math.sqrt(s.passes) + 8 * s.passes);
    d = !s.solvable || work > 1100 ? 3 : work > 300 ? 2 : 1;
    cache.set(key, d);
  }
  return d;
}

/**
 * Make a picture solvable by logic alone with as few changed cells as possible: repeatedly flip the undecided cell
 * that leaves the fewest cells undecided. Returns the cells to flip (empty when it already has one solution).
 */
export function suggestFix(rows: string[], maxChanges = 6): Array<{ x: number; y: number }> {
  let cur = rows.slice();
  const w = rows[0]?.length ?? 0;
  const changes: Array<{ x: number; y: number }> = [];
  const open = (r: string[]) => { const s = puzzleScore(r); return { n: s.grid.reduce((a, v) => a + (v === EMPTY ? 1 : 0), 0), g: s.grid }; };
  let st = open(cur);
  while (st.n > 0 && changes.length < maxChanges) {
    const cand: number[] = [];
    st.g.forEach((v, i) => { if (v === EMPTY) cand.push(i); });
    // large ambiguous areas: look at a spread-out sample
    const step = Math.max(1, Math.floor(cand.length / 80));
    let best = -1, bestN = st.n;
    for (let k = 0; k < cand.length; k += step) {
      const i = cand[k], x = i % w, y = Math.floor(i / w);
      const t = flip(cur, x, y), n = open(t).n;
      if (n < bestN) { bestN = n; best = i; if (n === 0) break; }
    }
    if (best < 0) break;
    const x = best % w, y = Math.floor(best / w);
    cur = flip(cur, x, y); changes.push({ x, y }); st = open(cur);
  }
  return st.n === 0 ? changes : [];
}
const flip = (r: string[], x: number, y: number) => r.map((row, j) => j !== y ? row : row.slice(0, x) + (row[x] === '#' ? '.' : '#') + row.slice(x + 1));
