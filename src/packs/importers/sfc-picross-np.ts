// Picross NP Vol. 1-8 (Super Famicom, Nintendo Power cartridges, 1999-2000): header title "PICROSS NP VOL.n".
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, rowsFromBits } from '../format';
import { sfcHeaderTitle, sfcWithMusic } from '../../rom/sfc';

const letter = (i: number) => String.fromCharCode(65 + i);

// ---- Picross NP Vol. 1-8 (Nintendo Power, 1999) ----
// A newer engine: a ROM bank starts with a table of 24-bit offsets (relative to that bank), one per
// record. A record starts with a size code (0 = 5x5, 1 = 10x10, 2 = 15x15, 5 = 20x20, 6 = 25x20) and a
// colour byte, followed by the solution as one bitstream, row-major, most significant bit first, then
// the coloured picture. Vol. 1-5 hold 122 records, Vol. 6-8 242: the first two are the title-screen demo
// and the tutorial (not imported), the rest are the volume's puzzles in sets of twelve (A-L), in the
// order they are stored. Which mode (Beginner, Regular, ...) a set belongs to is not stored next to the
// puzzles, so sets are numbered.
const NP_SIZES: Record<number, [number, number]> = { 0: [5, 5], 1: [10, 10], 2: [15, 15], 5: [20, 20], 6: [25, 20] };

function findNpTable(d: Uint8Array): { bank: number; offsets: number[] } | null {
  for (let b = 0; b + 0x10000 <= d.length; b += 0x10000) {
    const offsets: number[] = [];
    for (let i = 0; b + 3 * i + 3 <= d.length; i++) {
      const v = d[b + 3 * i] | (d[b + 3 * i + 1] << 8) | (d[b + 3 * i + 2] << 16);
      if ((offsets.length && v <= offsets[offsets.length - 1]) || b + v + 2 >= d.length || !NP_SIZES[d[b + v]]) break;
      offsets.push(v);
    }
    // the first record follows the table directly
    if (offsets.length >= 100 && offsets[0] >= 3 * offsets.length && offsets[0] <= 3 * offsets.length + 8) return { bank: b, offsets };
  }
  return null;
}

function readPicrossNp(d: Uint8Array, vol: number, rev: boolean): Pack {
  const t = findNpTable(d);
  if (!t) throw new Error('Puzzle table not found.');
  const puzzles: PackPuzzle[] = [];
  for (const off of t.offsets.slice(2)) {
    const a = t.bank + off, [w, h] = NP_SIZES[d[a]];
    const rows = rowsFromBits(w, h, (x, y) => { const i = y * w + x; return ((d[a + 2 + (i >> 3)] >> (7 - (i & 7))) & 1) === 1; });
    puzzles.push({ id: '', width: w, height: h, rows });
  }
  const levels: PackLevel[] = [];
  for (let s = 0; s * 12 < puzzles.length; s++) {
    levels.push({
      id: `set-${s + 1}`, title: { en: `Set ${s + 1}`, ja: `セット ${s + 1}` }, rules: 'normal',
      puzzles: puzzles.slice(s * 12, s * 12 + 12).map((p, k) => ({ ...p, id: `${s + 1}-${letter(k)}` })),
    });
  }
  return {
    format: 'momogram-pack', version: 1, id: `sfc-picross-np-${vol}`,
    title: { en: `Picross NP Vol. ${vol}`, ja: `ピクロスNP Vol.${vol}` },
    source: { game: `Picross NP Vol. ${vol}`, platform: 'Super Famicom (Nintendo Power)', region: 'JPN', developer: 'Jupiter', year: vol <= 4 ? 1999 : 2000, ...(rev ? { file: 'Rev 1' } : {}) },
    levels,
  };
}

registerImporter({
  name: 'Picross NP (Super Famicom)',
  detect: d => d.length >= 0x10000 && /^PICROSS NP VOL\.\d/.test(sfcHeaderTitle(d)),
  read: async (d, f) => [await sfcWithMusic(readPicrossNp(d, +sfcHeaderTitle(d).match(/VOL\.(\d)/)![1], /rev ?1/i.test(f)), d)],
});
