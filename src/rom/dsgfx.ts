// Draws Nintendo DS OBJ (sprite) cells from 4bpp tile data, as used by the solved-puzzle pictures.

const OBJ_SIZES: Array<Array<[number, number]>> = [
  [[8, 8], [16, 16], [32, 32], [64, 64]], // square
  [[16, 8], [32, 8], [32, 16], [64, 32]], // wide
  [[8, 16], [8, 32], [16, 32], [32, 64]], // tall
];

export function bgr555(pal: Uint8Array): Uint32Array {
  const out = new Uint32Array(pal.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const c = pal[i * 2] | (pal[i * 2 + 1] << 8);
    const r = (c & 31) * 255 / 31, g = ((c >> 5) & 31) * 255 / 31, b = ((c >> 10) & 31) * 255 / 31;
    out[i] = (255 << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r); // little-endian RGBA
  }
  return out;
}

export interface Frame { width: number; height: number; pixels: Uint32Array; ox: number; oy: number }

/**
 * Render one cell (list of OAM entries) into an RGBA buffer. Coordinates are relative to the cell origin;
 * the result covers the union of all sprites. Colour index 0 is transparent.
 * 2D OBJ mapping: the tile sheet is 32 tiles (256 px) wide and a sprite's tile rows
 * are 32 tiles apart.
 */
export function renderCell(cells: Array<[number, number, number]>, tiles: Uint8Array, palette: Uint32Array, sheetTilesWide = 32): Frame {
  type Spr = { x: number; y: number; w: number; h: number; tile: number; hf: boolean; vf: boolean; pal: number };
  const sprs: Spr[] = [];
  for (const [a0, a1, a2] of cells) {
    const shape = a0 >> 14, size = a1 >> 14;
    const [w, h] = OBJ_SIZES[Math.min(shape, 2)][size];
    let y = a0 & 0xff; if (y >= 128) y -= 256;
    let x = a1 & 0x1ff; if (x >= 256) x -= 512;
    const affine = (a0 >> 8) & 1, dbl = (a0 >> 9) & 1;
    // double-size affine sprites are drawn centred in a 2x box; we draw unscaled at the centre
    if (affine && dbl) { x += w / 2; y += h / 2; }
    sprs.push({ x, y, w, h, tile: a2 & 0x3ff, hf: !affine && !!((a1 >> 12) & 1), vf: !affine && !!((a1 >> 13) & 1), pal: (a2 >> 12) & 15 });
  }
  if (!sprs.length) return { width: 0, height: 0, pixels: new Uint32Array(0), ox: 0, oy: 0 };
  const minX = Math.min(...sprs.map(s => s.x)), minY = Math.min(...sprs.map(s => s.y));
  const maxX = Math.max(...sprs.map(s => s.x + s.w)), maxY = Math.max(...sprs.map(s => s.y + s.h));
  const W = maxX - minX, H = maxY - minY;
  const px = new Uint32Array(W * H);
  for (const s of sprs) {
    const tx0 = s.tile % sheetTilesWide, ty0 = Math.floor(s.tile / sheetTilesWide);
    for (let yy = 0; yy < s.h; yy++) {
      for (let xx = 0; xx < s.w; xx++) {
        const sx = s.hf ? s.w - 1 - xx : xx, sy = s.vf ? s.h - 1 - yy : yy;
        const t = (ty0 + (sy >> 3)) * sheetTilesWide + tx0 + (sx >> 3);
        const b = tiles[t * 32 + (sy & 7) * 4 + ((sx & 7) >> 1)];
        if (b === undefined) continue;
        const v = (sx & 1) ? b >> 4 : b & 15;
        if (!v) continue;
        px[(s.y - minY + yy) * W + (s.x - minX + xx)] = palette[s.pal * 16 + v] ?? palette[v];
      }
    }
  }
  return { width: W, height: H, pixels: px, ox: minX, oy: minY };
}

/** Bounding box of opaque pixels. */
export function opaqueBox(f: Frame): { x: number; y: number; w: number; h: number } {
  let x0 = f.width, y0 = f.height, x1 = -1, y1 = -1;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (f.pixels[y * f.width + x] >>> 24) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
