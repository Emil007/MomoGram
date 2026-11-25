// Nonogram by Kimbuja (Android): 25 × 25 puzzles, one file each.
//
//   Package               Version  Files                                   Puzzles
//   com.kimbuja.nonogram  1.55     assets/data/<set><NNN>, 12 500 bytes    476: B (Beginner) 277, E (Easy) 64,
//                                                                          N (Normal) 78, H (Hard) 57
//
// A file is 625 cells of 5 little-endian int32 each, row by row; the third is 1 for a filled cell.
import { registerAndroidGame, isPuzzle } from './android';
import { PackLevel, rowsFromBits, Text } from '../format';

const SETS: Array<[string, Text]> = [
  ['B', { en: 'Beginner', de: 'Anfänger', fr: 'Débutant', it: 'Principiante', es: 'Principiante' }],
  ['E', { en: 'Easy', de: 'Leicht', fr: 'Facile', it: 'Facile', es: 'Fácil' }],
  ['N', { en: 'Normal', de: 'Normal', fr: 'Normal', it: 'Normale', es: 'Normal' }],
  ['H', { en: 'Hard', de: 'Schwer', fr: 'Difficile', it: 'Difficile', es: 'Difícil' }],
];

registerAndroidGame({
  name: 'Nonogram by Kimbuja (Android)', version: 3, pkg: 'com.kimbuja.nonogram', versions: ['1.55'],
  read(apk) {
    const levels: PackLevel[] = [];
    for (const [set, title] of SETS) {
      const files = apk.names.filter(n => new RegExp(`^assets/data/${set}\\d{3}$`).test(n)).sort();
      const puzzles = files.flatMap(n => {
        const d = apk.get(n);
        if (!d || d.length !== 12500) return [];
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const rows = rowsFromBits(25, 25, (x, y) => dv.getInt32(((y * 25 + x) * 5 + 2) * 4, true) === 1);
        return isPuzzle(rows) ? [{ id: n.slice(12), width: 25, height: 25, rows }] : [];
      });
      // the Beginner set is long: two levels
      for (let i = 0, k = 1; i < puzzles.length; i += 150, k++) {
        const part = puzzles.length > 150 ? Object.fromEntries(Object.entries(title).map(([l, s]) => [l, `${s} ${k}`])) : title;
        levels.push({ id: set + (k > 1 ? k : ''), title: part, group: 'main', rules: 'normal', puzzles: puzzles.slice(i, i + 150) });
      }
    }
    if (!levels.length) throw new Error('no puzzles found');
    return [{
      format: 'momogram-pack', version: 1, id: 'android-kimbuja-nonogram', title: { en: 'Nonogram (Kimbuja)' },
      source: { game: 'Nonogram', platform: 'Android', developer: 'Kimbuja' }, levels,
      theme: {
        palette: {
          style: 'logic', accent: '#dc1b1b', fill: '#2a1010', cell: '#fff5f5', bg: '#f8e8e8',
          grid: '#d08080', clue: '#401010', cursor: '#ff6060', cross: '#c04040',
          board: {
            clueArea: '#f8e8e8', clueAreaAlt: '#f0d8d8', clueBg: '#f0c8c8', clueBgAlt: '#fff5f5',
            grid5: '#dc1b1b', bg: '#fff5f5', cell: '#fff5f5', clueFocusBg: '#ff606088',
          },
          screen: { bg: '#f0d8d8', panel: '#fff5f5', top: '#e8a0a0' },
        },
      },
    }];
  },
});
