// Colour nonograms. Every filled cell has a colour; a clue number has the colour of its block. Two blocks of the
// same colour need at least one empty cell between them, blocks of different colours may touch.
//
// A puzzle's colours come from its colour picture (PackPuzzle.color: palette + one character per cell). The cells
// that are filled in the black-and-white puzzle (rows '#') keep their colour, the rest is the empty background.
// Games with real colour puzzles mark them (colorGame); for other colour pictures MomoGram offers the colour
// version when it has few enough colours, and checks with the solver below how many solutions it has.
import { PackPuzzle, safeColor } from '../packs/format';

export interface ColorPuzzle {
  w: number; h: number;
  /** the colours in use (#rrggbb), in palette order */
  palette: string[];
  /** per cell: 0 = empty, k + 1 = colour k */
  cells: Uint8Array;
}
export interface ColorClue { n: number; c: number }

/** at most this many colours for a colour version made from a game's colour picture */
export const MAX_COLORS = 8;

/** the colour version of a puzzle (null: it has no colour picture, or too many colours) */
export function colorOf(z: PackPuzzle, max = z.colorGame ? 32 : MAX_COLORS): ColorPuzzle | null {
  if (!z.color) return null;
  const w = z.width, h = z.height;
  const used = new Map<number, number>(), palette: string[] = [];
  const cells = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (z.rows[y][x] !== '#') continue;
    const ch = z.color.rows[y]?.[x];
    const k = ch && ch !== '.' ? parseInt(ch, 36) : -1;
    const key = k < 0 ? -1 : k;
    if (!used.has(key)) {
      used.set(key, palette.length);
      palette.push(k < 0 ? '#202020' : safeColor(z.color.palette[k]));
    }
    cells[y * w + x] = used.get(key)! + 1;
  }
  if (!palette.length || palette.length > max) return null;
  // the same colour under two indices counts once
  const dedup = new Map<string, number>(), remap: number[] = [], pal: string[] = [];
  palette.forEach((c, i) => { const k = c.toLowerCase(); if (!dedup.has(k)) { dedup.set(k, pal.length); pal.push(c); } remap[i] = dedup.get(k)!; });
  for (let i = 0; i < cells.length; i++) if (cells[i]) cells[i] = remap[cells[i] - 1] + 1;
  // a single colour is just a black-and-white puzzle
  if (pal.length < 2 && !z.colorGame) return null;
  // MomoGram's own colour versions: only when every colour can be told apart at a glance
  if (!z.colorGame && minDistance(pal) < 70) return null;
  return { w, h, palette: pal, cells };
}

/** the clue of a line of colour cells (0 = empty, k + 1 = colour k) */
export function colorClues(line: ArrayLike<number>): ColorClue[] {
  const out: ColorClue[] = [];
  let run = 0, col = 0;
  for (let i = 0; i <= line.length; i++) {
    const v = i < line.length ? line[i] : 0;
    if (v && v === col) { run++; continue; }
    if (run) out.push({ n: run, c: col - 1 });
    run = v ? 1 : 0; col = v;
  }
  return out;
}

/**
 * Line analysis over every placement of the clue that agrees with what is known of the cells.
 * mask[i]: bit 0 = the cell may be empty, bit k + 1 = it may have colour k.
 * Returns the cells' possibilities after the line (0 for a cell: the line can't be solved), and per clue number
 * whether it has only one place left.
 */
export function colorLine(clues: ColorClue[], mask: ArrayLike<number>): { ok: boolean; out: Uint32Array; only: number[] } {
  const n = mask.length, K = clues.length;
  const out = new Uint32Array(n), only = clues.map(() => -1);
  // prefix: cells that can't be empty
  const pe = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) pe[i + 1] = pe[i] + (mask[i] & 1 ? 0 : 1);
  const emptyOk = (a: number, b: number) => pe[b] - pe[a] === 0;
  // per clue: can its block lie at [s, s + n)?
  const fits: Uint8Array[] = clues.map(({ n: c, c: col }) => {
    const f = new Uint8Array(n + 1), bit = 1 << (col + 1);
    let run = 0;
    for (let i = 0; i < n; i++) { run = mask[i] & bit ? run + 1 : 0; if (run >= c) f[i - c + 1] = 1; }
    return f;
  });
  const gap = (k: number) => (clues[k].c === clues[k + 1].c ? 1 : 0);
  if (K === 0) {
    const ok = emptyOk(0, n);
    for (let i = 0; i < n; i++) out[i] = ok ? 1 : 0;
    return { ok, out, only };
  }
  // L[k][e]: clues 0..k fit with block k ending at e (exclusive)
  const L: Uint8Array[] = clues.map(() => new Uint8Array(n + 1));
  for (let k = 0; k < K; k++) {
    const c = clues[k].n;
    for (let s = 0; s + c <= n; s++) {
      if (!fits[k][s]) continue;
      let ok = false;
      if (k === 0) ok = emptyOk(0, s);
      else for (let e = s - gap(k - 1); e >= 0 && !ok; e--) { if (!emptyOk(e, s)) break; if (L[k - 1][e]) ok = true; }
      if (ok) L[k][s + c] = 1;
    }
  }
  // R[k][s]: clues k..K-1 fit with block k starting at s
  const R: Uint8Array[] = clues.map(() => new Uint8Array(n + 1));
  for (let k = K - 1; k >= 0; k--) {
    const c = clues[k].n;
    for (let s = n - c; s >= 0; s--) {
      if (!fits[k][s]) continue;
      let ok = false;
      if (k === K - 1) ok = emptyOk(s + c, n);
      else for (let s2 = s + c + gap(k); s2 <= n && !ok; s2++) { if (!emptyOk(s + c, s2)) break; if (R[k + 1][s2]) ok = true; }
      if (ok) R[k][s] = 1;
    }
  }
  let feasible = false;
  for (let s = 0; s <= n; s++) if (R[0][s] && emptyOk(0, s)) { feasible = true; break; }
  if (!feasible) return { ok: false, out, only };
  // a block can lie at s when the clues before it end in time and the ones after it start late enough
  for (let k = 0; k < K; k++) {
    const { n: c, c: col } = clues[k];
    let count = 0, last = -1;
    for (let s = 0; s + c <= n; s++) {
      if (!R[k][s]) continue;
      let left = false;
      if (k === 0) left = emptyOk(0, s);
      else for (let e = s - gap(k - 1); e >= 0 && !left; e--) { if (!emptyOk(e, s)) break; if (L[k - 1][e]) left = true; }
      if (!left) continue;
      count++; last = s;
      for (let i = s; i < s + c; i++) out[i] |= 1 << (col + 1);
    }
    if (count === 1) only[k] = last;
  }
  // a cell can be empty when it lies between two blocks (or before the first / after the last) in some placement
  for (let i = 0; i < n; i++) {
    if (!(mask[i] & 1)) continue;
    let ok = false;
    for (let k = 0; k <= K && !ok; k++) {
      // clues 0..k-1 end at or before i, clues k.. start after i, with only empty cells in between
      let leftOk = false;
      if (k === 0) leftOk = emptyOk(0, i + 1);
      else for (let e = i; e >= 0 && !leftOk; e--) { if (!emptyOk(e, i + 1)) break; if (L[k - 1][e]) leftOk = true; }
      if (!leftOk) continue;
      if (k === K) { ok = emptyOk(i, n); continue; }
      for (let s = i + 1; s <= n && !ok; s++) { if (!emptyOk(i, s)) break; if (R[k][s]) ok = true; }
    }
    if (ok) out[i] |= 1;
  }
  return { ok: true, out, only };
}

/**
 * How many solutions a colour puzzle has: 0, 1, or 2 (two or more). Line logic first, then guesses, within a
 * step budget (the same result on every device). Returns 2 too when the budget runs out.
 */
export function colorSolutionCount(cp: ColorPuzzle, maxSteps = 20000): 0 | 1 | 2 {
  const { w, h } = cp, nCol = cp.palette.length;
  const all = (1 << (nCol + 1)) - 1;
  const rows = [...Array(h)].map((_, y) => colorClues(cp.cells.subarray(y * w, y * w + w)));
  const cols = [...Array(w)].map((_, x) => colorClues([...Array(h)].map((_, y) => cp.cells[y * w + x])));
  let steps = 0, found = 0;
  const pop = (m: number) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
  const propagate = (m: Uint32Array): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let y = 0; y < h; y++) {
        if (++steps > maxSteps) return true;
        const r = colorLine(rows[y], m.subarray(y * w, y * w + w));
        if (!r.ok) return false;
        for (let x = 0; x < w; x++) { const v = m[y * w + x] & r.out[x]; if (v !== m[y * w + x]) { if (!v) return false; m[y * w + x] = v; changed = true; } }
      }
      for (let x = 0; x < w; x++) {
        if (++steps > maxSteps) return true;
        const line = new Uint32Array(h);
        for (let y = 0; y < h; y++) line[y] = m[y * w + x];
        const r = colorLine(cols[x], line);
        if (!r.ok) return false;
        for (let y = 0; y < h; y++) { const v = m[y * w + x] & r.out[y]; if (v !== m[y * w + x]) { if (!v) return false; m[y * w + x] = v; changed = true; } }
      }
    }
    return true;
  };
  const search = (m: Uint32Array) => {
    if (found > 1 || steps > maxSteps) return;
    if (!propagate(m)) return;
    if (steps > maxSteps) return;
    let best = -1, bc = 99;
    for (let i = 0; i < m.length; i++) { const c = pop(m[i]); if (c > 1 && c < bc) { bc = c; best = i; } }
    if (best < 0) { found++; return; }
    for (let b = 0; b <= nCol && found < 2; b++) {
      if (!(m[best] & (1 << b))) continue;
      const copy = m.slice(); copy[best] = 1 << b;
      search(copy);
    }
  };
  search(new Uint32Array(w * h).fill(all));
  if (steps > maxSteps) return 2;
  return found >= 2 ? 2 : (found as 0 | 1);
}

/** readable text on a colour: black or white, whichever contrasts more */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111111' : '#ffffff';
}

/** the smallest difference between two colours of a palette (in a perceptual RGB distance) */
export function minDistance(pal: string[]): number {
  const rgb = pal.map(c => { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
  let best = Infinity;
  for (let i = 0; i < rgb.length; i++) for (let j = i + 1; j < rgb.length; j++) {
    const [r1, g1, b1] = rgb[i], [r2, g2, b2] = rgb[j], rm = (r1 + r2) / 2;
    const d = Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
    best = Math.min(best, d);
  }
  return best;
}
