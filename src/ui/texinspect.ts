// Debug tool (?debug): shows the per-puzzle textures of a decrypted 3DS game next to the puzzle's solution, decoded in
// every candidate pixel format, so the player can see which file holds the coloured picture. Runs on the player's
// device with their own file; nothing is stored.
import { readCtr, lz11 } from '../rom/ctr';
import { h, pickFile } from '../app';

type RGBA = [number, number, number, number];
const DEC: Record<string, [number, (d: Uint8Array, o: number) => RGBA]> = {
  RGBA8: [4, (d, o) => [d[o + 3], d[o + 2], d[o + 1], d[o]]],
  RGB8: [3, (d, o) => [d[o + 2], d[o + 1], d[o], 255]],
  RGBA5551: [2, (d, o) => { const v = d[o] | d[o + 1] << 8; return [(v >> 11 & 31) * 8, (v >> 6 & 31) * 8, (v >> 1 & 31) * 8, (v & 1) * 255]; }],
  RGB565: [2, (d, o) => { const v = d[o] | d[o + 1] << 8; return [(v >> 11 & 31) * 8, (v >> 5 & 63) * 4, (v & 31) * 8, 255]; }],
  RGBA4444: [2, (d, o) => { const v = d[o] | d[o + 1] << 8; return [(v >> 12 & 15) * 17, (v >> 8 & 15) * 17, (v >> 4 & 15) * 17, (v & 15) * 17]; }],
};

function decode(x: Uint8Array, fmt: string, flip: boolean): HTMLCanvasElement | null {
  const v = new DataView(x.buffer, x.byteOffset, x.byteLength);
  const nw = v.getUint32(0, true) === 0x80, o4 = nw ? 4 : 0, off = nw ? 0x80 : 0x14;
  const w = v.getUint32(o4 + 4, true), hh = v.getUint32(o4 + 8, true), W = v.getUint32(o4 + 12, true), H = v.getUint32(o4 + 16, true);
  const [bpp, dec] = DEC[fmt];
  if (!w || !hh || W % 8 || H % 8 || off + W * H * bpp > x.length) return null;
  const c = h('canvas', { width: w, height: hh, class: 'tx' }) as HTMLCanvasElement;
  const img = new ImageData(w, hh);
  for (let k = 0; k < W * H; k++) {
    const t = k >> 6, i = k & 63;
    const X = (t % (W / 8)) * 8 + ((i & 1) | ((i >> 1) & 2) | ((i >> 2) & 4));
    let Y = Math.floor(t / (W / 8)) * 8 + (((i >> 1) & 1) | ((i >> 2) & 2) | ((i >> 3) & 4));
    if (flip) Y = H - 1 - Y;
    if (X < w && Y < hh) img.data.set(dec(x, off + k * bpp), (Y * w + X) * 4);
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

export async function textureInspector(screen: (...k: Array<Node | null>) => HTMLElement, header: HTMLElement) {
  const f = await pickFile('.3ds,.cci,.cxi,.cia');
  if (!f) return;
  const t = readCtr(new Uint8Array(await f.arrayBuffer()));
  const byName = new Map(t.files.map(x => [x.path, x]));
  const puzzles = t.files.filter(x => /\.bprs2?$/i.test(x.path) && !/sample/i.test(x.path)).slice(0, 8);
  const body = h('div', { class: 'tex-inspect' }, h('p', { class: 'fine' }, f.name));
  for (const p of puzzles) {
    const base = p.path.replace(/\.bprs2?$/i, '');
    const row = h('div', { class: 'tex-row' }, h('b', {}, base.split('/').pop()!));
    const sibs = t.files.filter(x => x.path.startsWith(base + '_') && /\.jtex$/i.test(x.path));
    for (const s of sibs) {
      let x: Uint8Array;
      try { x = lz11(s.data); } catch { continue; }
      const v = new DataView(x.buffer, x.byteOffset);
      const fm = v.getUint32(v.getUint32(0, true) === 0x80 ? 4 : 0, true);
      const cell = h('div', { class: 'tex-file' }, h('small', {}, `${s.path.slice(base.length + 1)} · format ${fm}`));
      for (const name of Object.keys(DEC)) for (const flip of [false, true]) {
        const c = decode(x, name, flip);
        if (c) cell.append(h('figure', {}, c, h('figcaption', {}, name + (flip ? ' ↕' : ''))));
      }
      row.append(cell);
    }
    if (!sibs.length) row.append(h('small', {}, 'no textures named ' + base.split('/').pop() + '_*'));
    body.append(row);
    void byName;
  }
  screen(header, body);
}
