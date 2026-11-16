// Puzzle state and Picross DS rules (Normal: mistakes are caught and cost time; Free: no checks, "Try it out").

export const EMPTY = 0, FILL = 1, CROSS = 2;
export type Cell = 0 | 1 | 2;

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

export interface BoardSnapshot { cells: number[]; trial: number[] | null; mistakes: number; elapsedMs: number; penaltyMs: number; hintRow: number; hintCol: number }

export class Board {
  readonly w: number;
  readonly h: number;
  readonly solution: Uint8Array;
  readonly rowClues: number[][];
  readonly colClues: number[][];
  readonly rules: 'normal' | 'free';
  cells: Uint8Array;
  /** "Try it out" layer (Free mode): marks placed on top of the real board */
  trial: Uint8Array | null = null;
  mistakes = 0;
  penaltyMs = 0;
  elapsedMs = 0;
  hintRow = -1;
  hintCol = -1;
  solved = false;
  private undoStack: Array<{ cells: Uint8Array; trial: Uint8Array | null }> = [];

  constructor(rows: string[], rules: 'normal' | 'free') {
    this.h = rows.length;
    this.w = rows[0].length;
    this.rules = rules;
    this.solution = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.solution[y * this.w + x] = rows[y][x] === '#' ? 1 : 0;
    this.cells = new Uint8Array(this.w * this.h);
    this.rowClues = [...Array(this.h)].map((_, y) => lineClues(this.solution.subarray(y * this.w, y * this.w + this.w)));
    this.colClues = [...Array(this.w)].map((_, x) => lineClues([...Array(this.h)].map((_, y) => this.solution[y * this.w + x])));
  }

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

  pushUndo() {
    this.undoStack.push({ cells: this.cells.slice(), trial: this.trial ? this.trial.slice() : null });
    if (this.undoStack.length > 300) this.undoStack.shift();
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.cells = s.cells;
    this.trial = s.trial;
    return true;
  }

  /**
   * Apply a mark. Returns 'mistake' if Normal rules caught a wrong fill.
   * value: FILL, CROSS or EMPTY (erase).
   */
  set(x: number, y: number, value: Cell): 'ok' | 'mistake' | 'nochange' {
    if (this.solved || x < 0 || y < 0 || x >= this.w || y >= this.h) return 'nochange';
    const i = y * this.w + x;
    if (this.trial) {
      if (this.cells[i] !== EMPTY) return 'nochange';
      if (this.trial[i] === value) return 'nochange';
      this.trial[i] = value;
      return 'ok';
    }
    if (this.cells[i] === value) return 'nochange';
    if (this.rules === 'normal' && value === FILL && !this.solution[i]) {
      this.cells[i] = CROSS;
      this.mistakes++;
      this.penaltyMs += Board.penaltyFor(this.mistakes);
      return 'mistake';
    }
    // Normal rules: a correctly filled cell stays filled (the game knows it is right)
    if (this.rules === 'normal' && this.cells[i] === FILL && this.solution[i] && value !== FILL) return 'nochange';
    this.cells[i] = value;
    return 'ok';
  }

  startTrial() { if (!this.trial) this.trial = new Uint8Array(this.w * this.h); }
  /** keep the trial marks */
  commitTrial() {
    if (!this.trial) return;
    for (let i = 0; i < this.trial.length; i++) if (this.trial[i]) this.cells[i] = this.trial[i];
    this.trial = null;
  }
  discardTrial() { this.trial = null; }

  filledAt(i: number): boolean {
    const t = this.trial?.[i];
    return (t || this.cells[i]) === FILL;
  }

  rowDone(y: number): boolean[] { return this.lineDone(this.rowClues[y], [...Array(this.w)].map((_, x) => this.filledAt(y * this.w + x))); }
  colDone(x: number): boolean[] { return this.lineDone(this.colClues[x], [...Array(this.h)].map((_, y) => this.filledAt(y * this.w + x))); }

  /** Which clue numbers of a line are satisfied (greyed out), using DS-like matching from both ends. */
  private lineDone(clues: number[], line: boolean[]): boolean[] {
    const runs = lineClues(line);
    const done = clues.map(() => false);
    if (runs.length === clues.length && runs.every((r, i) => r === clues[i])) return clues.map(() => true);
    if (clues.length === 1 && clues[0] === 0) return [runs.length === 0];
    // match runs that are anchored at the line start
    const blocks: Array<{ start: number; len: number }> = [];
    let s = -1;
    for (let i = 0; i <= line.length; i++) {
      if (i < line.length && line[i]) { if (s < 0) s = i; }
      else if (s >= 0) { blocks.push({ start: s, len: i - s }); s = -1; }
    }
    // left to right: blocks are certain while each block is preceded only by crosses/edge-certain cells
    for (let k = 0; k < blocks.length && k < clues.length; k++) {
      if (blocks[k].len !== clues[k]) break;
      done[k] = true;
    }
    for (let k = 0; k < blocks.length && k < clues.length; k++) {
      const b = blocks[blocks.length - 1 - k], c = clues.length - 1 - k;
      if (b.len !== clues[c]) break;
      done[c] = true;
    }
    return done;
  }

  /** Solved when filled cells reproduce every clue (so puzzles with several solutions are fair). */
  checkSolved(): boolean {
    if (this.trial) return false;
    for (let y = 0; y < this.h; y++) {
      const c = lineClues([...Array(this.w)].map((_, x) => this.cells[y * this.w + x] === FILL));
      if (c.join() !== this.rowClues[y].join()) return false;
    }
    for (let x = 0; x < this.w; x++) {
      const c = lineClues([...Array(this.h)].map((_, y) => this.cells[y * this.w + x] === FILL));
      if (c.join() !== this.colClues[x].join()) return false;
    }
    this.solved = true;
    return true;
  }

  /** Hint roulette: reveal one row and one column (Normal mode, at the start). */
  revealHint(rnd = Math.random) {
    this.hintRow = Math.floor(rnd() * this.h);
    this.hintCol = Math.floor(rnd() * this.w);
    for (let x = 0; x < this.w; x++) { const i = this.hintRow * this.w + x; this.cells[i] = this.solution[i] ? FILL : CROSS; }
    for (let y = 0; y < this.h; y++) { const i = y * this.w + this.hintCol; this.cells[i] = this.solution[i] ? FILL : CROSS; }
  }

  snapshot(): BoardSnapshot {
    return { cells: [...this.cells], trial: this.trial ? [...this.trial] : null, mistakes: this.mistakes, elapsedMs: this.elapsedMs, penaltyMs: this.penaltyMs, hintRow: this.hintRow, hintCol: this.hintCol };
  }

  restore(s: BoardSnapshot) {
    if (s.cells.length !== this.cells.length) return;
    this.cells = Uint8Array.from(s.cells);
    this.trial = s.trial ? Uint8Array.from(s.trial) : null;
    this.mistakes = s.mistakes; this.elapsedMs = s.elapsedMs; this.penaltyMs = s.penaltyMs;
    this.hintRow = s.hintRow; this.hintCol = s.hintCol;
  }
}

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
