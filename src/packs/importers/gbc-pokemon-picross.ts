// Pokémon Picross for Game Boy Color: the unreleased 1999 prototype (header title "POKEPICROSS").
// Puzzles are stored as pictures, see below. Music: src/audio/gb/games.ts.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { isGb, gbTitle, gbWithMusic } from '../../rom/gb';

// ---- Pokémon Picross (Game Boy Color, unreleased 1999 prototype) ----
// The stage number indexes a table of 16-bit pointers at the start of a ROM bank (the bank is the value
// the loader at 0:2B7F writes to the MBC). A stage record is: size class, two bytes, palettes (0x11 bytes
// in all), 30 bytes, then bank + pointer of an attribute map and bank + pointer of each section's picture.
// Pictures are 45x45 pixels, one byte per pixel, RLE packed (byte with bit 0 set: value & 0xFC repeated
// [next byte] times; bit 1 set: end; else a literal). A puzzle cell is a 3x3 pixel block and is filled when
// bit 7 of any of its pixels is set. Size classes: 0 = 10x10, 1 = 15x15, 2 = 20x20 in four 10x10
// sections, 3 = 30x30 in four 15x15 sections (played one section after the other, like Picross 2).
// Stages 0-165 are the main game (165 is Mew), 166 (Togepi) is unused, 167-217 are the Safari Zone,
// 218-221 are unused stages and the rest are empty placeholders.
function pokemonTableBank(d: Uint8Array): number {
  const sig = [0xea, 0x15, 0xc3, 0xea, 0x00, 0x20, 0x78, 0xea, 0xe4, 0xdb, 0xfa, 0x25, 0xd6];
  for (let o = 2; o + sig.length < Math.min(d.length, 0x4000); o++) {
    if (d[o - 2] === 0x3e && sig.every((v, k) => d[o + k] === v)) return d[o - 1];
  }
  return -1;
}

function rlePictures(d: Uint8Array, off: number): Uint8Array {
  const out: number[] = [];
  for (let p = off; p < d.length && out.length < 0x1000;) {
    const a = d[p++];
    if (a & 1) { const n = d[p++]; for (let k = 0; k < n; k++) out.push(a & 0xfc); }
    else if (a & 2) break;
    else out.push(a);
  }
  return Uint8Array.from(out);
}

function readPokemonPicross(d: Uint8Array): Pack {
  const bank = pokemonTableBank(d);
  if (bank < 0) throw new Error('Puzzle table not found.');
  const base = bank * 0x4000, at = (b: number, ptr: number) => b * 0x4000 + (ptr - 0x4000);
  const stage = (i: number): PackPuzzle[] => {
    const ptr = d[base + 2 * i] | (d[base + 2 * i + 1] << 8);
    const r = at(bank, ptr), cls = d[r];
    const size = cls === 0 || cls === 2 ? 10 : 15, count = cls >= 2 ? 4 : 1;
    const q = r + 0x11 + 30 + 3;
    const out: PackPuzzle[] = [];
    for (let k = 0; k < count; k++) {
      const pic = rlePictures(d, at(d[q + 3 * k], d[q + 3 * k + 1] | (d[q + 3 * k + 2] << 8)));
      const cell = (x: number, y: number) => {
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) if ((pic[(3 * y + dy) * 45 + 3 * x + dx] ?? 0) & 0x80) return true;
        return false;
      };
      out.push({ id: `s${String(i + 1).padStart(3, '0')}${count > 1 ? '-' + (k + 1) : ''}`, width: size, height: size, rows: rowsFromBits(size, size, cell) });
    }
    return out;
  };
  const levels: PackLevel[] = [];
  const part = (key: string, title: Text, from: number, to: number) => {
    for (let s = from, n = 1; s <= to; s += 8, n++) {
      const puzzles: PackPuzzle[] = [];
      for (let i = s; i <= Math.min(to, s + 7); i++) puzzles.push(...stage(i));
      levels.push({ id: `${key}${n}`, title: withSuffix(title, `${n}`), rules: 'normal', group: key, puzzles });
    }
  };
  const main: Text = { en: 'Pokémon Picross', ja: 'ポケモンピクロス' }, safari: Text = { en: 'Safari Zone', ja: 'サファリゾーン' };
  part('main', main, 0, 165);
  part('safari', safari, 167, 217);
  (levels as any[]).forEach(l => { l.groupTitle = l.group === 'main' ? main : safari; });
  return {
    format: 'momogram-pack', version: 1, id: 'gbc-pokemon-picross',
    // the puzzle screen (from screenshots): white cells, lavender grid, dark blue filled cells, gold and white stripes
    theme: { palette: { style: 'gbc', accent: '#c8a800', cell: '#ffffff', grid: '#a5a5ff', fill: '#3a3aa5', board: { clueBg: '#e6c832', clueBgAlt: '#ffffff', clueArea: '#ffffff', grid5: '#3a3aa5', cross: '#202020', clue: '#000000', clueDone: '#a5a5ff', bg: '#ffffff' }, screen: { bg: '#f4ecb0', top: '#efd600' } } },
    title: { en: 'Pokémon Picross (GBC prototype)', ja: 'ポケモンピクロス' },
    source: { game: 'Pokémon Picross', platform: 'Game Boy Color', region: 'JPN', developer: 'Jupiter', year: 1999 },
    levels,
  };
}

function withSuffix(t: Text, suffix: string): Text {
  const o: Text = {};
  for (const [l, v] of Object.entries(t)) o[l as keyof Text] = `${v} ${suffix}`;
  return o;
}

registerImporter({
  name: 'Pokémon Picross (Game Boy Color)',
  detect: d => isGb(d) && /^POKEPICROSS/.test(gbTitle(d)),
  read: d => [gbWithMusic(readPokemonPicross(d), d)],
});
