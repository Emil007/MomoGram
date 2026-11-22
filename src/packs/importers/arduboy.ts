// Nonogram games for the Arduboy (homebrew, Intel HEX files as the Arduboy loads them).
//
//  Game          File (recognised by)                                     Puzzles
//  PiCross       a table of pointers (16 bit) to records: width, height,  300: 25 each of 5×5 … 16×16
//                then the picture in 8-row pages, one byte per column
//                (bit 0 = top row of the page)
//  Picross a     625 bytes of 0 / 1 in a row: 25 pictures of 5×5,        25
//                row by row
//
// Neither file names its game, so the importer goes by these tables; the pack ids are fixed per game.
import { registerImporter } from './index';
import { Pack, PackLevel, rowsFromBits } from '../format';

/** the program memory an Intel HEX file describes (null when it isn't one) */
export function parseIntelHex(d: Uint8Array): Uint8Array | null {
  if (d[0] !== 0x3a) return null; // ':'
  const text = new TextDecoder('latin1').decode(d);
  const mem = new Uint8Array(0x10000);
  let top = 0, base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^:[0-9a-fA-F]+$/.test(line) || line.length < 11) return null;
    const b = Uint8Array.from(line.slice(1).match(/../g)!.map(x => parseInt(x, 16)));
    const n = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    if (b.length < 5 + n) return null;
    if (type === 0) { const a = base + addr; if (a + n > mem.length) return null; mem.set(b.subarray(4, 4 + n), a); top = Math.max(top, a + n); }
    else if (type === 2) base = ((b[4] << 8) | b[5]) * 16;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
    else if (type === 1) break;
  }
  return top ? mem.slice(0, top) : null;
}

/** a record of the PiCross format at o: square 5…16, nothing set below the last row */
function recordAt(d: Uint8Array, o: number): boolean {
  if (o + 2 > d.length) return false;
  const w = d[o], h = d[o + 1];
  if (w !== h || w < 5 || w > 16) return false;
  const pages = (h + 7) >> 3, last = h - 8 * (pages - 1), mask = (0xff << last) & 0xff;
  if (o + 2 + w * pages > d.length) return false;
  for (let x = 0; x < w; x++) if (d[o + 2 + (pages - 1) * w + x] & mask) return false;
  return true;
}

/** the longest table of pointers to records (at least 20) */
function pointerTable(d: Uint8Array): number[] | null {
  let best: number[] = [];
  for (let o = 0; o + 1 < d.length; o += 2) {
    const ptrs: number[] = [];
    for (let p = o; p + 1 < d.length; p += 2) { const v = d[p] | (d[p + 1] << 8); if (!recordAt(d, v)) break; ptrs.push(v); }
    if (ptrs.length > best.length) best = ptrs;
    if (ptrs.length >= 20) o += ptrs.length * 2;
  }
  return best.length >= 20 ? best : null;
}

/** 625 bytes of 0 / 1 (the end of the longest such run) */
function boolTable(d: Uint8Array): number {
  let start = -1;
  for (let i = 0; i <= d.length; i++) {
    if (i < d.length && d[i] <= 1) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= 625 && i - start <= 650 && d.subarray(start, i).includes(1)) return i - 625;
    start = -1;
  }
  return -1;
}

function readPiCross(d: Uint8Array, ptrs: number[]): Pack {
  const bySize = new Map<number, number[]>();
  for (const p of ptrs) { const w = d[p]; if (!bySize.has(w)) bySize.set(w, []); bySize.get(w)!.push(p); }
  const levels: PackLevel[] = [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([n, ps]) => ({
    id: `${n}x${n}`, title: { en: `${n}×${n}` }, rules: 'normal',
    puzzles: ps.map((p, k) => ({
      id: `${n}x${n}-${String(k + 1).padStart(2, '0')}`, width: n, height: n,
      rows: rowsFromBits(n, n, (x, y) => ((d[p + 2 + (y >> 3) * n + x] >> (y & 7)) & 1) === 1),
    })),
  }));
  return {
    format: 'momogram-pack', version: 1, id: 'arduboy-picross', title: { en: 'PiCross' },
    source: { game: 'PiCross', platform: 'Arduboy', developer: 'filmote, Vampirics' },
    theme: { palette: { style: 'logic', accent: '#202020', fill: '#202020' } },
    levels,
  };
}

function readPicrossA(d: Uint8Array, at: number): Pack {
  return {
    format: 'momogram-pack', version: 1, id: 'arduboy-picross-a', title: { en: 'Picross a' },
    source: { game: 'Picross a', platform: 'Arduboy', developer: 'lefishy' },
    theme: { palette: { style: 'logic', accent: '#202020', fill: '#202020' } },
    levels: [{
      id: '5x5', title: { en: '5×5' }, rules: 'normal',
      puzzles: [...Array(25)].map((_, k) => ({ id: `5x5-${String(k + 1).padStart(2, '0')}`, width: 5, height: 5, rows: rowsFromBits(5, 5, (x, y) => d[at + k * 25 + y * 5 + x] === 1) })),
    }],
  };
}

registerImporter({
  name: 'Arduboy',
  version: 1, // raise when the importer reads more or reads differently
  detect: (d, name) => /\.hex$/i.test(name) && d[0] === 0x3a,
  read: d => {
    const mem = parseIntelHex(d);
    if (!mem) throw new Error('Not an Arduboy program.');
    const ptrs = pointerTable(mem);
    if (ptrs) return [readPiCross(mem, ptrs)];
    const at = boolTable(mem);
    if (at >= 0) return [readPicrossA(mem, at)];
    return [];
  },
});
