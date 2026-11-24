// Solved-picture rendering: the pack's animated picture when it has one (Pack.anims),
// otherwise the pack's colour data, otherwise the solution itself.
import type { PackPuzzle } from '../packs/format';
import type { AnimRef } from '../packs/format';
import { bgr555, renderCell, Frame } from '../rom/dsgfx';

export type PckGetter = (i: number) => Uint8Array | null;

// coloured solved pictures read from the player's games, per pack and keyed by the puzzle's pattern (two games
// can have the same small pattern with different pictures)
const colourPics = new Map<string, HTMLCanvasElement>();
export function addPictures(packId: string, m: Map<string, { w: number; h: number; rgba: Uint8Array }>) {
  for (const [pat, p] of m) {
    const k = packId + '|' + pat;
    if (colourPics.has(k)) continue;
    const c = document.createElement('canvas');
    c.width = p.w; c.height = p.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba.buffer.slice(p.rgba.byteOffset, p.rgba.byteOffset + p.rgba.byteLength) as ArrayBuffer), p.w, p.h), 0, 0);
    colourPics.set(k, c);
  }
}
/** the game a puzzle's picture comes from (a daily puzzle: its own game) */
const picPack = (p: PackPuzzle, packId: string) => (p.origin ? p.origin.slice(0, p.origin.lastIndexOf('/')) : packId).replace(/@mega$/, '');
const pictureOf = (p: PackPuzzle, packId: string) => colourPics.get(picPack(p, packId) + '|' + p.rows.join('/')) ?? null;

export class PictureAnimator {
  private frames: Frame[] = [];
  private durations: number[] = [];
  private loopTo = 0;
  private idx = 0;
  private acc = 0;
  private still: HTMLCanvasElement | null = null;

  /** the part of the frames that is drawn on (small pictures sit in a corner of a bigger frame) */
  private box: { x: number; y: number; w: number; h: number } | null = null;

  constructor(private puzzle: PackPuzzle & { anim?: AnimRef }, pck: PckGetter | null, private packId = '') {
    const a = this.puzzle.anim;
    if (a && pck) {
      const pal = pck(a.palette), tiles = pck(a.tiles);
      if (pal && tiles) {
        const p = bgr555(pal);
        for (const s of a.script) { this.frames.push(renderCell(s.cells, tiles, p)); this.durations.push(Math.max(1, s.frames)); }
        this.loopTo = a.loopTo;
        // scripts often open and close on an empty cell: those frames are a blank icon and a blank flash
        while (this.frames.length && frameEmpty(this.frames[0])) {
          this.frames.shift(); this.durations.shift();
          if (this.loopTo > 0) this.loopTo--;
        }
        while (this.frames.length > 1 && frameEmpty(this.frames[this.frames.length - 1])) { this.frames.pop(); this.durations.pop(); }
        if (this.loopTo >= this.frames.length) this.loopTo = 0;
        const first = this.frames.findIndex(f => !frameEmpty(f));
        this.idx = first < 0 ? 0 : first;
        this.box = usedBox(this.frames);
      }
    }
  }

  get animated() { return this.frames.length > 0; }

  /** advance by dt milliseconds (the animations run at ~60 fps) */
  tick(dt: number) {
    if (!this.frames.length) return;
    this.acc += dt / (1000 / 60);
    while (this.acc >= this.durations[this.idx]) {
      this.acc -= this.durations[this.idx];
      this.idx++;
      if (this.idx >= this.frames.length) this.idx = Math.min(this.loopTo, this.frames.length - 1);
      // a blank frame in the middle is skipped, so the picture never flashes empty
      let guard = 0;
      while (frameEmpty(this.frames[this.idx]) && guard++ < this.frames.length) {
        this.idx++;
        if (this.idx >= this.frames.length) this.idx = Math.min(this.loopTo, this.frames.length - 1);
      }
      if (frameEmpty(this.frames[this.idx])) break;
    }
  }

  lastFrame(): Frame | null { return this.frames.length ? this.frames[this.frames.length - 1] : null; }
  /** the frame with the most drawn pixels: the icon on the puzzle list, not an empty hold frame */
  bestFrame(): Frame | null {
    let best: Frame | null = null, n = 0;
    for (const f of this.frames) { const c = opaqueCount(f); if (c > n) { n = c; best = f; } }
    return best;
  }
  get usedBox() { return this.box; }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    ctx.imageSmoothingEnabled = false;
    if (this.frames.length) {
      const f = this.frames[this.idx];
      drawFrame(ctx, f, x, y, size, this.box);
      return;
    }
    if (!this.still) this.still = pictureOf(this.puzzle, this.packId) ?? staticPicture(this.puzzle);
    const s = Math.min(size / this.still.width, size / this.still.height);
    ctx.imageSmoothingEnabled = this.still.width > 64; // large illustrations smooth, pixel pictures sharp
    ctx.drawImage(this.still, x + (size - this.still.width * s) / 2, y + (size - this.still.height * s) / 2, this.still.width * s, this.still.height * s);
  }
}

function frameEmpty(f: Frame): boolean {
  if (!f.width || !f.height) return true;
  for (let i = 0; i < f.pixels.length; i++) if (f.pixels[i] >>> 24) return false;
  return true;
}
function opaqueCount(f: Frame): number {
  let n = 0;
  for (let i = 0; i < f.pixels.length; i++) if (f.pixels[i] >>> 24) n++;
  return n;
}

/** the smallest box holding every drawn (not transparent) pixel of all frames */
function usedBox(frames: Frame[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const f of frames) for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    if (!(f.pixels[y * f.width + x] >>> 24)) continue; // RGBA in one 32-bit word (little-endian: alpha on top)
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** a frame, scaled to fit and centred; `box`: only this part of it (the part the animation uses) */
export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame, x: number, y: number, size: number, box: { x: number; y: number; w: number; h: number } | null = null) {
  if (!f.width) return;
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const id = new ImageData(new Uint8ClampedArray(f.pixels.buffer.slice(0) as ArrayBuffer), f.width, f.height);
  c.getContext('2d')!.putImageData(id, 0, 0);
  const b = box ?? { x: 0, y: 0, w: f.width, h: f.height };
  const s = Math.floor(Math.min(size / b.w, size / b.h)) || Math.min(size / b.w, size / b.h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, b.x, b.y, b.w, b.h, x + (size - b.w * s) / 2, y + (size - b.h * s) / 2, b.w * s, b.h * s);
}

/** Picture from pack colour data or from the solution. */
export function staticPicture(p: PackPuzzle): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = p.width; c.height = p.height;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    if (p.color) {
      const ch = p.color.rows[y]?.[x];
      if (ch && ch !== '.') { ctx.fillStyle = p.color.palette[parseInt(ch, 36)] ?? '#000'; ctx.fillRect(x, y, 1, 1); continue; }
    }
    ctx.fillStyle = p.rows[y][x] === '#' ? '#2a3f6e' : '#f4f8fd';
    ctx.fillRect(x, y, 1, 1);
  }
  return c;
}

/** Small thumbnail for puzzle lists (cleared puzzles). */
export function thumbnail(p: PackPuzzle & { anim?: AnimRef }, pck: PckGetter | null, size: number, packId = ''): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  const a = new PictureAnimator(p, pck, packId);
  const lf = a.bestFrame();
  if (lf) drawFrame(ctx, lf, 0, 0, size, a.usedBox);
  else a.draw(ctx, 0, 0, size);
  return c;
}
