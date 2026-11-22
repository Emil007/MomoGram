// Oekaki Logic 1 and 2 (Super Famicom, Nintendo Power cartridges): header title "OEKAKILOGIC_0n".
//
// Found by tracing the game in an emulator (where puzzle 1 is read from, which RAM holds its solution).
// The puzzles are records, one after the other in chains:
//   width, height, 0, 0
//   name, Shift-JIS, 0-terminated; then a hint, Shift-JIS, 0-terminated
//   palette: 8 colours (BGR555)
//   the picture: height rows of ceil(width / 2) bytes, one nibble per cell (high nibble first):
//   bit 3 = filled, bits 0-2 = the cell's colour in the solved picture
// Each game holds 150 puzzles (5×5 to 20×20) and a demo record (not imported). The modes and levels the game
// sorts them into are not stored with the records, so puzzles are grouped by size, in the order they are stored.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle } from '../format';
import { sfcHeaderTitle } from '../../rom/sfc';

const sjis = new TextDecoder('shift_jis');
const SIZES = new Set([5, 10, 15, 20, 25, 30]);

interface Rec { at: number; w: number; h: number; name: string; pal: number; pic: number; end: number }

/** a 0-terminated Shift-JIS text at p (at most 64 bytes): where it ends */
function textEnd(d: Uint8Array, p: number): number {
  for (let i = p; i < p + 64 && i < d.length; i++) {
    const b = d[i];
    if (b === 0) return i;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) { i++; continue; }
    if (b < 0x20 || b > 0xdf || b === 0x7f) return -1;
  }
  return -1;
}

function recAt(d: Uint8Array, o: number): Rec | null {
  if (o + 6 > d.length) return null;
  const w = d[o], h = d[o + 1];
  if (!SIZES.has(w) || !SIZES.has(h) || d[o + 2] || d[o + 3]) return null;
  const n = textEnd(d, o + 4);
  if (n <= o + 4) return null;
  const t = textEnd(d, n + 1);
  if (t < 0) return null;
  const pal = t + 1, pic = pal + 16, end = pic + h * ((w + 1) >> 1);
  if (end > d.length) return null;
  return { at: o, w, h, name: sjis.decode(d.subarray(o + 4, n)).trim(), pal, pic, end };
}

/** every chain of records: a record starts with its size, then a name in Shift-JIS */
function findRecords(d: Uint8Array): Rec[] {
  const recs: Rec[] = [];
  for (let o = 0; o + 5 < d.length; o++) {
    if (d[o] !== d[o + 1] || d[o + 2] || d[o + 3] || d[o + 4] < 0x81 || d[o + 4] > 0x83) continue;
    const chain: Rec[] = [];
    for (let r = recAt(d, o); r; r = recAt(d, r.end)) chain.push(r);
    if (chain.length >= 3) { recs.push(...chain); o = chain[chain.length - 1].end - 1; }
  }
  return recs;
}

const hex = (v: number) => '#' + [v & 31, (v >> 5) & 31, (v >> 10) & 31].map(c => ((c * 255 / 31) | 0).toString(16).padStart(2, '0')).join('');

function readOekakiLogic(d: Uint8Array, vol: number): Pack {
  const recs = findRecords(d).filter(r => !/^デモ/.test(r.name));
  if (recs.length < 100) throw new Error('Puzzles not found.');
  const bySize = new Map<string, PackPuzzle[]>();
  for (const r of recs) {
    const rb = (r.w + 1) >> 1, cell = (x: number, y: number) => (d[r.pic + y * rb + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15;
    const rows: string[] = [], colours: string[] = [];
    for (let y = 0; y < r.h; y++) {
      let s = '', c = '';
      for (let x = 0; x < r.w; x++) { const v = cell(x, y); s += v & 8 ? '#' : '.'; c += String(v & 7); }
      rows.push(s); colours.push(c);
    }
    if (!rows.some(s => s.includes('#'))) continue;
    const palette = [...Array(8)].map((_, i) => hex(d[r.pal + 2 * i] | (d[r.pal + 2 * i + 1] << 8)));
    const key = `${r.w}x${r.h}`;
    if (!bySize.has(key)) bySize.set(key, []);
    const list = bySize.get(key)!;
    list.push({ id: `${key}-${String(list.length + 1).padStart(2, '0')}`, width: r.w, height: r.h, rows, name: { ja: r.name }, color: { palette, rows: colours } });
  }
  const levels: PackLevel[] = [...bySize.entries()]
    .sort((a, b) => a[1][0].width * a[1][0].height - b[1][0].width * b[1][0].height)
    .map(([key, puzzles]) => ({ id: key, title: { en: key.replace('x', '×') }, rules: 'normal', puzzles }));
  return {
    format: 'momogram-pack', version: 1, id: `sfc-oekaki-logic-${vol}`,
    title: { en: vol === 1 ? 'Oekaki Logic' : `Oekaki Logic ${vol}`, ja: vol === 1 ? 'お絵かきロジック' : `お絵かきロジック${vol}` },
    source: { game: vol === 1 ? 'Oekaki Logic' : `Oekaki Logic ${vol}`, platform: 'Super Famicom (Nintendo Power)', region: 'JPN', developer: 'Sekai Bunka-sha' },
    theme: { palette: { style: 'logic', accent: '#3070c0' } },
    levels,
  };
}

registerImporter({
  name: 'Oekaki Logic (Super Famicom)',
  version: 1, // raise when the importer reads more or reads differently
  detect: d => /^OEKAKILOGIC_0\d/.test(sfcHeaderTitle(d)),
  read: d => [readOekakiLogic(d, +sfcHeaderTitle(d).slice(12, 14))],
});
