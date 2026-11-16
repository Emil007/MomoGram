// Canvas view of a puzzle: clues pinned to the edges, zoom/pan for large grids, mouse/touch/keyboard/gamepad input.
import { Board, CROSS, EMPTY, FILL, Cell } from './board';

export type Tool = 'fill' | 'cross';

export interface ViewEvents {
  onChange(result: 'ok' | 'mistake'): void;
  onStroke?(): void;
}

export interface Theme {
  bg: string; grid: string; grid5: string; cell: string; cellDither: string; fill: string; fillDither: string; trialFill: string; cross: string; mistake: string;
  clueBg: string; clueBgAlt: string; clue: string; clueOutline: string; clueDone: string; hl: string; cursor: string; hint: string; roulette: string; outline: string;
}

// MomoGram's own sky-blue look: striped clue bands, dithered cells, orange 5-cell guides
const THEME: Theme = {
  bg: '#ffffff', grid: '#9fd6f2', grid5: '#f39a2c', cell: '#dff3fd', cellDither: '#cfecfb', fill: '#2b9fe0', fillDither: '#2291d2',
  trialFill: '#f0a040', cross: '#7cc4ea', mistake: '#e04040',
  clueBg: '#b5e3fa', clueBgAlt: '#b5e3fa', clue: '#151515', clueOutline: '#ffffff', clueDone: '#b4c2cc',
  hl: 'rgba(255, 196, 70, 0.42)', cursor: '#f08a10', hint: '#1565e0', roulette: 'rgba(240, 140, 30, 0.5)', outline: '#1a1a1a',
};

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  board: Board;
  tool: Tool = 'fill';
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
  // stroke state
  private stroke: null | { x0: number; y0: number; axis: 0 | 1 | 2; value: Cell; erase: Cell; pointer: number } = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: null | { d: number; cell: number; cx: number; cy: number; sx: number; sy: number } = null;
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
  private spin: { row: number; col: number; flash: boolean } | null = null;
  get spinning() { return !!this.spin; }

  /** Hint roulette, like Picross DS: a row and a column spin, slow down and stop on the target. */
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

  private maxClues() {
    const b = this.board;
    return { r: Math.max(1, ...b.rowClues.map(c => c.length)), c: Math.max(1, ...b.colClues.map(c => c.length)) };
  }

  /** Fit the whole puzzle; on small screens the cell size is clamped and the view becomes pannable. */
  private layout(reset: boolean) {
    const { r, c } = this.maxClues();
    const b = this.board;
    // clue numbers are ~0.62 (wide) / 0.66 (tall) of a cell, but never larger than 26 px each
    // leave room for the outer frame
    const W = this.cssW - 10, H = this.cssH - 10;
    let fit = Math.min(W / (b.w + r * 0.62 + 0.3), H / (b.h + c * 0.66 + 0.3));
    if (fit * 0.62 > 26) fit = Math.min((W - r * 26 - 10) / b.w, (H - c * 28 - 10) / b.h);
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
    this.clueW = Math.ceil(r * Math.min(cc * 0.62, 26) + Math.min(cc * 0.3, 10));
    this.clueH = Math.ceil(c * Math.min(cc * 0.66, 28) + Math.min(cc * 0.3, 10));
  }

  get zoomed() { return this.cell > this.fitCell + 0.5; }

  /** the clue corner (top-left), where the DS-style tool pad sits */
  cornerRect() { return { x: this.padX, y: this.padY, w: this.clueW, h: this.clueH }; }
  /** visible part of the grid, in cells (for the zoom frame on the top screen) */
  visibleCells() {
    const b = this.board, cs = this.cell;
    const vw = this.cssW - this.padX * 2 - this.clueW, vh = this.cssH - this.padY * 2 - this.clueH;
    return { x: Math.max(0, this.scrollX / cs), y: Math.max(0, this.scrollY / cs), w: Math.min(b.w, vw / cs), h: Math.min(b.h, vh / cs) };
  }
  onLayout: (() => void) | null = null;
  /** length of the current drag, shown in a bubble like on the DS */
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
    if (this.spin) return; // no marks while the hint roulette spins
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      // second finger: cancel the stroke, start pinch / pan
      if (this.stroke) { this.board.undo(); this.stroke = null; this.dirty = true; }
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cell: this.cell, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, sx: this.scrollX, sy: this.scrollY };
      return;
    }
    if (this.pointers.size > 2) return;
    // middle mouse: pan
    if (e.button === 1) { this.pinch = { d: 0, cell: this.cell, cx: p.x, cy: p.y, sx: this.scrollX, sy: this.scrollY }; return; }
    const c = this.cellAt(p.x, p.y);
    if (!c) return;
    this.showCursor = false;
    const tool: Tool = e.button === 2 ? (this.tool === 'fill' ? 'cross' : 'fill') : this.tool;
    const cur = this.board.at(c.x, c.y);
    const want: Cell = tool === 'fill' ? FILL : CROSS;
    // tapping a cell that already has this mark erases (and the stroke keeps erasing)
    const value: Cell = cur === want ? EMPTY : cur === EMPTY ? want : cur === FILL && tool === 'cross' ? EMPTY : want;
    this.board.pushUndo();
    this.stroke = { x0: c.x, y0: c.y, axis: 0, value, erase: cur, pointer: e.pointerId };
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
        this.scrollX = this.pinch.sx - (cx - this.pinch.cx);
        this.scrollY = this.pinch.sy - (cy - this.pinch.cy);
        this.setZoom(this.pinch.cell * (d / Math.max(1, this.pinch.d)), cx, cy);
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
    // lock to the row or column of the first movement, like Picross DS
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
    this.dragLen = Math.abs(b - a) + 1;
    this.dragAt = { x: p.x, y: p.y };
    this.dirty = true;
  }

  private up(e: PointerEvent) {
    if (this.dragAt) { this.dragAt = null; this.dragLen = 0; this.dirty = true; }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2 && this.pinch && this.pinch.d) this.pinch = null;
    if (this.pinch && !this.pinch.d && this.pointers.size === 0) this.pinch = null;
    if (this.stroke && this.stroke.pointer === e.pointerId) { this.stroke = null; this.ev.onStroke?.(); }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const p = { x: e.offsetX, y: e.offsetY };
    if (e.ctrlKey || Math.abs(e.deltaY) > 0 && !e.shiftKey) this.setZoom(this.cell * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y);
    else { this.scrollX += e.deltaX || e.deltaY; this.clampScroll(); this.dirty = true; }
  }

  private paint(x: number, y: number) {
    const s = this.stroke;
    const cur = this.board.at(x, y);
    // a stroke only changes cells that are empty (when marking) or carry the same mark (when erasing)
    if (s) {
      if (s.value !== EMPTY && cur !== EMPTY) return;
      if (s.value === EMPTY && cur !== s.erase) return;
    }
    const r = this.board.set(x, y, s ? s.value : FILL);
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
    if (this.spin) return EMPTY;
    this.showCursor = true;
    const cur = this.board.at(this.cursorX, this.cursorY);
    const want: Cell = tool === 'fill' ? FILL : CROSS;
    const value: Cell = cur === want ? EMPTY : cur === EMPTY ? want : want === CROSS && cur === FILL ? EMPTY : want;
    this.board.pushUndo();
    this.applyAtCursor(value, false);
    return value;
  }

  private applyAtCursor(value: Cell, continuing: boolean) {
    const cur = this.board.at(this.cursorX, this.cursorY);
    if (continuing && value !== EMPTY && cur !== EMPTY) return;
    if (continuing && value === EMPTY && cur === EMPTY) return;
    const r = this.board.set(this.cursorX, this.cursorY, value);
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
    // dither dot size in device pixels: fine texture like the DS cells
    const dp = Math.max(1, Math.round(cs * dpr / 14));
    const pat = (a: string, c: string) => { const p = this.dither(a, c, dp); if (typeof p !== 'string') p.setTransform(new DOMMatrix().scale(1 / dpr)); return p; };
    const now = performance.now();
    const cueX = this.showCursor || this.spin ? (this.spin ? this.spin.col : this.cursorX) : -1;
    const cueY = this.showCursor || this.spin ? (this.spin ? this.spin.row : this.cursorY) : -1;

    // ---- clue bands: alternating colour stripes that fade out towards the edge
    const bandH = ctx.createLinearGradient(0, 0, this.clueW, 0);
    bandH.addColorStop(0, T.clueBg + '00'); bandH.addColorStop(0.45, T.clueBg); bandH.addColorStop(1, T.clueBg);
    const bandV = ctx.createLinearGradient(0, 0, 0, this.clueH);
    bandV.addColorStop(0, T.clueBg + '00'); bandV.addColorStop(0.45, T.clueBg); bandV.addColorStop(1, T.clueBg);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW, gh); ctx.clip();
    for (let y = vy0; y < vy1; y++) if (y % 2 === 0) { ctx.fillStyle = bandH; ctx.fillRect(0, oy + y * cs, this.clueW, cs); }
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(this.clueW, 0, gw, this.clueH); ctx.clip();
    for (let x = vx0; x < vx1; x++) if (x % 2 === 0) { ctx.fillStyle = bandV; ctx.fillRect(ox + x * cs, 0, cs, this.clueH); }
    ctx.restore();

    // ---- cells
    ctx.save();
    ctx.beginPath(); ctx.rect(this.clueW, this.clueH, gw, gh); ctx.clip();
    ctx.fillStyle = pat(T.cell, T.cellDither);
    ctx.fillRect(ox + vx0 * cs, oy + vy0 * cs, (vx1 - vx0) * cs, (vy1 - vy0) * cs);
    const fillPat = pat(T.fill, T.fillDither), trialPat = pat(T.trialFill, T.trialFill);
    for (let y = vy0; y < vy1; y++) for (let x = vx0; x < vx1; x++) {
      const v = b.at(x, y), px = ox + x * cs, py = oy + y * cs, i = y * b.w + x;
      const trial = b.isTrialCell(x, y);
      if (v === FILL) {
        ctx.fillStyle = trial ? trialPat : fillPat;
        ctx.fillRect(px, py, cs, cs);
      } else if (v === CROSS) {
        const t = this.mistakeFlash.get(i);
        let col = trial ? T.trialFill : T.cross;
        if (t !== undefined) { if (now - t > 1200) this.mistakeFlash.delete(i); else col = T.mistake; }
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.5, cs / 7);
        ctx.lineCap = 'round';
        const m = cs * 0.24;
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
    const g5 = Math.max(1.5, cs / 12);
    for (let x = vx0; x <= vx1; x++) if (x % 5 === 0 && x > 0 && x < b.w) ctx.fillRect(ox + x * cs - g5 / 2, oy + vy0 * cs, g5, (vy1 - vy0) * cs);
    for (let y = vy0; y <= vy1; y++) if (y % 5 === 0 && y > 0 && y < b.h) ctx.fillRect(ox + vx0 * cs, oy + y * cs - g5 / 2, (vx1 - vx0) * cs, g5);
    // roulette / cursor beams over the grid
    if (cueY >= 0) {
      ctx.fillStyle = this.spin?.flash ? 'rgba(255, 200, 60, 0.7)' : this.spin ? T.roulette : T.hl;
      ctx.fillRect(ox, oy + cueY * cs, b.w * cs, cs);
      ctx.fillRect(ox + cueX * cs, oy, cs, b.h * cs);
    }
    if (this.showCursor && !this.spin) {
      // black-and-white cursor box
      const x = ox + this.cursorX * cs, y = oy + this.cursorY * cs, lw = Math.max(2, cs / 9);
      ctx.lineWidth = lw * 2; ctx.strokeStyle = '#fff'; ctx.strokeRect(x + lw, y + lw, cs - lw * 2, cs - lw * 2);
      ctx.lineWidth = lw; ctx.strokeStyle = T.outline; ctx.strokeRect(x + lw / 2, y + lw / 2, cs - lw, cs - lw);
    }
    ctx.restore();
    // outer frame
    ctx.strokeStyle = T.outline;
    ctx.lineWidth = Math.max(2, cs / 10);
    ctx.strokeRect(this.clueW - ctx.lineWidth / 2 + Math.min(0, ox - this.clueW), this.clueH - ctx.lineWidth / 2 + Math.min(0, oy - this.clueH),
      b.w * cs + ctx.lineWidth, b.h * cs + ctx.lineWidth);
    // the frame may run under the clues when scrolled: repaint the clue areas' backgrounds where needed
    // (clues are drawn on top below)

    // ---- clue numbers: chunky digits with a white outline
    const fs = Math.max(9, Math.min(cs * 0.66, 24));
    const font = `800 ${fs}px "Nunito", "Arial Rounded MT Bold", "Segoe UI", system-ui, sans-serif`;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const text = (s: string, x: number, y: number, col: string) => {
      ctx.lineWidth = Math.max(2, fs * 0.28);
      ctx.strokeStyle = T.clueOutline;
      ctx.strokeText(s, x, y);
      ctx.fillStyle = col;
      ctx.fillText(s, x, y);
    };
    const cc = Math.max(cs, 14);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.clueW, 0, viewW - this.clueW, this.clueH); ctx.clip();
    if (cueX >= 0) { ctx.fillStyle = this.spin ? T.roulette : T.hl; ctx.fillRect(ox + cueX * cs, 0, cs, this.clueH); }
    const stepV = Math.min(cc * 0.66, 28, fs * 1.12);
    for (let x = vx0; x < vx1; x++) {
      const clues = b.colClues[x], done = b.colDone(x), blue = this.logicHints && b.colCanProgress(x);
      for (let k = 0; k < clues.length; k++) {
        const col = done[k] ? T.clueDone : x === cueX ? T.cursor : blue ? T.hint : T.clue;
        text(String(clues[k] || 0), ox + x * cs + cs / 2, this.clueH - (clues.length - k - 0.5) * stepV - 3, col);
      }
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, this.clueH, this.clueW, viewH - this.clueH); ctx.clip();
    if (cueY >= 0) { ctx.fillStyle = this.spin ? T.roulette : T.hl; ctx.fillRect(0, oy + cueY * cs, this.clueW, cs); }
    const stepH = Math.min(cc * 0.62, 26, fs * 0.95);
    for (let y = vy0; y < vy1; y++) {
      const clues = b.rowClues[y], done = b.rowDone(y), blue = this.logicHints && b.rowCanProgress(y);
      for (let k = 0; k < clues.length; k++) {
        const col = done[k] ? T.clueDone : y === cueY ? T.cursor : blue ? T.hint : T.clue;
        text(String(clues[k] || 0), this.clueW - (clues.length - k - 0.5) * stepH - 4, oy + y * cs + cs / 2 + 1, col);
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
