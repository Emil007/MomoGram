// Game Boy Picross games.
// Mario's Picross (1995): 32-byte level records (w, h, 15 rows of 16 bits, MSB = left column):
// Easy 64, Kinoko 64, Star 64, Time Trial 64, then the demo puzzle.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { gbPackMusic } from '../../audio/gb/games';

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
    format: 'momogram-pack', version: 1, id: 'gb-marios-picross', theme: { palette: { accent: '#4d533c', style: 'dmg' } },
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
    format: 'momogram-pack', version: 1, id: 'gb-picross-2', theme: { palette: { accent: '#4d533c', style: 'dmg' } }, title: { en: 'Picross 2', ja: 'ピクロス2' },
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
