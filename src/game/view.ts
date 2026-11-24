// Canvas view of a puzzle: clues pinned to the edges, zoom/pan for large grids, mouse/touch/keyboard/gamepad input.
import { bandSlots } from './mega';
import { Board, CROSS, EMPTY, FILL, MARK, Cell, blank } from './board';
import { inkOn } from './color';

export type Tool = 'fill' | 'cross' | 'mark';

export interface ViewEvents {
  onChange(result: 'ok' | 'mistake'): void;
  onStroke?(): void;
}

export interface Theme {
  bg: string; grid: string; grid5: string; cell: string; cellDither: string; fill: string; fillDither: string; trialFill: string; cross: string; mistake: string; mark?: string;
  clueBg: string; clueBgAlt: string; clue: string; clueOutline: string; clueDone: string; hl: string; cursor: string; hint: string; roulette: string; outline: string;
  // ---- shape of the board (a game's skin); left out: MomoGram's own look
  /** clue areas: fading stripes on every other line (default), full stripes (clueBg / clueBgAlt), or flat with
   *  a line every 5 like the grid */
  clueBands?: 'fade' | 'stripes' | 'flat';
  /** background of the clue areas when flat (and of every other line, if set) */
  clueArea?: string; clueAreaAlt?: string;
  /** empty cells: dithered (default), plain, or bevelled (light top left, dark bottom right) */
  cellStyle?: 'dither' | 'solid' | 'bevel';
  /** filled cells: dithered (default), plain, an inset square, bevelled, or a glossy block */
  fillStyle?: 'dither' | 'solid' | 'inset' | 'bevel' | 'gloss';
  /** light and dark edge colours for bevelled cells / filled cells */
  cellBevel?: [string, string]; fillBevel?: [string, string];
  /** distance of the cross from the cell edge, as a share of the cell */
  crossMargin?: number;
  /** the cursor line's clue background (flat clue areas) */
  clueFocusBg?: string;
  /** cross lines: width as a share of the cell, and their ends */
  crossWidth?: number; crossCap?: CanvasLineCap;
  /** guide line width every 5 cells, as a share of the cell */
  grid5Width?: number;
  /** cursor box: a single colour instead of black and white */
  cursorBox?: string;
  /** clue numbers: font weight and family */
  clueFont?: string;
}

// MomoGram's own sky-blue look: striped clue bands, dithered cells, orange 5-cell guides
const THEME: Theme = {
  bg: '#ffffff', grid: '#9fd6f2', grid5: '#f39a2c', cell: '#dff3fd', cellDither: '#cfecfb', fill: '#2b9fe0', fillDither: '#2291d2',
  trialFill: '#f0a040', cross: '#7cc4ea', mistake: '#e04040',
  clueBg: '#b5e3fa', clueBgAlt: '#b5e3fa', clue: '#1d2a36', clueOutline: '#ffffff', clueDone: '#a9b7c2',
  hl: 'rgba(255, 196, 70, 0.42)', cursor: '#f08a10', hint: '#1565e0', roulette: 'rgba(240, 140, 30, 0.5)', outline: '#1a1a1a',
};

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  board: Board;
  tool: Tool = 'fill';
  /** colour puzzles: the colour the fill tool paints with */
  color = 0;
  private ev: ViewEvents;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  // camera: cell size and scroll offset (in css px, of the grid area)
  private cell = 20;
  private fitCell = 20;
  private scrollX = 0;
  private scrollY = 0;
  private clueW = 0;
  private clueH = 0;
  private padX = 0;
  private padY = 0;
  cursorX = 0;
  cursorY = 0;
  showCursor = false;
  private mistakeFlash = new Map<number, number>();
  /** mark every wrong cell (a fill outside the picture, a ✕ on it) while this is on */
  showWrong = false;
  /** lines a tutorial points at (drawn like the cursor's row and column) */
  focus: { rows: number[]; cols: number[] } | null = null;
  // stroke state. cleared: ✕ this fill-stroke already erased, so a later pass of the same drag does not fill them
  private stroke: null | { x0: number; y0: number; axis: 0 | 1 | 2; value: Cell; erase: Cell; eraseColor: number; pointer: number; cleared: Set<number> } = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: null | { d: number; cell: number; cx: number; cy: number; sx: number; sy: number; gx?: number; gy?: number } = null;
  private raf = 0;
  private dirty = true;

  constructor(canvas: HTMLCanvasElement, board: Board, ev: ViewEvents) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.board = board;
    this.ev = ev;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    const loop = () => { this.raf = requestAnimationFrame(loop); if (this.dirty || this.mistakeFlash.size) this.draw(); };
    loop();
  }

  destroy() { cancelAnimationFrame(this.raf); }
  private theme: Theme = { ...THEME };
  /** colours of the pack's original game (null = MomoGram's own) */
  setTheme(t: Partial<Theme> | null) { this.theme = { ...THEME, ...(t ?? {}) }; this.dirty = true; }
  /** logic hints: clue numbers turn blue when their line allows a new deduction (like the 3DS / Switch games) */
  logicHints = false;
  /** only the row clues are shown (lessons about one line: the columns would give the answer away) */
  rowsOnly = false;
  private spin: { row: number; col: number; flash: boolean } | null = null;
  get spinning() { return !!this.spin; }

  /** Hint roulette: a row and a column spin, slow down and stop on the target. */
  roulette(targetRow: number, targetCol: number, onTick?: () => void): Promise<void> {
    const b = this.board;
    return new Promise(res => {
      const steps = 22 + Math.floor(Math.random() * 6);
      let k = 0;
      // start so that the last step lands on the target
      const r0 = ((targetRow - steps) % b.h + b.h * 100) % b.h, c0 = ((targetCol - steps * 3) % b.w + b.w * 100) % b.w;
      const step = () => {
        k++;
        this.spin = { row: (r0 + k) % b.h, col: (c0 + k * 3) % b.w, flash: false };
        this.dirty = true;
        onTick?.();
        if (k < steps) setTimeout(step, 35 + Math.pow(k / steps, 3) * 260);
        else {
          let f = 0;
          const blink = () => {
            f++;
            this.spin = f % 2 ? { row: targetRow, col: targetCol, flash: true } : { row: targetRow, col: targetCol, flash: false };
            this.dirty = true;
            if (f < 5) setTimeout(blink, 140); else { this.spin = null; this.dirty = true; res(); }
          };
          setTimeout(blink, 200);
        }
      };
      step();
    });
  }
  get width() { return this.cssW; }
  get height() { return this.cssH; }
  invalidate() { this.dirty = true; }

  resize(w: number, h: number) {
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.layout(true);
  }

  /** the colour behind the clues of a line (stripes alternate; the cursor's line may have a bar) */
  private clueBgOf(line: number, cue: number): string {
    const T = this.theme;
    if (line === cue && T.clueFocusBg) return T.clueFocusBg;
    if (T.clueBands === 'stripes') return line % 2 === 0 ? T.clueBg : T.clueBgAlt;
    if (T.clueBands === 'flat') return (line % 2 ? T.clueAreaAlt : undefined) ?? T.clueArea ?? T.bg;
    return line % 2 === 0 ? T.clueBg : T.bg;
  }
  private inkCache = new Map<string, string>();
  /**
   * a clue colour that stays readable on its background: numbers at least 4.5:1, greyed-out (done) numbers at
   * least 2.2:1, which some games' colours don't give on every stripe (stone-coloured stripes)
   */
  private ink(color: string, bg: string, done = false): string {
    const k = color + bg + done;
    let v = this.inkCache.get(k);
    if (!v) { v = readable(color, bg, done ? 2.2 : 4.5); this.inkCache.set(k, v); }
    return v;
  }

  private maxClues() {
    const b = this.board;
    // a pair of lines (Mega) needs one place per slot of its clue
    const len = (band: ReturnType<Board['rowBand']>, c: number[], wide: boolean) => (band ? Math.ceil(slotUnits(bandSlots(band), wide).total) : c.length);
    return { r: Math.max(1, ...b.rowClues.map((c, y) => len(b.rowBand(y), c, true))), c: this.rowsOnly ? 0 : Math.max(1, ...b.colClues.map((c, x) => len(b.colBand(x), c, false))) };
  }

  /** Fit the whole puzzle; on small screens the cell size is clamped and the view becomes pannable. */
  private layout(reset: boolean) {
    const { r, c } = this.maxClues();
    const b = this.board;
    // clue numbers are ~0.62 (wide) / 0.66 (tall) of a cell, but never larger than 26 px each
    // leave room for the outer frame
    const W = this.cssW - 10, H = this.cssH - 10;
    let fit = Math.min(W / (b.w + r * 0.62 + 0.3), H / (b.h + c * 0.66 + 0.3));
    // capped clue numbers: their width plus the gap to the grid and the frame (about 24 px) are fixed
    if (fit * 0.62 > 26) fit = Math.min((W - r * 26 - 24) / b.w, (H - c * 28 - 24) / b.h);
    this.fitCell = Math.max(6, Math.floor(fit));
    if (reset) this.cell = this.fitCell;
    this.updateClueArea();
    this.clampScroll();
    this.dirty = true;
    this.onLayout?.();
  }

  /** Height the whole puzzle needs when it is fitted to `width` (portrait layout gives the rest to the top screen). */
  naturalHeight(width: number): number {
    const { r, c } = this.maxClues();
    const b = this.board;
    let fit = width / (b.w + r * 0.62 + 0.3);
    if (fit * 0.62 > 26) fit = (width - r * 26 - 8) / b.w;
    const cell = Math.max(6, Math.floor(fit));
    const cc = Math.max(cell, 14);
    const clueH = Math.ceil(c * Math.min(cc * 0.66, 28) + Math.min(cc * 0.3, 10));
    return clueH + b.h * cell + 6;
  }

  private updateClueArea() {
    const { r, c } = this.maxClues();
    const cc = Math.max(this.cell, 14);
    const gap = Math.max(2, cc / 10) + Math.max(4, Math.min(cc * 0.22, 9)) + 4;
    this.clueW = Math.ceil(r * Math.min(cc * 0.62, 26) + gap);
    this.clueH = this.rowsOnly ? 4 : Math.ceil(c * Math.min(cc * 0.66, 28) + gap);
  }

  get zoomed() { return this.cell > this.fitCell + 0.5; }

  /** the clue corner (top-left), where the tool pad sits */
  cornerRect() { return { x: this.padX, y: this.padY, w: this.clueW, h: this.clueH }; }
  /** visible part of the grid, in cells (for the zoom frame on the top screen) */
  visibleCells() {
    const b = this.board, cs = this.cell;
    const vw = this.cssW - this.padX * 2 - this.clueW, vh = this.cssH - this.padY * 2 - this.clueH;
    return { x: Math.max(0, this.scrollX / cs), y: Math.max(0, this.scrollY / cs), w: Math.min(b.w, vw / cs), h: Math.min(b.h, vh / cs) };
  }
  onLayout: (() => void) | null = null;
  /** length of the current drag, shown in a bubble */
  private dragLen = 0;
  private dragAt: { x: number; y: number } | null = null;

  setZoom(cell: number, cx = this.cssW / 2, cy = this.cssH / 2) {
    const old = this.cell;
    const nc = Math.max(this.fitCell, Math.min(64, cell));
    // keep the grid point under (cx,cy) fixed
    const gx = (cx - this.padX - this.clueW + this.scrollX) / old, gy = (cy - this.padY - this.clueH + this.scrollY) / old;
    this.cell = nc;
    this.updateClueArea();
    this.clampScroll();
    this.scrollX = gx * nc - (cx - this.padX - this.clueW);
    this.scrollY = gy * nc - (cy - this.padY - this.clueH);
    this.clampScroll();
    this.dirty = true;
  }

  /** move the zoomed view (zoom button held and moved like a joystick) */
  panBy(dx: number, dy: number) {
    this.scrollX += dx; this.scrollY += dy;
    this.clampScroll();
    this.dirty = true;
  }

  toggleZoom() {
    if (this.zoomed) this.setZoom(this.fitCell);
    else {
      const target = Math.max(28, this.fitCell * 2);
      const cx = this.padX + this.clueW + (this.cursorX + 0.5) * this.cell - this.scrollX;
      const cy = this.padY + this.clueH + (this.cursorY + 0.5) * this.cell - this.scrollY;
      this.setZoom(target, cx, cy);
    }
  }

  private clampScroll() {
    const b = this.board;
    const maxX = Math.max(0, b.w * this.cell - (this.cssW - this.clueW));
    const maxY = Math.max(0, b.h * this.cell - (this.cssH - this.clueH));
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
    // centre the whole puzzle (clues + grid) when it is smaller than the view
    this.padX = Math.max(0, Math.floor((this.cssW - this.clueW - b.w * this.cell) / 2));
    // horizontally centred; vertically close to the top screen (thumb reach on phones), centred on wide screens
    const freeY = Math.max(0, this.cssH - this.clueH - b.h * this.cell);
    this.padY = Math.floor(freeY / 2);
    this.onLayout?.();
  }

  private ensureVisible(x: number, y: number) {
    const gx = x * this.cell - this.scrollX, gy = y * this.cell - this.scrollY;
    const vw = this.cssW - this.clueW, vh = this.cssH - this.clueH;
    if (gx < 0) this.scrollX += gx;
    if (gx + this.cell > vw) this.scrollX += gx + this.cell - vw;
    if (gy < 0) this.scrollY += gy;
    if (gy + this.cell > vh) this.scrollY += gy + this.cell - vh;
    this.clampScroll();
  }

  private cellAt(px: number, py: number): { x: number; y: number } | null {
    px -= this.padX; py -= this.padY;
    const gx = px - this.clueW + this.scrollX, gy = py - this.clueH + this.scrollY;
    if (px < this.clueW || py < this.clueH) return null;
    const x = Math.floor(gx / this.cell), y = Math.floor(gy / this.cell);
    if (x < 0 || y < 0 || x >= this.board.w || y >= this.board.h) return null;
    return { x, y };
  }

  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    if (this.showWrong) { this.showWrong = false; this.dirty = true; } // one look at the mistakes, then the next touch plays normally
    if (this.spin) return; // no marks while the hint roulette spins
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      // second finger: cancel the stroke, start pinch / pan
      if (this.stroke) { this.board.undo(); this.stroke = null; this.dirty = true; }
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      // the grid point between the fingers stays between them while they move apart, together or around
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cell: this.cell, cx, cy, sx: this.scrollX, sy: this.scrollY,
        gx: (cx - this.padX - this.clueW + this.scrollX) / this.cell, gy: (cy - this.padY - this.clueH + this.scrollY) / this.cell };
      return;
    }
    if (this.pointers.size > 2) return;
    // middle mouse: pan
    if (e.button === 1) { this.pinch = { d: 0, cell: this.cell, cx: p.x, cy: p.y, sx: this.scrollX, sy: this.scrollY }; return; }
    const c = this.cellAt(p.x, p.y);
    // zoomed in: dragging on the clues or beside the grid moves the view (one finger / left mouse button)
    if (!c) { if (this.zoomed) this.pinch = { d: 0, cell: this.cell, cx: p.x, cy: p.y, sx: this.scrollX, sy: this.scrollY }; return; }
    this.showCursor = false;
    const tool: Tool = e.button === 2 ? (this.tool === 'fill' ? 'cross' : 'fill') : this.tool;
    const cur = this.board.at(c.x, c.y);
    const value = this.valueAt(tool, c.x, c.y);
    if (value === null) return;
    this.board.pushUndo();
    this.stroke = { x0: c.x, y0: c.y, axis: 0, value, erase: cur, eraseColor: this.board.colorAt(c.x, c.y), pointer: e.pointerId, cleared: new Set() };
    this.cursorX = c.x; this.cursorY = c.y;
    this.paint(c.x, c.y);
    e.preventDefault();
  }

  private move(e: PointerEvent) {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch) {
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        // stepless: the cell size follows the finger distance exactly
        this.cell = Math.max(this.fitCell, Math.min(64, this.pinch.cell * (d / Math.max(1, this.pinch.d))));
        this.updateClueArea();
        this.scrollX = (this.pinch.gx ?? 0) * this.cell - (cx - this.padX - this.clueW);
        this.scrollY = (this.pinch.gy ?? 0) * this.cell - (cy - this.padY - this.clueH);
        this.clampScroll();
        this.dirty = true;
      } else {
        this.scrollX = this.pinch.sx - (p.x - this.pinch.cx);
        this.scrollY = this.pinch.sy - (p.y - this.pinch.cy);
        this.clampScroll();
        this.dirty = true;
      }
      return;
    }
    const s = this.stroke;
    if (!s || s.pointer !== e.pointerId) return;
    const c = this.cellAt(Math.max(this.padX + this.clueW + 1, p.x), Math.max(this.padY + this.clueH + 1, p.y));
    if (!c) return;
    // lock to the row or column of the first movement
    if (s.axis === 0 && (c.x !== s.x0 || c.y !== s.y0)) s.axis = Math.abs(c.x - s.x0) >= Math.abs(c.y - s.y0) ? 1 : 2;
    let tx = c.x, ty = c.y;
    if (s.axis === 1) ty = s.y0; else if (s.axis === 2) tx = s.x0;
    // fill every cell between the start and the pointer
    const [a, b] = s.axis === 1 ? [s.x0, tx] : [s.y0, ty];
    const step = a <= b ? 1 : -1;
    for (let i = a; i !== b + step; i += step) {
      if (s.axis === 1) this.paint(i, s.y0); else this.paint(s.x0, i);
    }
    this.cursorX = tx; this.cursorY = ty;
    if (this.zoomed) this.ensureVisible(tx, ty); // follow a stroke that leaves the visible part
    this.dragLen = Math.abs(b - a) + 1;
    // filling: count the whole block in this line the stroke is part of (filled cells already next to it too)
    if (s.value === FILL && this.stroke) {
      const col = (i: number) => s.axis === 1 ? this.board.colorAt(i, s.y0) : this.board.colorAt(s.x0, i);
      const at0 = (i: number) => s.axis === 1 ? this.board.at(i, s.y0) : this.board.at(s.x0, i);
      // colour puzzles: only cells of the same colour belong to the block
      const at = (i: number) => (at0(i) === FILL && (!this.board.color || col(i) === this.color) ? FILL : EMPTY);
      const n = s.axis === 1 ? this.board.w : this.board.h;
      let lo = Math.min(a, b), hi = Math.max(a, b);
      if ([...Array(hi - lo + 1)].every((_, k) => at(lo + k) === FILL)) {
        while (lo > 0 && at(lo - 1) === FILL) lo--;
        while (hi < n - 1 && at(hi + 1) === FILL) hi++;
        this.dragLen = hi - lo + 1;
      }
    }
    this.dragAt = { x: p.x, y: p.y };
    this.dirty = true;
  }

  private up(e: PointerEvent) {
    if (this.dragAt) { this.dragAt = null; this.dragLen = 0; this.dirty = true; }
    this.pointers.delete(e.pointerId);
    // pinch ended with one finger still down: keep moving the view with it
    if (this.pointers.size === 1 && this.pinch && this.pinch.d) {
      const q = [...this.pointers.values()][0];
      this.pinch = { d: 0, cell: this.cell, cx: q.x, cy: q.y, sx: this.scrollX, sy: this.scrollY };
    } else if (this.pointers.size < 2 && this.pinch && this.pinch.d) this.pinch = null;
    if (this.pinch && !this.pinch.d && this.pointers.size === 0) this.pinch = null;
    if (this.stroke && this.stroke.pointer === e.pointerId) { this.stroke = null; this.ev.onStroke?.(); }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const p = { x: e.offsetX, y: e.offsetY };
    // Ctrl + wheel / trackpad pinch zooms; when zoomed in the wheel scrolls (Shift = sideways), otherwise it zooms in
    if (e.ctrlKey || !this.zoomed) this.setZoom(this.cell * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y);
    else {
      if (e.shiftKey) this.scrollX += e.deltaY || e.deltaX;
      else { this.scrollX += e.deltaX; this.scrollY += e.deltaY; }
      this.clampScroll(); this.dirty = true;
    }
  }

  private paint(x: number, y: number) {
    const s = this.stroke;
    const cur = this.board.at(x, y);
    // filling: a ✕ under the stroke is cleared, not filled. The same drag must not fill it on the next pass.
    if (s && s.value === FILL) {
      const i = y * this.board.w + x;
      if (s.cleared.has(i)) return;
      if (cur === CROSS) {
        s.cleared.add(i);
        const r = this.board.set(x, y, EMPTY, this.color);
        if (r === 'nochange') return;
        this.dirty = true;
        this.ev.onChange(r);
        return;
      }
    }
    // a stroke only changes cells that are empty (when marking) or carry the same mark (when erasing)
    if (s) {
      // fills and crosses go over marks; marks only onto empty cells
      // colour: the first cell may be painted over in another colour (a tap recolours a cell)
      const recolor = this.board.color && s.value === FILL && cur === FILL && x === s.x0 && y === s.y0;
      if (!recolor && (s.value === MARK ? cur !== EMPTY : s.value !== EMPTY && !blank(cur))) return;
      if (s.value === EMPTY && cur !== s.erase) return;
      if (s.value === EMPTY && this.board.color && cur === FILL && this.board.colorAt(x, y) !== s.eraseColor) return;
    }
    const r = this.board.set(x, y, s ? s.value : FILL, this.color);
    if (r === 'nochange') return;
    if (r === 'mistake') {
      this.mistakeFlash.set(y * this.board.w + x, performance.now());
      // a caught mistake ends the stroke
      this.stroke = null;
    }
    this.dirty = true;
    this.ev.onChange(r);
  }

  // keyboard / gamepad
  moveCursor(dx: number, dy: number, painting: Cell | null) {
    this.showCursor = true;
    this.cursorX = Math.max(0, Math.min(this.board.w - 1, this.cursorX + dx));
    this.cursorY = Math.max(0, Math.min(this.board.h - 1, this.cursorY + dy));
    if (painting !== null) this.applyAtCursor(painting, true);
    if (this.zoomed) this.ensureVisible(this.cursorX, this.cursorY);
    this.dirty = true;
  }

  /** Press A/B: like a tap with that tool. Holding and moving continues with the same value. */
  pressAtCursor(tool: Tool): Cell {
    if (this.showWrong) { this.showWrong = false; this.dirty = true; }
    if (this.spin) return EMPTY;
    this.showCursor = true;
    const value = this.valueAt(tool, this.cursorX, this.cursorY);
    if (value === null) return EMPTY;
    this.board.pushUndo();
    this.applyAtCursor(value, false);
    return value;
  }

  /** what a tap does here: like valueFor, but in colour puzzles a fill of another colour is painted over */
  private valueAt(tool: Tool, x: number, y: number): Cell | null {
    const cur = this.board.at(x, y);
    if (this.board.color && tool === 'fill' && cur === FILL && this.board.colorAt(x, y) !== this.color) return FILL;
    return valueFor(tool, cur);
  }

  private applyAtCursor(value: Cell, continuing: boolean) {
    const cur = this.board.at(this.cursorX, this.cursorY);
    // holding fill over a ✕ only clears it; the next press fills the empty cell
    if (continuing && value === FILL && cur === CROSS) {
      const r = this.board.set(this.cursorX, this.cursorY, EMPTY, this.color);
      if (r !== 'nochange') { this.dirty = true; this.ev.onChange(r); }
      return;
    }
    if (continuing && (value === MARK ? cur !== EMPTY : value !== EMPTY && !blank(cur))) return;
    if (continuing && value === EMPTY && cur === EMPTY) return;
    const r = this.board.set(this.cursorX, this.cursorY, value, this.color);
    if (r === 'mistake') this.mistakeFlash.set(this.cursorY * this.board.w + this.cursorX, performance.now());
    if (r !== 'nochange') { this.dirty = true; this.ev.onChange(r); }
  }

  // dither patterns, rebuilt when colours or the pixel size change
  private pats = new Map<string, CanvasPattern | string>();
  private dither(a: string, b: string, px: number): CanvasPattern | string {
    const key = a + b + px;
    let p = this.pats.get(key);
    if (!p) {
      const c = document.createElement('canvas');
      c.width = c.height = px * 2;
      const g = c.getContext('2d')!;
      g.fillStyle = a; g.fillRect(0, 0, px * 2, px * 2);
      g.fillStyle = b; g.fillRect(0, 0, px, px); g.fillRect(px, px, px, px);
      p = this.ctx.createPattern(c, 'repeat') ?? a;
      if (this.pats.size > 40) this.pats.clear();
      this.pats.set(key, p);
    }
    return p;
  }

  draw() {
    this.dirty = false;
    const ctx = this.ctx, b = this.board, T = this.theme, cs = this.cell, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.translate(this.padX, this.padY);
    const viewW = this.cssW - this.padX * 2, viewH = this.cssH - this.padY * 2;
    const ox = this.clueW - this.scrollX, oy = this.clueH - this.scrollY;
    const vx0 = Math.max(0, Math.floor(this.scrollX / cs)), vy0 = Math.max(0, Math.floor(this.scrollY / cs));
    const vx1 = Math.min(b.w, Math.ceil((this.scrollX + viewW - this.clueW) / cs));
    const vy1 = Math.min(b.h, Math.ceil((this.scrollY + viewH - this.clueH) / cs));
    const gw = Math.min(b.w * cs, viewW - this.clueW), gh = Math.min(b.h * cs, viewH - this.clueH);
    // dither dot size in device pixels: a fine texture
    const dp = Math.max(1, Math.round(cs * dpr / 14));
    const pat = (a: string, c: string) => { const p = this.dither(a, c, dp); if (typeof p !== 'string') p.setTransform(new DOMMatrix().scale(1 / dpr)); return p; };
    const now = performance.now();
    // the row and column being drawn in (or where the cursor is) are marked, clues included
    const cue = this.showCursor || this.spin || this.stroke;
    const cueX = cue ? (this.spin ? this.spin.col : this.cursorX) : -1;
    const cueY = cue ? (this.spin ? this.spin.row : this.cursorY) : -1;

    // ---- clue areas: flat (with a line every 5, like the grid) or alternating stripes that fade out
    if (T.clueBands === 'flat' || T.clueBands === 'stripes') {
      ctx.fillStyle = T.clueArea ?? T.bg;
      ctx.fillRect(0, this.clueH, this.clueW, gh); ctx.fillRect(this.clueW, 0, gw, this.clueH);
      const alt = T.clueBands === 'stripes' ? T.clueBgAlt : T.clueAreaAlt;
      const first = T.clueBands === 'stripes' ? T.clueBg : null;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW, gh); ctx.rect(this.clueW, 0, gw, this.clueH); ctx.clip();
      for (let y = vy0; y < vy1; y++) { const c = y % 2 === 0 ? first : alt; if (c) { ctx.fillStyle = c; ctx.fillRect(0, oy + y * cs, this.clueW, cs); } }
      for (let x = vx0; x < vx1; x++) { const c = x % 2 === 0 ? first : alt; if (c) { ctx.fillStyle = c; ctx.fillRect(ox + x * cs, 0, cs, this.clueH); } }
      ctx.restore();
      if (cueY >= 0 && T.clueFocusBg) { ctx.fillStyle = T.clueFocusBg; ctx.fillRect(0, oy + cueY * cs, this.clueW, cs); }
      if (cueX >= 0 && T.clueFocusBg) { ctx.fillStyle = T.clueFocusBg; ctx.fillRect(ox + cueX * cs, 0, cs, this.clueH); }
      ctx.save();
      ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW, gh); ctx.rect(this.clueW, 0, gw, this.clueH); ctx.clip();
      if (T.clueBands === 'stripes') ctx.globalAlpha = 0; // stripes: no lines in the clues
      ctx.fillStyle = T.grid;
      for (let y = vy0; y <= vy1; y++) ctx.fillRect(0, Math.round(oy + y * cs) - 0.5, this.clueW, 1);
      for (let x = vx0; x <= vx1; x++) ctx.fillRect(Math.round(ox + x * cs) - 0.5, 0, 1, this.clueH);
      ctx.fillStyle = T.grid5;
      const w5 = Math.max(1.5, cs * (T.grid5Width ?? 1 / 12));
      for (let y = vy0; y <= vy1; y++) if (y % 5 === 0 && y > 0 && y < b.h) ctx.fillRect(0, oy + y * cs - w5 / 2, this.clueW, w5);
      for (let x = vx0; x <= vx1; x++) if (x % 5 === 0 && x > 0 && x < b.w) ctx.fillRect(ox + x * cs - w5 / 2, 0, w5, this.clueH);
      ctx.restore();
    }
    const bandH = ctx.createLinearGradient(0, 0, this.clueW, 0);
    bandH.addColorStop(0, T.clueBg + '00'); bandH.addColorStop(0.45, T.clueBg); bandH.addColorStop(1, T.clueBg);
    const bandV = ctx.createLinearGradient(0, 0, 0, this.clueH);
    bandV.addColorStop(0, T.clueBg + '00'); bandV.addColorStop(0.45, T.clueBg); bandV.addColorStop(1, T.clueBg);
    if (!T.clueBands || T.clueBands === 'fade') {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW, gh); ctx.clip();
      for (let y = vy0; y < vy1; y++) if (y % 2 === 0) { ctx.fillStyle = bandH; ctx.fillRect(0, oy + y * cs, this.clueW, cs); }
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.rect(this.clueW, 0, gw, this.clueH); ctx.clip();
      for (let x = vx0; x < vx1; x++) if (x % 2 === 0) { ctx.fillStyle = bandV; ctx.fillRect(ox + x * cs, 0, cs, this.clueH); }
      ctx.restore();
    }

    // ---- cells
    ctx.save();
    ctx.beginPath(); ctx.rect(this.clueW, this.clueH, gw, gh); ctx.clip();
    ctx.fillStyle = T.cellStyle && T.cellStyle !== 'dither' ? T.cell : pat(T.cell, T.cellDither);
    ctx.fillRect(ox + vx0 * cs, oy + vy0 * cs, (vx1 - vx0) * cs, (vy1 - vy0) * cs);
    const fillPat = !T.fillStyle || T.fillStyle === 'dither' ? pat(T.fill, T.fillDither) : T.fill, trialPat = pat(T.trialFill, T.trialFill);
    const edge = Math.max(1, cs / 9);
    /** light top and left edge, dark bottom and right edge */
    const bevel = (px: number, py: number, [lt, dk]: [string, string], inset = 0) => {
      const a = px + inset, b2 = py + inset, w = cs - inset * 2;
      ctx.fillStyle = lt; ctx.fillRect(a, b2, w, edge); ctx.fillRect(a, b2, edge, w);
      ctx.fillStyle = dk; ctx.fillRect(a, b2 + w - edge, w, edge); ctx.fillRect(a + w - edge, b2, edge, w);
    };
    for (let y = vy0; y < vy1; y++) for (let x = vx0; x < vx1; x++) {
      const v = b.at(x, y), px = ox + x * cs, py = oy + y * cs, i = y * b.w + x;
      const trial = b.isTrialCell(x, y);
      if (v !== FILL && T.cellStyle === 'bevel' && T.cellBevel) bevel(px, py, T.cellBevel);
      if (v === FILL && b.color) {
        // colour puzzles: the cell in its colour, a soft light edge; trial cells with a dashed frame
        const c = b.color.palette[b.colorAt(x, y)] ?? T.fill;
        ctx.fillStyle = c; ctx.fillRect(px, py, cs, cs);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'; ctx.fillRect(px, py, cs, Math.max(1, cs / 10)); ctx.fillRect(px, py, Math.max(1, cs / 10), cs);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.16)'; ctx.fillRect(px, py + cs - Math.max(1, cs / 10), cs, Math.max(1, cs / 10)); ctx.fillRect(px + cs - Math.max(1, cs / 10), py, Math.max(1, cs / 10), cs);
        if (trial) { ctx.save(); ctx.strokeStyle = inkOn(c); ctx.setLineDash([cs / 6, cs / 8]); ctx.lineWidth = Math.max(1, cs / 14); ctx.strokeRect(px + cs * 0.15, py + cs * 0.15, cs * 0.7, cs * 0.7); ctx.restore(); }
      } else if (v === FILL) {
        const col = trial ? T.trialFill : T.fill;
        if (T.fillStyle === 'inset') {
          // a square inside the cell, like the Game Boy games
          const m = Math.max(1, Math.round(cs * 0.12));
          ctx.fillStyle = col; ctx.fillRect(px + m, py + m, cs - 2 * m, cs - 2 * m);
        } else if (T.fillStyle === 'bevel') {
          ctx.fillStyle = col; ctx.fillRect(px, py, cs, cs);
          if (!trial && T.fillBevel) bevel(px, py, T.fillBevel);
        } else if (T.fillStyle === 'gloss') {
          // a shiny block: lighter at the top, darker at the bottom (the "ds" board design)
          const g = ctx.createLinearGradient(0, py, 0, py + cs);
          const [lt, dk] = trial ? [T.trialFill, T.trialFill] : T.fillBevel ?? [T.fill, T.fillDither];
          g.addColorStop(0, lt); g.addColorStop(0.45, col); g.addColorStop(1, dk);
          ctx.fillStyle = g; ctx.fillRect(px, py, cs, cs);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'; ctx.fillRect(px + cs * 0.12, py + cs * 0.1, cs * 0.76, Math.max(1, cs * 0.12));
        } else {
          ctx.fillStyle = trial ? trialPat : fillPat;
          ctx.fillRect(px, py, cs, cs);
        }
      } else if (v === MARK) {
        // the player's own note: a soft dot that the picture can't be mistaken for
        const m = cs * 0.27;
        ctx.fillStyle = T.mark ?? '#a874d8';
        ctx.beginPath(); ctx.roundRect(px + m, py + m, cs - 2 * m, cs - 2 * m, cs * 0.12); ctx.fill();
      } else if (v === CROSS) {
        const t = this.mistakeFlash.get(i);
        let col = trial ? T.trialFill : T.cross;
        if (t !== undefined) { if (now - t > 1200) this.mistakeFlash.delete(i); else col = T.mistake; }
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.5, cs * (T.crossWidth ?? 1 / 7));
        ctx.lineCap = T.crossCap ?? 'round';
        const m = cs * (T.crossMargin ?? 0.24);
        ctx.beginPath();
        ctx.moveTo(px + m, py + m); ctx.lineTo(px + cs - m, py + cs - m);
        ctx.moveTo(px + cs - m, py + m); ctx.lineTo(px + m, py + cs - m);
        ctx.stroke();
      }
    }
    // thin cell lines, then the orange guide lines every 5 cells
    ctx.fillStyle = T.grid;
    for (let x = vx0; x <= vx1; x++) ctx.fillRect(Math.round(ox + x * cs) - 0.5, oy + vy0 * cs, 1, (vy1 - vy0) * cs);
    for (let y = vy0; y <= vy1; y++) ctx.fillRect(ox + vx0 * cs, Math.round(oy + y * cs) - 0.5, (vx1 - vx0) * cs, 1);
    ctx.fillStyle = T.grid5;
    const g5 = Math.max(1.5, cs * (T.grid5Width ?? 1 / 12));
    for (let x = vx0; x <= vx1; x++) if (x % 5 === 0 && x > 0 && x < b.w) ctx.fillRect(ox + x * cs - g5 / 2, oy + vy0 * cs, g5, (vy1 - vy0) * cs);
    for (let y = vy0; y <= vy1; y++) if (y % 5 === 0 && y > 0 && y < b.h) ctx.fillRect(ox + vx0 * cs, oy + y * cs - g5 / 2, (vx1 - vx0) * cs, g5);
    if (this.showWrong) {
      ctx.save();
      ctx.strokeStyle = T.mistake; ctx.lineWidth = Math.max(2, cs / 8);
      for (let y = vy0; y < vy1; y++) for (let x = vx0; x < vx1; x++) {
        const i = y * b.w + x, v = b.cells[i];
        if ((v === FILL && !b.solution[i]) || (v === CROSS && b.solution[i])) {
          ctx.fillStyle = T.mistake; ctx.globalAlpha = 0.4; ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
          ctx.globalAlpha = 1;
          // a light ring, then the error colour: still visible when the theme itself is red
          const inset = Math.max(1.5, cs / 10);
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, cs / 8);
          ctx.strokeRect(ox + x * cs + 1, oy + y * cs + 1, cs - 2, cs - 2);
          ctx.strokeStyle = T.mistake; ctx.lineWidth = Math.max(2, cs / 12);
          ctx.strokeRect(ox + x * cs + inset, oy + y * cs + inset, cs - 2 * inset, cs - 2 * inset);
        }
      }
      ctx.restore();
    }
    if (this.focus) {
      ctx.fillStyle = 'rgba(255, 170, 40, 0.30)';
      for (const y of this.focus.rows) { ctx.fillRect(ox, oy + y * cs, b.w * cs, cs); ctx.fillRect(0, oy + y * cs, this.clueW, cs); }
      for (const x of this.focus.cols) { ctx.fillRect(ox + x * cs, oy, cs, b.h * cs); ctx.fillRect(ox + x * cs, 0, cs, this.clueH); }
    }
    // roulette / cursor beams over the grid
    if (cueY >= 0) {
      ctx.fillStyle = this.spin?.flash ? 'rgba(255, 200, 60, 0.7)' : this.spin ? T.roulette : T.hl;
      ctx.fillRect(ox, oy + cueY * cs, b.w * cs, cs);
      ctx.fillRect(ox + cueX * cs, oy, cs, b.h * cs);
    }
    if (this.showCursor && !this.spin) {
      // black-and-white cursor box
      const x = ox + this.cursorX * cs, y = oy + this.cursorY * cs, lw = Math.max(2, cs / 9);
      if (T.cursorBox) { ctx.lineWidth = lw * 1.4; ctx.strokeStyle = T.cursorBox; ctx.strokeRect(x + lw * 0.7, y + lw * 0.7, cs - lw * 1.4, cs - lw * 1.4); }
      else {
        ctx.lineWidth = lw * 2; ctx.strokeStyle = '#fff'; ctx.strokeRect(x + lw, y + lw, cs - lw * 2, cs - lw * 2);
        ctx.lineWidth = lw; ctx.strokeStyle = T.outline; ctx.strokeRect(x + lw / 2, y + lw / 2, cs - lw, cs - lw);
      }
    }
    ctx.restore();
    // outer frame
    ctx.strokeStyle = T.outline;
    ctx.lineWidth = Math.max(2, cs / 10);
    ctx.strokeRect(this.clueW - ctx.lineWidth / 2 + Math.min(0, ox - this.clueW), this.clueH - ctx.lineWidth / 2 + Math.min(0, oy - this.clueH),
      b.w * cs + ctx.lineWidth, b.h * cs + ctx.lineWidth);
    // the frame may run under the clues when scrolled: repaint the clue areas' backgrounds where needed
    // (clues are drawn on top below)

    // ---- clue numbers: plain, tabular digits with a clear gap to the grid frame
    const fs = Math.max(9, Math.min(cs * 0.6, 25));
    ctx.font = `${T.clueFont ?? '600'} ${fs}px "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const frameW = Math.max(2, cs / 10);
    const gap = frameW + Math.max(4, Math.min(cs * 0.22, 9));
    const text = (str: string, x: number, y: number, col: string) => { ctx.fillStyle = col; ctx.fillText(str, x, y); };
    /** a colour clue number: a chip in the block's colour (faded when done, ringed on the cursor's line) */
    const chip = (str: string, x: number, y: number, ci: number, done: boolean, cur: boolean, blue: boolean, wide: number, tall: number) => {
      const c = b.color!.palette[ci] ?? '#000';
      ctx.save();
      ctx.globalAlpha = done ? 0.28 : 1;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.roundRect(x - wide / 2, y - tall / 2, wide, tall, Math.min(wide, tall) * 0.25); ctx.fill();
      if (cur || blue) { ctx.globalAlpha = 1; ctx.strokeStyle = cur ? T.cursor : T.hint; ctx.lineWidth = Math.max(1.5, cs / 12); ctx.stroke(); }
      ctx.globalAlpha = done ? 0.55 : 1;
      ctx.fillStyle = inkOn(c); ctx.fillText(str, x, y + 1);
      ctx.restore();
    };
    const cc = Math.max(cs, 14);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.clueW, 0, viewW - this.clueW, this.clueH - frameW); ctx.clip();
    if (cueX >= 0 && (this.spin || !T.clueFocusBg)) { ctx.fillStyle = this.spin ? T.roulette : T.hl; ctx.fillRect(ox + cueX * cs, 0, cs, this.clueH); }
    const stepV = Math.min(cc * 0.66, 28, fs * 1.15);
    // a mega number: drawn over both lines of its pair, in a rounded box
    const megaBox = (cx: number, cy: number, bw: number, bh: number, n: number, col: string) => {
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, cs / 14);
      ctx.fillStyle = T.clueArea ?? T.bg; ctx.globalAlpha = 0.9;
      const r = Math.min(bw, bh) * 0.28;
      ctx.beginPath(); ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, r); ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      ctx.restore();
      text(String(n), cx, cy + 1, col);
    };
    for (let x = vx0; x < (this.rowsOnly ? vx0 : vx1); x++) {
      const band = b.colBand(x);
      if (band) {
        if (b.colPair[x] !== x && x !== vx0) continue; // drawn with the pair's first column
        const x0 = b.colPair[x], done = b.colDone(x0)[0] ?? true, blue = this.logicHints && b.colCanProgress(x0);
        const col = this.ink(done ? T.clueDone : x0 === cueX || x0 + 1 === cueX ? T.cursor : blue ? T.hint : T.clue, this.clueBgOf(x0, cueX), done);
        const slots = bandSlots(band);
        slots.forEach((sl, k) => {
          const y = this.clueH - gap - (slots.length - k - 0.5) * stepV + 1;
          if (sl.m !== undefined) megaBox(ox + (x0 + 1) * cs, y, cs * 1.7, stepV * 0.95, sl.m, col);
          if (sl.a !== undefined) text(String(sl.a), ox + x0 * cs + cs / 2, y, col);
          if (sl.b !== undefined) text(String(sl.b), ox + (x0 + 1) * cs + cs / 2, y, col);
        });
        if (!slots.length) text('0', ox + (x0 + 1) * cs, this.clueH - gap - stepV / 2 + 1, col);
        continue;
      }
      const clues = b.colClues[x], done = b.colDone(x), blue = this.logicHints && b.colCanProgress(x);
      if (b.color) {
        const cl = b.colColorClues[x];
        cl.forEach((q, k) => chip(String(q.n), ox + x * cs + cs / 2, this.clueH - gap - (cl.length - k - 0.5) * stepV + 1, q.c, !!done[k], x === cueX, blue, cs * 0.86, stepV * 0.9));
        if (!cl.length) text('0', ox + x * cs + cs / 2, this.clueH - gap - stepV / 2 + 1, T.clueDone);
        continue;
      }
      for (let k = 0; k < clues.length; k++) {
        const col = this.ink(done[k] ? T.clueDone : x === cueX ? T.cursor : blue ? T.hint : T.clue, this.clueBgOf(x, cueX), done[k]);
        text(String(clues[k] || 0), ox + x * cs + cs / 2, this.clueH - gap - (clues.length - k - 0.5) * stepV + 1, col);
      }
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW - frameW, viewH - this.clueH); ctx.clip();
    if (cueY >= 0 && (this.spin || !T.clueFocusBg)) { ctx.fillStyle = this.spin ? T.roulette : T.hl; ctx.fillRect(0, oy + cueY * cs, this.clueW, cs); }
    const stepH = Math.min(cc * 0.62, 26, fs * 1.05);
    for (let y = vy0; y < vy1; y++) {
      const band = b.rowBand(y);
      if (band) {
        if (b.rowPair[y] !== y && y !== vy0) continue;
        const y0 = b.rowPair[y], done = b.rowDone(y0)[0] ?? true, blue = this.logicHints && b.rowCanProgress(y0);
        const col = this.ink(done ? T.clueDone : y0 === cueY || y0 + 1 === cueY ? T.cursor : blue ? T.hint : T.clue, this.clueBgOf(y0, cueY), done);
        const slots = bandSlots(band), u = slotUnits(slots, true);
        slots.forEach((sl, k) => {
          // two-digit mega numbers get a wider place (they stand side by side in a row clue)
          const x = this.clueW - gap - (u.total - u.start[k] - u.size[k] / 2) * stepH;
          if (sl.m !== undefined) megaBox(x, oy + (y0 + 1) * cs, stepH * (u.size[k] - 0.05), cs * 1.7, sl.m, col);
          if (sl.a !== undefined) text(String(sl.a), x, oy + y0 * cs + cs / 2 + 1, col);
          if (sl.b !== undefined) text(String(sl.b), x, oy + (y0 + 1) * cs + cs / 2 + 1, col);
        });
        if (!slots.length) text('0', this.clueW - gap - stepH / 2, oy + (y0 + 1) * cs + 1, col);
        continue;
      }
      const clues = b.rowClues[y], done = b.rowDone(y), blue = this.logicHints && b.rowCanProgress(y);
      if (b.color) {
        const cl = b.rowColorClues[y];
        cl.forEach((q, k) => chip(String(q.n), this.clueW - gap - (cl.length - k - 0.5) * stepH, oy + y * cs + cs / 2, q.c, !!done[k], y === cueY, blue, stepH * 0.92, cs * 0.86));
        if (!cl.length) text('0', this.clueW - gap - stepH / 2, oy + y * cs + cs / 2 + 1, T.clueDone);
        continue;
      }
      for (let k = 0; k < clues.length; k++) {
        const col = this.ink(done[k] ? T.clueDone : y === cueY ? T.cursor : blue ? T.hint : T.clue, this.clueBgOf(y, cueY), done[k]);
        text(String(clues[k] || 0), this.clueW - gap - (clues.length - k - 0.5) * stepH, oy + y * cs + cs / 2 + 1, col);
      }
    }
    ctx.restore();
    // corner stays plain
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, this.clueW - 2, this.clueH - 2);

    if (this.dragAt && this.dragLen > 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bx = Math.min(this.cssW - 30, Math.max(30, this.dragAt.x)), by = Math.max(26, this.dragAt.y - 52);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = T.outline; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(bx, by, 21, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.font = `800 21px "Nunito", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = T.outline; ctx.fillText(String(this.dragLen), bx, by + 1);
    }
  }
}

// ---- contrast (WCAG relative luminance)
function rgbOf(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { const x = m[1].length === 3 ? [...m[1]].map(d => d + d).join('') : m[1]; return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)) as [number, number, number]; }
  const r = c.match(/rgba?\(([^)]+)\)/);
  if (r) { const [a, b, d] = r[1].split(',').map(n => parseFloat(n)); return [a, b, d]; }
  return null;
}
const lum = ([r, g, b]: [number, number, number]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: [number, number, number], b: [number, number, number]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (c: [number, number, number]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** the colour, moved toward black or white (whichever the background allows) until it has the contrast */
export function readable(color: string, bg: string, min: number): string {
  const c = rgbOf(color), b = rgbOf(bg);
  if (!c || !b || contrast(c, b) >= min) return color;
  const target: [number, number, number] = lum(b) > 0.35 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1.001; t += 0.05) {
    const m = c.map((v, i) => v + (target[i] - v) * t) as [number, number, number];
    if (contrast(m, b) >= min) return hex(m);
  }
  return hex(target);
}

/** places of a pair's clue slots: a two-digit mega number in a row clue takes 1.6 places */
function slotUnits(slots: ReturnType<typeof bandSlots>, wide: boolean) {
  const size = slots.map(sl => (wide && (sl.m ?? 0) >= 10 ? 1.6 : 1));
  const start: number[] = [];
  let t = 0;
  for (const s of size) { start.push(t); t += s; }
  return { size, start, total: t };
}

/** what a tap with a tool does to a cell: set it, erase it, or nothing (null) */
function valueFor(tool: Tool, cur: Cell): Cell | null {
  // marking: a tap on a mark or a ✕ clears it (the next tap marks). It never turns a ✕ into a mark.
  // a stroke that starts on a ✕ only clears ✕s; one that starts on an empty cell leaves the ✕s on its way alone
  if (tool === 'mark') return cur === MARK || cur === CROSS ? EMPTY : cur === EMPTY ? MARK : null;
  // filling: the first tap on a ✕ clears it, the second fills the empty cell
  if (tool === 'fill' && cur === CROSS) return EMPTY;
  const want: Cell = tool === 'fill' ? FILL : CROSS;
  // tapping a cell that already has this mark erases (and the stroke keeps erasing); marks are written over
  return cur === want ? EMPTY : blank(cur) ? want : cur === FILL && tool === 'cross' ? EMPTY : want;
}
