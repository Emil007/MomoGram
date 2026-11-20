// Solved-picture rendering: the animated colour picture from the user's Picross DS ROM when available,
// otherwise the pack's colour data, otherwise the solution itself.
import type { PackPuzzle } from '../packs/format';
import type { DsAnimRef } from '../rom/picrossds';
import { bgr555, renderCell, Frame } from '../rom/dsgfx';

export type PckGetter = (i: number) => Uint8Array | null;

// coloured solved pictures read from the player's games, keyed by the puzzle's pattern
const colourPics = new Map<string, HTMLCanvasElement>();
export function addPictures(m: Map<string, { w: number; h: number; rgba: Uint8Array }>) {
  for (const [k, p] of m) {
    if (colourPics.has(k)) continue;
    const c = document.createElement('canvas');
    c.width = p.w; c.height = p.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba.buffer.slice(p.rgba.byteOffset, p.rgba.byteOffset + p.rgba.byteLength) as ArrayBuffer), p.w, p.h), 0, 0);
    colourPics.set(k, c);
  }
}
const pictureOf = (p: PackPuzzle) => colourPics.get(p.rows.join('/')) ?? null;

export class PictureAnimator {
  private frames: Frame[] = [];
  private durations: number[] = [];
  private loopTo = 0;
  private idx = 0;
  private acc = 0;
  private still: HTMLCanvasElement | null = null;

  constructor(private puzzle: PackPuzzle & { anim?: DsAnimRef }, pck: PckGetter | null) {
    const a = this.puzzle.anim;
    if (a && pck) {
      const pal = pck(a.palette), tiles = pck(a.tiles);
      if (pal && tiles) {
        const p = bgr555(pal);
        for (const s of a.script) { this.frames.push(renderCell(s.cells, tiles, p)); this.durations.push(Math.max(1, s.frames)); }
        this.loopTo = a.loopTo;
      }
    }
  }

  get animated() { return this.frames.length > 0; }

  /** advance by dt milliseconds (DS runs at ~60 fps) */
  tick(dt: number) {
    if (!this.frames.length) return;
    this.acc += dt / (1000 / 60);
    while (this.acc >= this.durations[this.idx]) {
      this.acc -= this.durations[this.idx];
      this.idx++;
      if (this.idx >= this.frames.length) this.idx = Math.min(this.loopTo, this.frames.length - 1);
    }
  }

  lastFrame(): Frame | null { return this.frames.length ? this.frames[this.frames.length - 1] : null; }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    ctx.imageSmoothingEnabled = false;
    if (this.frames.length) {
      const f = this.frames[this.idx];
      drawFrame(ctx, f, x, y, size);
      return;
    }
    if (!this.still) this.still = pictureOf(this.puzzle) ?? staticPicture(this.puzzle);
    const s = Math.min(size / this.still.width, size / this.still.height);
    ctx.imageSmoothingEnabled = this.still.width > 64; // large illustrations smooth, pixel pictures sharp
    ctx.drawImage(this.still, x + (size - this.still.width * s) / 2, y + (size - this.still.height * s) / 2, this.still.width * s, this.still.height * s);
  }
}

export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame, x: number, y: number, size: number) {
  if (!f.width) return;
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const id = new ImageData(new Uint8ClampedArray(f.pixels.buffer.slice(0) as ArrayBuffer), f.width, f.height);
  c.getContext('2d')!.putImageData(id, 0, 0);
  const s = Math.floor(Math.min(size / f.width, size / f.height)) || Math.min(size / f.width, size / f.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, x + (size - f.width * s) / 2, y + (size - f.height * s) / 2, f.width * s, f.height * s);
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
export function thumbnail(p: PackPuzzle & { anim?: DsAnimRef }, pck: PckGetter | null, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  const a = new PictureAnimator(p, pck);
  const lf = a.lastFrame();
  if (lf) drawFrame(ctx, lf, 0, 0, size);
  else a.draw(ctx, 0, 0, size);
  return c;
}
