// Oh-chan no Oekaki Logic (Super Famicom, 1995): LoROM header title "OHCHAN NO LOGIC".
//
// Found by tracing the game in an emulator (which ROM bytes it reads when a puzzle is opened).
// A ROM bank starts with a table of 24-bit offsets (relative to the table), one per puzzle; each points at a
// 16-bit length and that many bytes of LZSS (4 KB window cleared to 0, writing from 0xFEE; a flag byte per 8
// items, bit set = literal byte, else 12-bit position and 4-bit length + 3). Unpacked, a puzzle is:
//   16 bytes: size code (0 = 5×5, 1 = 10×10, … 5 = 30×30), the rest 0
//   32 bytes: palette, 16 colours (BGR555)
//   the solved picture: one nibble per cell (low nibble first), the cell's colour
//   the solution: one bit per cell, row by row, most significant bit first
// 300 puzzles, numbered 001-300 as in the game; the game's four levels start where the sizes start over
// (Level 2 at 090, checked in the game).
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, rowsFromBits } from '../format';

const SIZE = [5, 10, 15, 20, 25, 30];

/** the LoROM header title (0x7FC0) */
const loRomTitle = (d: Uint8Array) => d.length >= 0x8000 ? String.fromCharCode(...d.subarray(0x7fc0, 0x7fd5)) : '';

export function lzss(src: Uint8Array): Uint8Array {
  const ring = new Uint8Array(4096), out: number[] = [];
  let r = 4096 - 18, i = 0, flags = 0;
  const put = (c: number) => { out.push(c); ring[r] = c; r = (r + 1) & 4095; };
  while (i < src.length) {
    flags >>= 1;
    if (!(flags & 0x100)) { flags = src[i++] | 0xff00; if (i >= src.length) break; }
    if (flags & 1) put(src[i++]);
    else {
      if (i + 1 >= src.length) break;
      const p = src[i] | ((src[i + 1] & 0xf0) << 4), n = (src[i + 1] & 15) + 3;
      i += 2;
      for (let k = 0; k < n; k++) put(ring[(p + k) & 4095]);
    }
  }
  return Uint8Array.from(out);
}

/** the table of puzzles: at the start of a 32 KB bank, offsets rising, the first record right after the table */
function findTable(d: Uint8Array): { at: number; offsets: number[] } | null {
  for (let b = 0; b + 0x8000 <= d.length; b += 0x8000) {
    const offsets: number[] = [];
    for (let i = 0; b + 3 * i + 3 <= d.length && i < 1000; i++) {
      const v = d[b + 3 * i] | (d[b + 3 * i + 1] << 8) | (d[b + 3 * i + 2] << 16);
      if (offsets.length && (v <= offsets[offsets.length - 1] || b + v + 2 >= d.length)) break;
      offsets.push(v);
    }
    if (offsets.length >= 100 && offsets[0] === 3 * offsets.length) return { at: b, offsets };
  }
  return null;
}

function readOhchan(d: Uint8Array): Pack {
  const t = findTable(d);
  if (!t) throw new Error('Puzzle table not found.');
  const levels: PackLevel[] = [];
  let last = 99;
  t.offsets.forEach((off, k) => {
    const a = t.at + off, len = d[a] | (d[a + 1] << 8);
    const x = lzss(d.subarray(a + 2, a + 2 + len));
    const n = SIZE[x[0]];
    if (!n) return;
    const cells = (n * n + 1) >> 1, bits = 48 + cells;
    if (x.length < bits + ((n * n + 7) >> 3)) return;
    const rows = rowsFromBits(n, n, (c, y) => { const i = y * n + c; return ((x[bits + (i >> 3)] >> (7 - (i & 7))) & 1) === 1; });
    const palette = [...Array(16)].map((_, i) => {
      const v = x[16 + 2 * i] | (x[17 + 2 * i] << 8);
      return '#' + [v & 31, (v >> 5) & 31, (v >> 10) & 31].map(c => ((c * 255 / 31) | 0).toString(16).padStart(2, '0')).join('');
    });
    const colours = [...Array(n)].map((_, y) => [...Array(n)].map((_, c) => { const i = y * n + c; return ((x[48 + (i >> 1)] >> (i & 1 ? 4 : 0)) & 15).toString(36); }).join(''));
    if (x[0] < last) {
      const l = levels.length + 1;
      levels.push({ id: `level-${l}`, title: { en: `Level ${l}`, ja: `レベル ${l}` }, rules: 'normal', puzzles: [] });
    }
    last = x[0];
    const pz: PackPuzzle = { id: String(k + 1).padStart(3, '0'), width: n, height: n, rows, color: { palette, rows: colours } };
    levels[levels.length - 1].puzzles.push(pz);
  });
  return {
    format: 'momogram-pack', version: 1, id: 'sfc-ohchan-oekaki-logic',
    title: { en: 'Oh-chan no Oekaki Logic', ja: 'おーちゃんのお絵かきロジック' },
    source: { game: 'Oh-chan no Oekaki Logic', platform: 'Super Famicom', region: 'JPN', developer: 'Sunsoft', year: 1995 },
    theme: { palette: { style: 'logic', accent: '#4050a0' } },
    levels,
  };
}

registerImporter({
  name: "Oh-chan no Oekaki Logic (Super Famicom)",
  version: 1, // raise when the importer reads more or reads differently
  detect: d => /^OHCHAN NO LOGIC/.test(loRomTitle(d)),
  read: d => [readOhchan(d)],
});
