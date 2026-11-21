// Mega nonograms ("Mega Picross" in Jupiter's games, デカピクロス in Japan).
//
// Some pairs of neighbouring lines are joined into a band. In a band, every group of filled cells that is
// connected (side by side) and reaches into both lines is counted by one mega number, its total size; groups that
// stay in one of the two lines are counted by that line's normal numbers. The games store only the picture and
// which lines are paired (checked against all 150 Mega puzzles of PICROSS e7: the clues follow from these two
// exactly), so MomoGram keeps the same and computes the clues. For games without Mega data, pairs are chosen by
// `generateMega` and checked to leave exactly one solution.
//
// A band's clue is a list of items in order along the band. Items never share a column: a group in one line with
// filled cells beside it in the other line would be connected to them.

export interface MegaPairs {
  /** first row of each pair of rows (rows y and y + 1) */
  rows: number[];
  /** first column of each pair of columns */
  cols: number[];
}

/** one number of a band: in the first line, the second line, or a mega number over both */
export interface BandItem { kind: 'a' | 'b' | 'm'; n: number }

/** the items of a band, from its two lines (truthy = filled) */
export function bandItems(a: ArrayLike<number | boolean>, b: ArrayLike<number | boolean>): BandItem[] {
  const n = a.length, out: BandItem[] = [];
  let cur: { seen: number; size: number } | null = null, last = 0;
  const end = () => { if (cur) out.push({ kind: cur.seen === 3 ? 'm' : cur.seen === 1 ? 'a' : 'b', n: cur.size }); cur = null; };
  for (let i = 0; i < n; i++) {
    const p = (a[i] ? 1 : 0) | (b[i] ? 2 : 0);
    if (!p) { end(); last = 0; continue; }
    if (cur && (p & last)) { cur.seen |= p; cur.size += p === 3 ? 2 : 1; }
    else { end(); cur = { seen: p, size: p === 3 ? 2 : 1 }; }
    last = p;
  }
  end();
  return out;
}

/** the numbers each line of the band shows, in order: [first line, second line]; mega numbers appear in both */
export function bandSides(items: BandItem[]): [Array<{ n: number; mega: boolean; k: number }>, Array<{ n: number; mega: boolean; k: number }>] {
  const a: Array<{ n: number; mega: boolean; k: number }> = [], b: typeof a = [];
  items.forEach((it, k) => {
    if (it.kind !== 'b') a.push({ n: it.n, mega: it.kind === 'm', k });
    if (it.kind !== 'a') b.push({ n: it.n, mega: it.kind === 'm', k });
  });
  return [a, b];
}

/**
 * Clue slots of a band for drawing, left to right: a mega number takes a whole slot (both lines); a number of the
 * first line and a following one of the second line (or the other way round) share a slot.
 */
export function bandSlots(items: BandItem[]): Array<{ a?: number; b?: number; m?: number; k: number[] }> {
  const out: Array<{ a?: number; b?: number; m?: number; k: number[] }> = [];
  items.forEach((it, k) => {
    const last = out[out.length - 1];
    if (it.kind === 'm') { out.push({ m: it.n, k: [k] }); return; }
    const side = it.kind;
    if (last && last.m === undefined && last[side] === undefined && last[side === 'a' ? 'b' : 'a'] !== undefined) { last[side] = it.n; last.k.push(k); return; }
    out.push({ [side]: it.n, k: [k] } as { a?: number; b?: number; k: number[] });
  });
  return out;
}

const pop = (p: number) => (p & 1) + (p >> 1);

export interface BandInfo {
  feasible: boolean;
  /** cell can be filled / left empty in some solution of the band (index: line * n + i) */
  canFill: Uint8Array; canEmpty: Uint8Array;
  /** every open cell of the band is decided: all its numbers are done */
  done: boolean;
  /** an open cell is forced by the band's clue and the marks alone */
  progress: boolean;
}

/**
 * Every arrangement of a band's items that agrees with the marks (cells per line: -1 / 0 open, 1 filled, 2 crossed
 * or known empty; `known` tells which values mean "decided"). States, column by column: items finished, whether
 * one is open, its size and which lines it reached so far, and the last column's pattern.
 */
export function analyzeBand(items: BandItem[], cellA: ArrayLike<number>, cellB: ArrayLike<number>, filled: (v: number) => boolean, empty: (v: number) => boolean): BandInfo {
  const n = cellA.length, K = items.length;
  const maxS = 2 * n + 1;
  // state = (((k * 2 + inside) * maxS + size) * 4 + seen) * 4 + last
  const enc = (k: number, inside: number, size: number, seen: number, last: number) => ((((k * 2 + inside) * maxS + size) * 4 + seen) * 4 + last);
  const dec = (s: number) => { const last = s & 3; s >>= 2; const seen = s & 3; s >>= 2; const size = s % maxS; s = (s - size) / maxS; return { k: s >> 1, inside: s & 1, size, seen, last }; };
  const fits = (it: BandItem, p: number) => it.kind === 'm' || (it.kind === 'a' ? p === 1 : p === 2);
  const complete = (k: number, size: number, seen: number) => size === items[k].n && (items[k].kind !== 'm' || seen === 3);
  const start = (k: number, p: number) => (k < K && fits(items[k], p) && pop(p) <= items[k].n ? enc(k, 1, pop(p), p, p) : -1);
  const next = (s: number, p: number): number => {
    const { k, inside, size, seen, last } = dec(s);
    if (!inside) return p ? start(k, p) : s & ~3; // last = 0
    if (!p) return complete(k, size, seen) ? enc(k + 1, 0, 0, 0, 0) : -1;
    if (p & last) {
      const it = items[k];
      if (!fits(it, p)) return -1;
      const ns = size + pop(p);
      return ns <= it.n ? enc(k, 1, ns, seen | p, p) : -1;
    }
    if (!complete(k, size, seen)) return -1;
    return start(k + 1, p);
  };
  const accept = (s: number) => { const { k, inside, size, seen } = dec(s); return inside ? k === K - 1 && complete(k, size, seen) : k === K; };
  const allowed = (i: number) => {
    const out: number[] = [];
    for (let p = 0; p < 4; p++) {
      if ((p & 1) ? empty(cellA[i]) : filled(cellA[i])) continue;
      if ((p & 2) ? empty(cellB[i]) : filled(cellB[i])) continue;
      out.push(p);
    }
    return out;
  };
  const reach: Array<Set<number>> = [new Set([enc(0, 0, 0, 0, 0)])];
  const pats = [...Array(n)].map((_, i) => allowed(i));
  for (let i = 0; i < n; i++) {
    const nx = new Set<number>();
    for (const s of reach[i]) for (const p of pats[i]) { const t = next(s, p); if (t >= 0) nx.add(t); }
    reach.push(nx);
  }
  const canFill = new Uint8Array(2 * n), canEmpty = new Uint8Array(2 * n);
  let good = new Set([...reach[n]].filter(accept));
  const feasible = good.size > 0;
  if (feasible) {
    for (let i = n - 1; i >= 0; i--) {
      const g = new Set<number>();
      for (const s of reach[i]) for (const p of pats[i]) {
        const t = next(s, p);
        if (t < 0 || !good.has(t)) continue;
        g.add(s);
        if (p & 1) canFill[i] = 1; else canEmpty[i] = 1;
        if (p & 2) canFill[n + i] = 1; else canEmpty[n + i] = 1;
      }
      good = g;
    }
  }
  let progress = false, open = false;
  for (let j = 0; j < 2 * n; j++) {
    const v = j < n ? cellA[j] : cellB[j - n];
    if (filled(v) || empty(v)) continue;
    open = true;
    if (feasible && (!canFill[j] || !canEmpty[j])) progress = true;
  }
  // done: nothing left open that the clue doesn't already decide, and the filled cells form exactly the items
  let done = false;
  if (feasible) {
    let decided = true;
    for (let j = 0; j < 2 * n && decided; j++) if (canFill[j] && canEmpty[j]) decided = false;
    if (decided) {
      const A = [...Array(n)].map((_, i) => filled(cellA[i])), B = [...Array(n)].map((_, i) => filled(cellB[i]));
      done = bandItems(A, B).map(x => x.kind + x.n).join() === items.map(x => x.kind + x.n).join();
    }
  }
  void open;
  return { feasible, canFill, canEmpty, done, progress };
}

/** for each line, the pair it belongs to: the pair's first line, or -1 */
export function pairOf(pairs: number[] | undefined, len: number): Int32Array {
  const out = new Int32Array(len).fill(-1);
  for (const p of pairs ?? []) if (p >= 0 && p + 1 < len) { out[p] = p; out[p + 1] = p; }
  return out;
}

// ---------------------------------------------------------------- uniqueness with mega numbers

const runs = (l: ArrayLike<number>) => { const c: number[] = []; let r = 0; for (let i = 0; i < l.length; i++) { if (l[i] === 1) r++; else if (r) { c.push(r); r = 0; } } if (r) c.push(r); return c; };

/** solve one plain line in place (-1 open, 0 empty, 1 filled): cells decided, or -1 when impossible */
function solvePlain(cur: Int8Array, cl: number[]): number {
  const n = cur.length, k = cl.length, K = k + 1;
  const zr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) zr[i + 1] = zr[i] + (cur[i] === 0 ? 1 : 0);
  const fits = (s: number, L: number) => s + L <= n && zr[s + L] - zr[s] === 0;
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

const isFilled = (v: number) => v === 1, isEmpty = (v: number) => v === 0;

/** solve a band in place: cells decided, or -1 */
function solveBand(a: Int8Array, b: Int8Array, items: BandItem[]): number {
  const r = analyzeBand(items, a, b, isFilled, isEmpty);
  if (!r.feasible) return -1;
  const n = a.length;
  let ch = 0;
  for (let j = 0; j < 2 * n; j++) {
    const line = j < n ? a : b, i = j < n ? j : j - n;
    if (line[i] !== -1) continue;
    if (r.canFill[j] && !r.canEmpty[j]) { line[i] = 1; ch++; } else if (r.canEmpty[j] && !r.canFill[j]) { line[i] = 0; ch++; }
  }
  return ch;
}

/**
 * 1: only the picture fits its clues (with these pairs); 2: another picture fits too; 0: undecided within the
 * budget. With no pairs this is the plain puzzle.
 */
export function megaSolutionCount(rows: string[], mega: MegaPairs | undefined, budgetMs = 300, maxSteps = Infinity): 0 | 1 | 2 {
  // a step budget (instead of time) gives the same answer on every device
  const until = maxSteps < Infinity ? Infinity : Date.now() + budgetMs;
  let steps = 0;
  const h = rows.length, w = rows[0]?.length ?? 0;
  const goal = rows.join('').split('').map(c => (c === '#' ? 1 : 0));
  const rp = pairOf(mega?.rows, h), cp = pairOf(mega?.cols, w);
  type Unit = { cells: number[][]; plain?: number[]; band?: BandItem[] };
  const units: Unit[] = [];
  for (let y = 0; y < h; y++) {
    const idx = (yy: number) => [...Array(w)].map((_, x) => yy * w + x);
    if (rp[y] < 0) units.push({ cells: [idx(y)], plain: runs(idx(y).map(i => goal[i])) });
    else if (rp[y] === y) units.push({ cells: [idx(y), idx(y + 1)], band: bandItems(idx(y).map(i => goal[i]), idx(y + 1).map(i => goal[i])) });
  }
  for (let x = 0; x < w; x++) {
    const idx = (xx: number) => [...Array(h)].map((_, y) => y * w + xx);
    if (cp[x] < 0) units.push({ cells: [idx(x)], plain: runs(idx(x).map(i => goal[i])) });
    else if (cp[x] === x) units.push({ cells: [idx(x), idx(x + 1)], band: bandItems(idx(x).map(i => goal[i]), idx(x + 1).map(i => goal[i])) });
  }
  let work = 0, found = 0, gaveUp = false;
  const propagate = (g: Int8Array): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const u of units) {
        if (++steps > maxSteps) { gaveUp = true; return false; }
        const ls = u.cells.map(c => Int8Array.from(c, i => g[i]));
        const r = u.plain ? solvePlain(ls[0], u.plain) : solveBand(ls[0], ls[1], u.band!);
        if (r < 0) return false;
        if (r) { changed = true; u.cells.forEach((c, l) => c.forEach((i, k) => { g[i] = ls[l][k]; })); }
      }
      if (Date.now() > until) { gaveUp = true; return false; }
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

// ---------------------------------------------------------------- pairs for games without Mega data

/** seeded random numbers from a picture (the same pairs on every device) */
function seeded(rows: string[]) {
  let s = 2166136261;
  for (const c of rows.join('/')) { s ^= c.charCodeAt(0); s = Math.imul(s, 16777619); }
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** line pairs where joining makes at least one mega number */
function candidates(len: number, other: number, at: (line: number, i: number) => boolean): number[] {
  const out: number[] = [];
  for (let l = 0; l + 1 < len; l++) {
    const a = [...Array(other)].map((_, i) => at(l, i)), b = [...Array(other)].map((_, i) => at(l + 1, i));
    if (bandItems(a, b).some(x => x.kind === 'm')) out.push(l);
  }
  return out;
}

/**
 * Pairs for a picture without Mega data, as the games choose them: about a third of the lines joined, no line in
 * two pairs, every pair with at least one mega number, and exactly one picture fitting the clues. null when no
 * such choice is found (tiny pictures, pictures that already have several solutions). The same picture always
 * gets the same pairs, on every device.
 */
/** version of the choice below: a new version may choose other pairs, so saved results carry it */
export const MEGA_GEN = 1;

export function generateMega(rows: string[]): MegaPairs | null {
  const h = rows.length, w = rows[0]?.length ?? 0;
  if (w < 4 || h < 4) return null;
  const rnd = seeded(rows);
  const cell = (x: number, y: number) => rows[y][x] === '#';
  const rc = candidates(h, w, (l, i) => cell(i, l)), cc = candidates(w, h, (l, i) => cell(l, i));
  if (!rc.length && !cc.length) return null;
  // pairs are added one by one in a random order (seeded by the picture); one that leaves a second solution, or
  // that the solver can't decide within a fixed number of steps, is left out. No clocks are involved, so every
  // device chooses the same pairs.
  const want = Math.max(1, Math.round((w + h) * 0.33 / 2));
  // Fisher–Yates (sort() with a random comparator differs between browser engines)
  const order = [...rc.map(l => ({ r: true, l })), ...cc.map(l => ({ r: false, l }))];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const m: MegaPairs = { rows: [], cols: [] };
  let n = 0;
  for (const c of order) {
    if (n >= want) break;
    const list = c.r ? m.rows : m.cols;
    if (list.some(o => Math.abs(o - c.l) < 2)) continue;
    list.push(c.l);
    if (megaSolutionCount(rows, m, 0, 20000) === 1) n++;
    else list.pop();
  }
  m.rows.sort((a, b) => a - b); m.cols.sort((a, b) => a - b);
  if (n) return m;
  return null;
}
