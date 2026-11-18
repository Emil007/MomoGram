// Game Boy nonogram games by Jupiter.
// Mario's Picross (1995): 32-byte level records (w, h, 15 rows of 16 bits, MSB = left column):
// Easy 64, Kinoko 64, Star 64, Time Trial 64, then the demo puzzle.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { gbPackMusic } from '../../audio/gb/games';

/**
 * Super Game Boy colours of the puzzle screen (lightest, grid, accent = most saturated, darkest), recorded from
 * the SGB palette commands the game sends while a puzzle is shown (colour values only)
 */
const SGB_MARIO = { style: 'gbc' as const, cell: '#ffffff', grid: '#9c4a31', accent: '#d6bd6b', fill: '#313131' };
const SGB_PICROSS2 = { style: 'gbc' as const, cell: '#ffffc5', grid: '#c5b563', accent: '#736b21', fill: '#292919' };

/** the game's own music, played by MomoGram's Game Boy sound emulation (src/audio/gb) */
function withMusic(p: Pack, rom: Uint8Array): Pack {
  let m = null;
  try { m = gbPackMusic(rom); } catch (e) { console.warn('GB music', e); }
  if (m) { p.theme = { ...p.theme, music: m.music }; p.assets = [...(p.assets ?? []), m.asset]; }
  return p;
}

const gbTitle = (d: Uint8Array) => String.fromCharCode(...d.subarray(0x134, 0x143)).replace(/\0.*$/, '').trim();
const isGb = (d: Uint8Array) => d.length >= 0x8000 && d[0x104] === 0xce && d[0x105] === 0xed && d[0x106] === 0x66;

/** longest run of 32-byte records whose header is a square 5/10/15 size */
function findMarioRecords(d: Uint8Array): number {
  let best = -1, bestN = 0;
  for (let o = 0; o + 32 < d.length; o += 2) {
    let n = 0;
    while (o + 32 * n + 32 <= d.length) {
      const w = d[o + 32 * n], h = d[o + 32 * n + 1];
      if (w !== h || (w !== 5 && w !== 10 && w !== 15)) break;
      n++;
    }
    if (n > bestN) { bestN = n; best = o; }
    if (n > 8) o += 32 * n - 2;
  }
  return bestN >= 256 ? best : -1;
}

function readMario(d: Uint8Array, region: string): Pack {
  const base = findMarioRecords(d);
  if (base < 0) throw new Error('Puzzle table not found.');
  const puzzle = (i: number, id: string): PackPuzzle => {
    const o = base + i * 32, w = d[o], h = d[o + 1];
    return { id, width: w, height: h, rows: rowsFromBits(w, h, (x, y) => ((((d[o + 2 + y * 2] << 8) | d[o + 3 + y * 2]) >> (15 - x)) & 1) === 1) };
  };
  const courses: Array<{ key: string; title: Text }> = [
    { key: 'easy', title: { en: 'Easy Picross', de: 'Easy Picross', ja: 'イージーピクロス' } },
    { key: 'kinoko', title: { en: 'Kinoko Course', ja: 'キノココース' } },
    { key: 'star', title: { en: 'Star Course', ja: 'スターコース' } },
    { key: 'time', title: { en: 'Time Trial', ja: 'タイムトライアル' } },
  ];
  const levels: PackLevel[] = [];
  courses.forEach((c, ci) => {
    for (let lv = 0; lv < 8; lv++) {
      const puzzles: PackPuzzle[] = [];
      for (let k = 0; k < 8; k++) puzzles.push(puzzle(ci * 64 + lv * 8 + k, `${c.key}-${lv + 1}${'ABCDEFGH'[k]}`));
      const title: Text = {};
      for (const [l, v] of Object.entries(c.title)) title[l as keyof Text] = `${v} ${lv + 1}`;
      levels.push({ id: `${c.key}-${lv + 1}`, title, rules: 'normal', group: c.key, puzzles });
    }
  });
  (levels as any[]).forEach(l => { const c = courses.find(c => c.key === l.group)!; l.groupTitle = c.title; });
  return {
    format: 'momogram-pack', version: 1, id: 'gb-marios-picross', theme: { palette: SGB_MARIO },
    title: { en: "Mario's Picross", ja: 'マリオのピクロス' },
    source: { game: "Mario's Picross", platform: 'Game Boy', region, developer: 'Jupiter', year: 1995 },
    levels,
  };
}

/** all runs of >= 64 records of 15x15 puzzles (Picross 2 keeps its puzzles in two such tables) */
function findRuns(d: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let o = 0; o + 32 < d.length; o++) {
    let n = 0;
    while (o + 32 * n + 32 <= d.length && d[o + 32 * n] === 15 && d[o + 32 * n + 1] === 15) n++;
    if (n >= 64) { out.push([o, n]); o += 32 * n - 1; }
  }
  return out;
}

// Picross 2 (1996): the 30x30 pictures are played as 15x15 sections; MomoGram imports every section
// as its own puzzle, in the order stored in the game (four consecutive sections per picture).
function readPicross2(d: Uint8Array): Pack {
  const runs = findRuns(d);
  if (!runs.length) throw new Error('Puzzle table not found.');
  const titles: Text[] = [{ en: "Mario's Picross", ja: 'マリオのピクロス' }, { en: "Wario's Picross", ja: 'ワリオのピクロス' }];
  const levels: PackLevel[] = [];
  runs.slice(0, 2).forEach(([base, n], ri) => {
    const all: PackPuzzle[] = [];
    for (let i = 0; i < n; i++) {
      const o = base + i * 32;
      all.push({ id: `${ri ? 'w' : 'm'}-${String(Math.floor(i / 4) + 1).padStart(3, '0')}-${(i % 4) + 1}`, width: 15, height: 15,
        rows: rowsFromBits(15, 15, (x, y) => ((((d[o + 2 + y * 2] << 8) | d[o + 3 + y * 2]) >> (15 - x)) & 1) === 1) });
    }
    for (let k = 0; k * 16 < all.length; k++) {
      const t: Text = {};
      for (const [l, v] of Object.entries(titles[ri])) t[l as keyof Text] = `${v} ${k + 1}`;
      levels.push({ id: `${ri ? 'w' : 'm'}${k + 1}`, title: t, rules: 'normal', group: ri ? 'wario' : 'mario', puzzles: all.slice(k * 16, k * 16 + 16) });
    }
  });
  (levels as any[]).forEach(l => { l.groupTitle = titles[l.group === 'wario' ? 1 : 0]; });
  return {
    format: 'momogram-pack', version: 1, id: 'gb-picross-2', theme: { palette: SGB_PICROSS2 }, title: { en: 'Picross 2', ja: 'ピクロス2' },
    source: { game: 'Picross 2', platform: 'Game Boy', region: 'JPN', developer: 'Jupiter', year: 1996 }, levels,
  };
}

registerImporter({
  name: 'Picross 2 (Game Boy)',
  detect: d => isGb(d) && /^PICROSS 2/.test(gbTitle(d)),
  read: d => [withMusic(readPicross2(d), d)],
});

registerImporter({
  name: "Mario's Picross (Game Boy)",
  detect: d => isGb(d) && /MARIO.?S PICROSS/i.test(gbTitle(d)) && findMarioRecords(d) >= 0,
  read: d => [withMusic(readMario(d, gbTitle(d).includes("'") ? 'USA/EUR' : 'JPN'), d)],
});

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
  read: d => [withMusic(readPokemonPicross(d), d)],
});
