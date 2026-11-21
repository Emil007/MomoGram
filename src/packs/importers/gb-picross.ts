// Game Boy nonogram games by Jupiter that store each puzzle as a 32-byte record.
//
// Record: width, height, then 15 rows of 16 bits (most significant bit = left column).
//
//  Game                         File (recognised by)                 Puzzles
//  Mario's Picross (USA/EUR)    header title "MARIO'S PICROSS"       longest run of records sized 5/10/15 (>= 256):
//  Mario no Picross (JPN)       header title "MARIO.S PICROSS"         Easy 64, Kinoko 64, Star 64, Time Trial 64
//  Picross 2 (JPN)              header title "PICROSS 2"             the two runs of >= 64 15x15 records (Mario, Wario),
//                                                                      four records = one 30x30 picture
// Colours: the Super Game Boy palette the game uses on the puzzle screen. Music: src/audio/gb/games.ts.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { isGb, gbTitle, gbWithMusic } from '../../rom/gb';

/**
 * Super Game Boy colours of the puzzle screen (lightest, grid, accent = most saturated, darkest), recorded from
 * the SGB palette commands the game sends while a puzzle is shown (colour values only)
 */
const SGB_MARIO = { style: 'gbc' as const, cell: '#ffffff', grid: '#9c4a31', accent: '#d6bd6b', fill: '#313131' };
const SGB_PICROSS2 = { style: 'gbc' as const, cell: '#ffffc5', grid: '#c5b563', accent: '#736b21', fill: '#292919' };

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
  version: 2, // raise when the importer reads more or reads differently
  detect: d => isGb(d) && /^PICROSS 2/.test(gbTitle(d)),
  read: d => [gbWithMusic(readPicross2(d), d)],
});

registerImporter({
  name: "Mario's Picross (Game Boy)",
  version: 2, // raise when the importer reads more or reads differently
  detect: d => isGb(d) && /MARIO.?S PICROSS/i.test(gbTitle(d)) && findMarioRecords(d) >= 0,
  read: d => [gbWithMusic(readMario(d, gbTitle(d).includes("'") ? 'USA/EUR' : 'JPN'), d)],
});
