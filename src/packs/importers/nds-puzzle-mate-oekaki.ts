// Puzzle Mate DS: Oekaki Mate (Compile Heart, Nintendo DS).
//
//  Game                                   File (recognised by)    Puzzles
//  Puzzle Mate DS - Oekaki Mate           game code YX9J          question_data_op.arc: 460 records, "1001" …
//
// A record: four ASCII digits (its number) and 12 zero bytes; four u32: the board's width and height including
// the clues, the width of the row clues and the height of the column clues; 32 bytes we don't need; then the
// board, one u16 per cell, row by row: the column clues on top, the row clues on the left, and the picture
// (0x41 = filled); then the puzzle's name (Shift-JIS, zero-terminated). Every puzzle read is checked: the clues on
// the board must be the picture's clues.
// Numbers 1xxx are the easy puzzles, 2xxx the middle ones, 3xxx the hard ones; 3101-3110 are colour puzzles
// (Colour mode): their 32 bytes after the sizes are u32 colour count, then the colours as r, g, b (0-31), 255;
// a cell is colour k as k << 8, a clue number n of colour k as (k << 8) | n.
// Music: sound_data.sdat.
import { registerImporter } from './index';
import { PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic, u16, u32 } from '../../rom/nds';
import { Sdat } from '../../audio/sdat';
import { colorClues } from '../../game/color';

const runs = (l: boolean[]) => { const out: number[] = []; let r = 0; for (const v of l) { if (v) r++; else if (r) { out.push(r); r = 0; } } if (r) out.push(r); return out; };

type ArcPuzzle = { id: string; w: number; h: number; cells: boolean[]; name: string; colors?: string[]; colorCells?: number[] };
function readArc(d: Uint8Array): ArcPuzzle[] {
  const out: ArcPuzzle[] = [];
  const isHead = (o: number) => o + 32 <= d.length && [0, 1, 2, 3].every(i => d[o + i] >= 0x30 && d[o + i] <= 0x39) && [...d.subarray(o + 4, o + 16)].every(b => b === 0);
  const heads: number[] = [];
  for (let o = 0; o < d.length - 32; o++) if (isHead(o)) heads.push(o);
  heads.forEach((h, i) => {
    const end = heads[i + 1] ?? d.length;
    const bw = u32(d, h + 16), bh = u32(d, h + 20), a = u32(d, h + 24), b = u32(d, h + 28);
    const W = bw - a, H = bh - b, g = h + 32 + 32; // the board starts 16 words after the sizes
    if (W < 5 || H < 5 || W > 60 || H > 60 || g + bw * bh * 2 > end) return;
    const at = (x: number, y: number) => u16(d, g + (y * bw + x) * 2);
    const cells: boolean[] = [], colorCells: number[] = [];
    let colour = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = at(a + x, b + y);
      if (v >= 0x100 && !(v & 0xff) && v <= 0x800) { colour = true; cells.push(true); colorCells.push(v >> 8); continue; }
      if (v !== 0 && v !== 0x41) return;
      cells.push(v === 0x41); colorCells.push(0);
    }
    if (colour) {
      // colour puzzle: the colours from the header, the clues checked with their colours
      const k = u32(d, h + 32);
      if (!k || k > 6) return;
      const colors = [...Array(k)].map((_, i) => '#' + [0, 1, 2].map(j => Math.round(d[h + 36 + i * 4 + j] * 255 / 31).toString(16).padStart(2, '0')).join(''));
      const key = (l: number[]) => colorClues(l).map(c => `${c.c + 1}:${c.n}`).join();
      for (let y = 0; y < H; y++) {
        const c = [...Array(a)].map((_, x) => at(x, b + y)).filter(v => v).map(v => `${v >> 8}:${v & 0xff}`).join();
        if (c !== key(colorCells.slice(y * W, y * W + W))) return;
      }
      for (let x = 0; x < W; x++) {
        const c = [...Array(b)].map((_, y) => at(a + x, y)).filter(v => v).map(v => `${v >> 8}:${v & 0xff}`).join();
        if (c !== key([...Array(H)].map((_, y) => colorCells[y * W + x]))) return;
      }
      const s = g + bw * bh * 2;
      let e = s;
      while (e < end && d[e]) e++;
      out.push({ id: String.fromCharCode(...d.subarray(h, h + 4)), w: W, h: H, cells, colors, colorCells, name: new TextDecoder('shift_jis').decode(d.subarray(s, e)).trim() });
      return;
    }
    // the clues on the board must be this picture's
    for (let y = 0; y < H; y++) {
      const c = [...Array(a)].map((_, x) => at(x, b + y)).filter(v => v);
      if (c.join() !== runs(cells.slice(y * W, y * W + W)).join()) return;
    }
    for (let x = 0; x < W; x++) {
      const c = [...Array(b)].map((_, y) => at(a + x, y)).filter(v => v);
      if (c.join() !== runs([...Array(H)].map((_, y) => cells[y * W + x])).join()) return;
    }
    const s = g + bw * bh * 2;
    let e = s;
    while (e < end && d[e]) e++;
    out.push({ id: String.fromCharCode(...d.subarray(h, h + 4)), w: W, h: H, cells, name: new TextDecoder('shift_jis').decode(d.subarray(s, e)).trim() });
  });
  return out;
}

const GROUPS: Record<string, { en: string; ja: string }> = { 1: { en: 'Beginner', ja: '初級' }, 2: { en: 'Intermediate', ja: '中級' }, 3: { en: 'Advanced', ja: '上級' } };

registerImporter({
  name: 'Puzzle Mate DS: Oekaki Mate (DS)',
  version: 2, // raise when the importer reads more or reads differently
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.startsWith('YX9'),
  read: d => {
    const rom = new NdsRom(d);
    const arc = rom.fileByName('question_data_op.arc');
    if (!arc) throw new Error('Puzzles not found.');
    const levels: PackLevel[] = [];
    for (const p of readArc(arc)) {
      const group = p.id[0];
      const pz: PackPuzzle = { id: p.id, width: p.w, height: p.h, rows: rowsFromBits(p.w, p.h, (x, y) => p.cells[y * p.w + x]) };
      if (p.colors && p.colorCells) {
        pz.colorGame = true; pz.colorOnly = true;
        pz.color = { palette: p.colors, rows: [...Array(p.h)].map((_, y) => p.colorCells!.slice(y * p.w, y * p.w + p.w).map(v => (v ? String(v - 1) : '.')).join('')) };
      }
      if (p.name) pz.name = { ja: p.name };
      const same = levels.filter(l => l.group === group);
      let lv = same[same.length - 1];
      if (!lv || lv.puzzles.length >= 25) {
        const n = same.length + 1, gt = GROUPS[group] ?? { en: 'Puzzles', ja: '問題' };
        lv = { id: `g${group}-${n}`, group, groupTitle: gt, title: { en: `${gt.en} ${n}`, ja: `${gt.ja} ${n}` }, rules: 'normal', puzzles: [] };
        levels.push(lv);
      }
      lv.puzzles.push(pz);
    }
    if (!levels.length) throw new Error('Puzzles not found.');
    let seqs: string[] = [];
    try { seqs = new Sdat(rom.fileByName('sound_data.sdat')!).seqs.filter(s => s.fileId >= 0).map(s => s.name); } catch { /* no music */ }
    const bgm = seqs.filter(s => /bgm/i.test(s));
    const list = bgm.length ? bgm : seqs;
    const music = ndsMusic(rom, 'sound_data.sdat', { title: list[0], menu: list[0], play: list[1] ?? list[0] }, list.slice(1, 4));
    if (music.theme.music) music.theme.songs = list.map(s => 'sound.sdat#' + s);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: 'nds-puzzle-mate-oekaki-mate',
      title: { en: 'Puzzle Mate DS: Oekaki Mate', ja: 'パズルメイトDS おえかきメイト' },
      source: { game: 'Puzzle Mate DS: Oekaki Mate', platform: 'Nintendo DS', region: 'JPN', developer: 'Compile Heart' },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, assets: music.assets,
      theme: { ...music.theme, palette: { style: 'logic', accent: '#3a9ad8', cursor: '#7cc4f0', fill: '#2a3448', grid5: '#3a9ad8' } },
    }];
  },
});
