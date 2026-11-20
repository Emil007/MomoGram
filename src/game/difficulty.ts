// Measured puzzle difficulty: how much work MomoGram's line solver needs, combined with the size.
// 1 = easy, 2 = medium, 3 = hard. Puzzles that line logic alone can't finish are always hard.
import { analyzeLine, lineClues, EMPTY, FILL, CROSS } from './board';

export type Diff = 1 | 2 | 3;
const cache = new Map<string, Diff>();

export function puzzleScore(rows: string[]): { solvable: boolean; passes: number; area: number } {
  const h = rows.length, w = rows[0]?.length ?? 0;
  const sol = rows.map(r => [...r].map(c => c === '#'));
  const rc = sol.map(r => lineClues(r)), cc = [...Array(w)].map((_, x) => lineClues(sol.map(r => r[x])));
  const g = new Uint8Array(w * h);
  let passes = 0, changed = true;
  while (changed && passes < 200) {
    changed = false; passes++;
    for (let y = 0; y < h; y++) changed = apply(rc[y], [...Array(w)].map((_, x) => y * w + x)) || changed;
    for (let x = 0; x < w; x++) changed = apply(cc[x], [...Array(h)].map((_, y) => y * w + x)) || changed;
  }
  return { solvable: !g.includes(EMPTY), passes, area: w * h };
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
    // work ≈ size × solver sweeps; calibrated on 5×5 … 30×30 puzzles
    const work = s.area * Math.sqrt(s.passes);
    d = !s.solvable || work > 1100 ? 3 : work > 300 ? 2 : 1;
    cache.set(key, d);
  }
  return d;
}
