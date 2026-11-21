// Does a puzzle have exactly one solution? Line solving (every arrangement of a line's clues, as in analyzeLine),
// then trying both values of an open cell and solving on, until a second solution turns up or the budget is spent.

/** solve one line in place (-1 unknown, 0 empty, 1 filled); returns the number of cells decided, or -1 */
function solveLine(cur: Int8Array, cl: number[]): number {
  const n = cur.length, k = cl.length, K = k + 1;
  const zr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) zr[i + 1] = zr[i] + (cur[i] === 0 ? 1 : 0);
  const fits = (s: number, L: number) => s + L <= n && zr[s + L] - zr[s] === 0;
  // S[i][j]: cells i.. can hold clues j..
  const S = new Uint8Array((n + 2) * K);
  S[n * K + k] = 1;
  for (let i = n - 1; i >= 0; i--) for (let j = k; j >= 0; j--) {
    let r = cur[i] !== 1 && S[(i + 1) * K + j] === 1;
    if (!r && j < k) { const L = cl[j]; if (fits(i, L)) r = i + L === n ? j + 1 === k : cur[i + L] !== 1 && S[(i + L + 1) * K + j + 1] === 1; }
    S[i * K + j] = r ? 1 : 0;
  }
  if (!S[0]) return -1;
  const P = new Uint8Array((n + 2) * K), can0 = new Uint8Array(n), can1 = new Uint8Array(n);
  P[0] = 1;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= k; j++) {
    if (!P[i * K + j]) continue;
    if (i < n && cur[i] !== 1 && S[(i + 1) * K + j]) { can0[i] = 1; P[(i + 1) * K + j] = 1; }
    if (j < k) {
      const L = cl[j];
      if (!fits(i, L)) continue;
      const ok = i + L === n ? j + 1 === k : cur[i + L] !== 1 && S[(i + L + 1) * K + j + 1] === 1;
      if (!ok) continue;
      for (let t = i; t < i + L; t++) can1[t] = 1;
      if (i + L < n) { can0[i + L] = 1; P[(i + L + 1) * K + j + 1] = 1; }
    }
  }
  let ch = 0;
  for (let t = 0; t < n; t++) {
    if (cur[t] !== -1) continue;
    if (can0[t] && !can1[t]) { cur[t] = 0; ch++; } else if (can1[t] && !can0[t]) { cur[t] = 1; ch++; }
  }
  return ch;
}

const cluesOf = (l: ArrayLike<number>) => { const c: number[] = []; let r = 0; for (let i = 0; i < l.length; i++) { if (l[i] === 1) r++; else if (r) { c.push(r); r = 0; } } if (r) c.push(r); return c; };

/**
 * 1: only the stored picture fits the clues; 2: there is another one; 0: undecided within the budget
 * (very large grids). rows use '#' for filled.
 */
export function solutionCount(rows: string[], budgetMs = 300): 0 | 1 | 2 {
  const until = Date.now() + budgetMs;
  const h = rows.length, w = rows[0]?.length ?? 0;
  const goal = rows.join('').split('').map(c => (c === '#' ? 1 : 0));
  const rc: number[][] = [], cc: number[][] = [];
  for (let y = 0; y < h; y++) rc.push(cluesOf(goal.slice(y * w, y * w + w)));
  for (let x = 0; x < w; x++) { const l: number[] = []; for (let y = 0; y < h; y++) l.push(goal[y * w + x]); cc.push(cluesOf(l)); }
  let work = 0, found = 0, gaveUp = false;
  const row = new Int8Array(w), col = new Int8Array(h);
  const propagate = (g: Int8Array): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) row[x] = g[y * w + x];
        const r = solveLine(row, rc[y]);
        if (r < 0) return false;
        if (r) { changed = true; for (let x = 0; x < w; x++) g[y * w + x] = row[x]; }
      }
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) col[y] = g[y * w + x];
        const r = solveLine(col, cc[x]);
        if (r < 0) return false;
        if (r) { changed = true; for (let y = 0; y < h; y++) g[y * w + x] = col[y]; }
      }
    }
    return true;
  };
  const search = (g: Int8Array) => {
    if (found > 1 || gaveUp) return;
    if ((++work & 7) === 0 && Date.now() > until) { gaveUp = true; return; }
    if (!propagate(g)) return;
    const open = g.indexOf(-1);
    if (open < 0) { found++; return; }
    for (const v of [1, 0]) { const c = g.slice(); c[open] = v; search(c); if (found > 1 || gaveUp) return; }
  };
  search(new Int8Array(w * h).fill(-1));
  return found > 1 ? 2 : gaveUp ? 0 : found === 1 ? 1 : 0;
}
