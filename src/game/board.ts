// Puzzle state and Picross DS rules (Normal: mistakes are caught and cost time; Free: no checks, "Try it out").
import { MegaPairs, BandItem, bandItems, analyzeBand, pairOf } from './mega';
import { ColorPuzzle, ColorClue, colorClues, colorLine } from './color';

export const EMPTY = 0, FILL = 1, CROSS = 2;
/** a note of the player's own: counts as empty for everything, stays while the rest of the board is played */
export const MARK = 3;
/** empty or only marked */
export const blank = (v: number) => v === EMPTY || v === MARK;
export type Cell = 0 | 1 | 2 | 3;

export function lineClues(line: ArrayLike<boolean | number>): number[] {
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i]) run++;
    else if (run) { out.push(run); run = 0; }
  }
  if (run) out.push(run);
  return out;
}

export interface BoardSnapshot { cells: number[]; trial: number[] | null; colors?: number[]; trialColors?: number[] | null; mistakes: number; elapsedMs: number; penaltyMs: number; hintRow: number; hintCol: number }

export class Board {
  readonly w: number;
  readonly h: number;
  readonly solution: Uint8Array;
  readonly rowClues: number[][];
  readonly colClues: number[][];
  /** easy: mistakes caught, no penalty · normal: caught, 2/4/8 min penalty · free (Hard): no checks */
  readonly rules: 'easy' | 'normal' | 'free';
  cells: Uint8Array;
  /** "Try it out" layer (Free mode): marks placed on top of the real board */
  trial: Uint8Array | null = null;
  mistakes = 0;
  penaltyMs = 0;
  elapsedMs = 0;
  hintRow = -1;
  hintCol = -1;
  solved = false;
  private undoStack: Array<{ cells: Uint8Array; trial: Uint8Array | null; colors: Uint8Array; trialColors: Uint8Array | null }> = [];

  /** Colour puzzles: the palette, per cell the solution's colour (0 empty, k + 1), the clues with their colours,
   *  and per cell the colour of a filled cell (and of a filled trial cell) */
  readonly color: ColorPuzzle | null;
  readonly rowColorClues: ColorClue[][] = [];
  readonly colColorClues: ColorClue[][] = [];
  colors: Uint8Array;
  trialColors: Uint8Array | null = null;

  /** Mega puzzles: per line, the first line of its pair (-1: a plain line), and each pair's clue */
  readonly rowPair: Int32Array;
  readonly colPair: Int32Array;
  readonly bands = new Map<string, BandItem[]>();
  readonly mega: MegaPairs | null;

  constructor(rows: string[], rules: 'easy' | 'normal' | 'free', mega: MegaPairs | null = null, color: ColorPuzzle | null = null) {
    this.h = rows.length;
    this.w = rows[0].length;
    this.rules = rules;
    this.color = color;
    this.colors = new Uint8Array(this.w * this.h);
    this.solution = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.solution[y * this.w + x] = rows[y][x] === '#' ? 1 : 0;
    this.cells = new Uint8Array(this.w * this.h);
    this.rowClues = [...Array(this.h)].map((_, y) => lineClues(this.solution.subarray(y * this.w, y * this.w + this.w)));
    this.colClues = [...Array(this.w)].map((_, x) => lineClues([...Array(this.h)].map((_, y) => this.solution[y * this.w + x])));
    if (color) {
      // colour clues: blocks of different colours may touch, so a line can have more numbers than in black and white
      this.rowColorClues = [...Array(this.h)].map((_, y) => colorClues(color.cells.subarray(y * this.w, y * this.w + this.w)));
      this.colColorClues = [...Array(this.w)].map((_, x) => colorClues([...Array(this.h)].map((_, y) => color.cells[y * this.w + x])));
      this.rowClues = this.rowColorClues.map(c => c.length ? c.map(q => q.n) : [0]);
      this.colClues = this.colColorClues.map(c => c.length ? c.map(q => q.n) : [0]);
      mega = null;
    }
    this.mega = mega && (mega.rows.length || mega.cols.length) ? mega : null;
    this.rowPair = pairOf(this.mega?.rows, this.h);
    this.colPair = pairOf(this.mega?.cols, this.w);
    for (const y of this.mega?.rows ?? []) if (this.rowPair[y] === y) this.bands.set('r' + y, bandItems(this.rowOf(this.solution, y), this.rowOf(this.solution, y + 1)));
    for (const x of this.mega?.cols ?? []) if (this.colPair[x] === x) this.bands.set('c' + x, bandItems(this.colOf(this.solution, x), this.colOf(this.solution, x + 1)));
  }

  private rowOf(a: ArrayLike<number>, y: number): number[] { return [...Array(this.w)].map((_, x) => a[y * this.w + x]); }
  private colOf(a: ArrayLike<number>, x: number): number[] { return [...Array(this.h)].map((_, y) => a[y * this.w + x]); }
  /** the clue of the pair a row / column belongs to (null: a plain line) */
  rowBand(y: number): BandItem[] | null { return this.rowPair[y] < 0 ? null : this.bands.get('r' + this.rowPair[y]) ?? null; }
  colBand(x: number): BandItem[] | null { return this.colPair[x] < 0 ? null : this.bands.get('c' + this.colPair[x]) ?? null; }

  /** Penalty for the n-th mistake (1-based), like Picross DS: 2, 4, then 8 minutes. */
  static penaltyFor(n: number): number {
    return (n === 1 ? 2 : n === 2 ? 4 : 8) * 60_000;
  }

  get totalMs(): number { return this.elapsedMs + this.penaltyMs; }

  at(x: number, y: number): Cell {
    const t = this.trial?.[y * this.w + x];
    if (t) return t as Cell;
    return this.cells[y * this.w + x] as Cell;
  }

  isTrialCell(x: number, y: number): boolean { return !!this.trial?.[y * this.w + x]; }
  /** colour puzzles: the colour index of a filled cell (as the player sees it) */
  colorAt(x: number, y: number): number {
    const i = y * this.w + x;
    return this.trial?.[i] ? this.trialColors?.[i] ?? 0 : this.colors[i];
  }
  /** colour puzzles: the solution's colour index of a cell (-1: empty) */
  solColor(i: number): number { return this.color ? this.color.cells[i] - 1 : this.solution[i] ? 0 : -1; }

  pushUndo() {
    this.undoStack.push({ cells: this.cells.slice(), trial: this.trial ? this.trial.slice() : null, colors: this.colors.slice(), trialColors: this.trialColors ? this.trialColors.slice() : null });
    if (this.undoStack.length > 300) this.undoStack.shift();
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.touch();
    this.cells = s.cells;
    this.trial = s.trial;
    this.colors = s.colors; this.trialColors = s.trialColors;
    return true;
  }

  /**
   * Apply a mark. Returns 'mistake' if Normal rules caught a wrong fill.
   * value: FILL, CROSS or EMPTY (erase).
   */
  set(x: number, y: number, value: Cell, color = 0): 'ok' | 'mistake' | 'nochange' {
    const r = this.set0(x, y, value, color);
    // only this cell's row and column can change their clue state
    if (r !== 'nochange') {
      this.version++;
      this.cache.delete('r' + (this.rowPair[y] >= 0 ? this.rowPair[y] : y));
      this.cache.delete('c' + (this.colPair[x] >= 0 ? this.colPair[x] : x));
    }
    return r;
  }
  private set0(x: number, y: number, value: Cell, color = 0): 'ok' | 'mistake' | 'nochange' {
    if (this.solved || x < 0 || y < 0 || x >= this.w || y >= this.h) return 'nochange';
    const i = y * this.w + x;
    if (!this.color) color = 0;
    // marks belong to the board itself, also while trying something out
    if (value === MARK || (value === EMPTY && this.cells[i] === MARK && !this.trial?.[i])) {
      if (value === MARK && this.cells[i] !== EMPTY) return 'nochange';
      if (this.cells[i] === value) return 'nochange';
      this.cells[i] = value;
      return 'ok';
    }
    if (this.trial) {
      if (!blank(this.cells[i])) return 'nochange';
      if (this.trial[i] === value && (value !== FILL || this.trialColors?.[i] === color)) return 'nochange';
      this.trial[i] = value;
      (this.trialColors ??= new Uint8Array(this.w * this.h))[i] = value === FILL ? color : 0;
      return 'ok';
    }
    if (this.cells[i] === value && (value !== FILL || this.colors[i] === color)) return 'nochange';
    // Easy / Normal: a fill where the picture has no cell (or another colour) is caught
    if (this.rules !== 'free' && value === FILL && (!this.solution[i] || (this.color && this.solColor(i) !== color))) {
      this.mistakes++;
      if (this.rules === 'normal') this.penaltyMs += Board.penaltyFor(this.mistakes);
      // black and white: the cell is crossed out; colour: the right colour is shown (the cell is known now)
      if (this.color && this.solution[i]) { this.cells[i] = FILL; this.colors[i] = this.solColor(i); }
      else { this.cells[i] = CROSS; this.colors[i] = 0; }
      return 'mistake';
    }
    // Normal rules: a correctly filled cell stays filled (the game knows it is right)
    if (this.rules !== 'free' && this.cells[i] === FILL && this.solution[i] && (!this.color || this.colors[i] === this.solColor(i)) && value !== FILL) return 'nochange';
    this.cells[i] = value;
    this.colors[i] = value === FILL ? color : 0;
    return 'ok';
  }

  hasMarks(): boolean { return this.cells.includes(MARK); }
  /** colour puzzles: what is left to fill per colour (cells of the solution not yet filled with that colour) */
  colorsLeft(): number[] {
    const left = (this.color?.palette ?? []).map(() => 0);
    if (!this.color) return left;
    for (let i = 0; i < this.cells.length; i++) { const k = this.color.cells[i] - 1; if (k >= 0 && !(this.cells[i] === FILL && this.colors[i] === k)) left[k]++; }
    return left;
  }
  clearMarks() { this.touch(); for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === MARK) this.cells[i] = EMPTY; this.version++; this.cache.clear(); }
  /** turn every mark into a fill (as if each was filled by hand: wrong ones count as mistakes under the rules) */
  fillMarks(): number {
    let mistakes = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === MARK) { this.cells[i] = EMPTY; if (this.set(i % this.w, Math.floor(i / this.w), FILL) === 'mistake') mistakes++; }
    this.touch();
    return mistakes;
  }
  startTrial() { this.touch(); if (!this.trial) { this.trial = new Uint8Array(this.w * this.h); this.trialColors = new Uint8Array(this.w * this.h); } }
  /** keep the trial marks */
  commitTrial() { this.touch();
    if (!this.trial) return;
    for (let i = 0; i < this.trial.length; i++) if (this.trial[i]) { this.cells[i] = this.trial[i]; this.colors[i] = this.trialColors?.[i] ?? 0; }
    this.trial = null; this.trialColors = null;
  }
  discardTrial() { this.touch(); this.trial = null; this.trialColors = null; }

  filledAt(i: number): boolean {
    const t = this.trial?.[i];
    return (t || this.cells[i]) === FILL;
  }

  /**
   * Practice: the values an empty cell can still take with its lines as they are, [FILL or CROSS, colour]
   * (Mega pairs and colours included). `only` asks one line alone (the row or the column).
   */
  optionsAt(i: number, only?: 'r' | 'c'): Array<[number, number]> {
    const x = i % this.w, y = (i / this.w) | 0;
    const c0 = this.cells[i], k0 = this.colors[i];
    const opts: Array<[number, number]> = [[CROSS, 0]];
    if (this.color) this.color.palette.forEach((_, c) => opts.push([FILL, c])); else opts.push([FILL, 0]);
    const rk = 'r' + (this.rowPair[y] >= 0 ? this.rowPair[y] : y), ck = 'c' + (this.colPair[x] >= 0 ? this.colPair[x] : x);
    const out: Array<[number, number]> = [];
    for (const [v, c] of opts) {
      this.cells[i] = v; this.colors[i] = c; this.cache.delete(rk); this.cache.delete(ck);
      if ((only === 'c' || this.line('r', y).feasible) && (only === 'r' || this.line('c', x).feasible)) out.push([v, c]);
    }
    this.cells[i] = c0; this.colors[i] = k0; this.cache.delete(rk); this.cache.delete(ck);
    return out;
  }

  // line analysis is cached until the next change
  private version = 0;
  private cache = new Map<string, LineInfo>();
  touch() { this.version++; this.cache.clear(); }
  private line(kind: 'r' | 'c', k: number): LineInfo {
    const pair = kind === 'r' ? this.rowPair[k] : this.colPair[k];
    if (pair >= 0) return this.band(kind, pair);
    const key = kind + k;
    let li = this.cache.get(key);
    if (!li && this.color) {
      const xs = kind === 'r' ? [...Array(this.w)].map((_, x) => [x, k]) : [...Array(this.h)].map((_, y) => [k, y]);
      li = analyzeColorLine(kind === 'r' ? this.rowColorClues[k] : this.colColorClues[k], xs.map(([x, y]) => this.at(x, y)), xs.map(([x, y]) => this.colorAt(x, y)), this.color.palette.length);
      this.cache.set(key, li);
    }
    if (!li) {
      const cells = kind === 'r' ? [...Array(this.w)].map((_, x) => this.at(x, k)) : [...Array(this.h)].map((_, y) => this.at(k, y));
      li = analyzeLine(kind === 'r' ? this.rowClues[k] : this.colClues[k], cells);
      this.cache.set(key, li);
    }
    return li;
  }
  /** a pair of lines (Mega): one analysis for both, with one "done" per number of the pair */
  private band(kind: 'r' | 'c', first: number): LineInfo {
    const key = kind + first;
    let li = this.cache.get(key);
    if (!li) {
      const items = this.bands.get(key) ?? [];
      const cur = (l: number) => (kind === 'r' ? [...Array(this.w)].map((_, x) => this.at(x, l)) : [...Array(this.h)].map((_, y) => this.at(l, y)));
      const r = analyzeBand(items, cur(first), cur(first + 1), v => v === FILL, v => v === CROSS);
      li = { feasible: r.feasible, done: items.map(() => r.done), progress: r.progress };
      this.cache.set(key, li);
    }
    return li;
  }
  /** which clue numbers are certainly done (greyed out); for a pair of lines: per number of the pair */
  rowDone(y: number): boolean[] { const d = this.line('r', y).done; return this.hideDone ? d.map(() => false) : d; }
  colDone(x: number): boolean[] { const d = this.line('c', x).done; return this.hideDone ? d.map(() => false) : d; }
  /** no clue number turns grey (practice: finding the mistakes must not be given away) */
  hideDone = false;
  /** logic hint: the line allows a new cell to be deduced from its clue alone */
  rowCanProgress(y: number): boolean { return this.line('r', y).progress; }
  colCanProgress(x: number): boolean { return this.line('c', x).progress; }

  /** Cross out every row and column whose clue is 0 (done for the player at the start, no undo step). */
  crossEmptyLines() {
    const zero = (c: number[]) => c.length === 0 || (c.length === 1 && c[0] === 0);
    // a pair of lines without any number counts as empty too
    const z = (c: number[], band: BandItem[] | null) => (band ? band.length === 0 : zero(c));
    for (let y = 0; y < this.h; y++) if (z(this.rowClues[y], this.rowBand(y))) for (let x = 0; x < this.w; x++) if (blank(this.at(x, y))) this.cells[y * this.w + x] = CROSS;
    for (let x = 0; x < this.w; x++) if (z(this.colClues[x], this.colBand(x))) for (let y = 0; y < this.h; y++) if (blank(this.at(x, y))) this.cells[y * this.w + x] = CROSS;
    this.touch();
  }

  /** Solved when filled cells reproduce every clue (so puzzles with several solutions are fair). */
  checkSolved(): boolean {
    if (this.trial) return false;
    if (this.color) {
      const v = (i: number) => (this.cells[i] === FILL ? this.colors[i] + 1 : 0);
      const key = (cl: ColorClue[]) => cl.map(c => c.n + ':' + c.c).join();
      for (let y = 0; y < this.h; y++) if (key(colorClues([...Array(this.w)].map((_, x) => v(y * this.w + x)))) !== key(this.rowColorClues[y])) return false;
      for (let x = 0; x < this.w; x++) if (key(colorClues([...Array(this.h)].map((_, y) => v(y * this.w + x)))) !== key(this.colColorClues[x])) return false;
      this.solved = true;
      return true;
    }
    const f = Uint8Array.from(this.cells, v => (v === FILL ? 1 : 0));
    for (const [key, items] of this.bands) {
      const k = +key.slice(1);
      const got = key[0] === 'r' ? bandItems(this.rowOf(f, k), this.rowOf(f, k + 1)) : bandItems(this.colOf(f, k), this.colOf(f, k + 1));
      if (got.map(i => i.kind + i.n).join() !== items.map(i => i.kind + i.n).join()) return false;
    }
    for (let y = 0; y < this.h; y++) {
      if (this.rowPair[y] >= 0) continue;
      const c = lineClues([...Array(this.w)].map((_, x) => this.cells[y * this.w + x] === FILL));
      if (c.join() !== this.rowClues[y].join()) return false;
    }
    for (let x = 0; x < this.w; x++) {
      if (this.colPair[x] >= 0) continue;
      const c = lineClues([...Array(this.h)].map((_, y) => this.cells[y * this.w + x] === FILL));
      if (c.join() !== this.colClues[x].join()) return false;
    }
    this.solved = true;
    return true;
  }

  /** Hint roulette: reveal one row and one column (Normal mode, at the start). */
  revealHint(rnd = Math.random, row = Math.floor(rnd() * this.h), col = Math.floor(rnd() * this.w)) { this.touch();
    this.hintRow = row;
    this.hintCol = col;
    for (let x = 0; x < this.w; x++) { const i = this.hintRow * this.w + x; this.cells[i] = this.solution[i] ? FILL : CROSS; this.colors[i] = Math.max(0, this.solColor(i)); }
    for (let y = 0; y < this.h; y++) { const i = y * this.w + this.hintCol; this.cells[i] = this.solution[i] ? FILL : CROSS; this.colors[i] = Math.max(0, this.solColor(i)); }
  }

  snapshot(): BoardSnapshot {
    return { cells: [...this.cells], trial: this.trial ? [...this.trial] : null, ...(this.color ? { colors: [...this.colors], trialColors: this.trialColors ? [...this.trialColors] : null } : {}), mistakes: this.mistakes, elapsedMs: this.elapsedMs, penaltyMs: this.penaltyMs, hintRow: this.hintRow, hintCol: this.hintCol };
  }

  restore(s: BoardSnapshot) { this.touch();
    if (s.cells.length !== this.cells.length) return;
    this.cells = Uint8Array.from(s.cells);
    this.trial = s.trial ? Uint8Array.from(s.trial) : null;
    if (s.colors?.length === this.cells.length) this.colors = Uint8Array.from(s.colors);
    this.trialColors = s.trialColors ? Uint8Array.from(s.trialColors) : this.trial ? new Uint8Array(this.cells.length) : null;
    this.mistakes = s.mistakes; this.elapsedMs = s.elapsedMs; this.penaltyMs = s.penaltyMs;
    this.hintRow = s.hintRow; this.hintCol = s.hintCol;
  }
}

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface LineInfo {
  /** the marks fit the clue at all */
  feasible: boolean;
  /** per clue number: its block is certainly in place, the only place left and completely filled (or the line is complete) */
  done: boolean[];
  /** some empty cell is forced (filled or crossed) by this line's clue and marks alone */
  progress: boolean;
  /** per cell: some placement fills it / leaves it empty (only when feasible and clues given) */
  canFill?: Uint8Array; canEmpty?: Uint8Array;
}

/**
 * Exact line analysis over every placement of the clue that agrees with the player's marks
 * (cells: 0 = empty, 1 = filled, 2 = crossed).
 */
export function analyzeLine(clues: number[], cells: ArrayLike<number>): LineInfo {
  const n = cells.length;
  const cl = clues.length === 1 && clues[0] === 0 ? [] : clues;
  const K = cl.length;
  const fill = (i: number) => cells[i] === FILL, cross = (i: number) => cells[i] === CROSS;
  // prefix counts for quick "no cross / no fill in range" tests
  const pc = new Int32Array(n + 1), pf = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { pc[i + 1] = pc[i] + (cross(i) ? 1 : 0); pf[i + 1] = pf[i] + (fill(i) ? 1 : 0); }
  const noCross = (a: number, b: number) => pc[b] - pc[a] === 0;
  const noFill = (a: number, b: number) => pf[b] - pf[a] === 0;
  // F[k][i]: clues 0..k-1 fit into cells [0, i)
  const F: Uint8Array[] = [...Array(K + 1)].map(() => new Uint8Array(n + 1));
  for (let i = 0; i <= n; i++) F[0][i] = noFill(0, i) ? 1 : 0;
  for (let k = 1; k <= K; k++) {
    const c = cl[k - 1];
    for (let i = 1; i <= n; i++) {
      let ok = F[k][i - 1] && !fill(i - 1);
      const st = i - c;
      if (!ok && st >= 0 && noCross(st, i)) ok = k === 1 ? !!F[0][st] : st >= 1 && !fill(st - 1) && !!F[k - 1][st - 1];
      F[k][i] = ok ? 1 : 0;
    }
  }
  // B[k][i]: clues k..K-1 fit into cells [i, n)
  const B: Uint8Array[] = [...Array(K + 1)].map(() => new Uint8Array(n + 2));
  for (let i = 0; i <= n; i++) B[K][i] = noFill(i, n) ? 1 : 0;
  for (let k = K - 1; k >= 0; k--) {
    const c = cl[k];
    for (let i = n - 1; i >= 0; i--) {
      let ok = B[k][i + 1] && !fill(i);
      const e = i + c;
      if (!ok && e <= n && noCross(i, e)) ok = k === K - 1 ? !!B[K][e] : e < n && !fill(e) && !!B[k + 1][e + 1];
      B[k][i] = ok ? 1 : 0;
    }
  }
  const feasible = K === 0 ? noFill(0, n) : !!B[0][0];
  const done = clues.map(() => false);
  if (!feasible) return { feasible, done, progress: false };
  if (K === 0) {
    // "0": done when nothing is filled; progress while cells are still open
    let open = false;
    for (let i = 0; i < n; i++) if (blank(cells[i])) open = true;
    return { feasible, done: [true], progress: open };
  }
  const canFill = new Uint8Array(n), canEmpty = new Uint8Array(n);
  for (let k = 0; k < K; k++) {
    const c = cl[k];
    let starts = 0, only = -1;
    for (let s = 0; s + c <= n; s++) {
      if (!noCross(s, s + c)) continue;
      if (s > 0 && fill(s - 1)) continue;
      if (s + c < n && fill(s + c)) continue;
      const left = k === 0 ? !!F[0][s] : s >= 1 && !!F[k][s - 1];
      const right = k === K - 1 ? !!B[K][s + c] : s + c + 1 <= n && !!B[k + 1][s + c + 1];
      if (!left || !right) continue;
      starts++; only = s;
      for (let i = s; i < s + c; i++) canFill[i] = 1;
    }
    // certain: the only place this block can still be, and it is completely filled (like Picross DS, no ✕ needed
    // around it: the cells next to it can only stay empty)
    done[k] = starts === 1 && pf[only + c] - pf[only] === c;
  }
  // the filled cells are exactly the clue: the whole line is done (the open cells can only stay empty)
  {
    const runs: number[] = [];
    let r = 0;
    for (let i = 0; i < n; i++) { if (fill(i)) r++; else if (r) { runs.push(r); r = 0; } }
    if (r) runs.push(r);
    if (runs.length === K && runs.every((v, i) => v === cl[i])) done.fill(true);
  }
  for (let i = 0; i < n; i++) {
    if (fill(i)) continue;
    for (let k = 0; k <= K && !canEmpty[i]; k++) if (F[k][i] && B[k][i + 1]) canEmpty[i] = 1;
  }
  let progress = false;
  for (let i = 0; i < n && !progress; i++) if (blank(cells[i]) && (!canFill[i] || !canEmpty[i])) progress = true;
  return { feasible, done, progress, canFill, canEmpty };
}

/**
 * A colour line as the player sees it: which clue numbers are certainly done, and whether a cell can be deduced
 * (logic hints). cells: EMPTY / FILL / CROSS / MARK, colors: the colour of each filled cell.
 */
export function analyzeColorLine(clues: ColorClue[], cells: number[], colors: number[], nCol: number): LineInfo {
  const n = cells.length, all = (1 << (nCol + 1)) - 1;
  const mask = cells.map((v, i) => (v === FILL ? 1 << (colors[i] + 1) : v === CROSS ? 1 : all));
  const r = colorLine(clues, mask);
  const done = clues.map(() => false);
  if (!r.ok) return { feasible: false, done, progress: false };
  const filledAs = (i: number, c: number) => cells[i] === FILL && colors[i] === c;
  clues.forEach((cl, k) => {
    const s = r.only[k];
    if (s < 0) return;
    let full = true;
    for (let i = s; i < s + cl.n; i++) if (!filledAs(i, cl.c)) full = false;
    done[k] = full;
  });
  // the filled cells are exactly the clue: the whole line is done
  const got = colorClues(cells.map((v, i) => (v === FILL ? colors[i] + 1 : 0)));
  if (got.length === clues.length && got.every((g, i) => g.n === clues[i].n && g.c === clues[i].c)) done.fill(true);
  let progress = false;
  for (let i = 0; i < n && !progress; i++) {
    if (!blank(cells[i])) continue;
    const m = r.out[i];
    // forced: only empty, or only one colour
    if (m === 1 || (!(m & 1) && (m & (m - 1)) === 0)) progress = true;
  }
  return { feasible: true, done, progress };
}
