// Puzzle Iro Iro: Gekkan Crossword House Vol. 1-6 (Nintendo, DSiWare): monthly puzzle issues; each has three
// picture logic puzzles (30×35) among crosswords and number puzzles.
//
//  Game                                   File (recognised by)    Puzzles
//  Puzzle Iro Iro Vol. 1 … Vol. 6         game codes KX7J, KX8J, KX9J, KXXJ, KXYJ, KXZJ   question.bin
//
// question.bin: "BVSC", u32 at 8: the number of entries, from 16 on: offset and size of each (LZ11). An entry
// starts with its kind (4 = picture logic), the width at 6, the height at 7; from 12: the clues (first the
// rows, then the columns; 32 bytes each: u16 count, then the numbers), then the solution, one byte per cell.
// Every puzzle is checked against its clues. Music: sound_data.sdat.
import { registerImporter } from './index';
import { PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic, u32 } from '../../rom/nds';
import { lz11 } from '../../rom/ctr';
import { Sdat } from '../../audio/sdat';

const VOLS: Record<string, number> = { KX7: 1, KX8: 2, KX9: 3, KXX: 4, KXY: 5, KXZ: 6 };
const runs = (l: boolean[]) => { const out: number[] = []; let r = 0; for (const v of l) { if (v) r++; else if (r) { out.push(r); r = 0; } } if (r) out.push(r); return out; };

registerImporter({
  name: 'Puzzle Iro Iro (DSiWare)',
  version: 1, // raise when the importer reads more or reads differently
  detect: d => NdsRom.looksLike(d) && !!VOLS[new NdsRom(d).gameCode.slice(0, 3)],
  read: d => {
    const rom = new NdsRom(d);
    const vol = VOLS[rom.gameCode.slice(0, 3)];
    const q = rom.fileByName(rom.fileNames().find(n => n.endsWith('question.bin')) ?? '');
    if (!q || String.fromCharCode(...q.subarray(0, 4)) !== 'BVSC') throw new Error('Puzzles not found.');
    const puzzles: PackPuzzle[] = [];
    const n = u32(q, 8);
    for (let i = 0; i < n; i++) {
      const o = u32(q, 16 + i * 8), s = u32(q, 20 + i * 8);
      let e: Uint8Array;
      try { e = lz11(q.subarray(o, o + s)); } catch { continue; }
      if (e[0] !== 4) continue;
      const w = e[6], h = e[7], sol = 12 + (w + h) * 32;
      if (w < 5 || h < 5 || sol + w * h > e.length) continue;
      const cell = (x: number, y: number) => e[sol + y * w + x] === 1;
      const clue = (k: number) => [...e.subarray(12 + k * 32 + 2, 12 + k * 32 + 2 + (e[12 + k * 32] | e[13 + k * 32] << 8))];
      let ok = true;
      for (let x = 0; x < w && ok; x++) ok = clue(h + x).join() === runs([...Array(h)].map((_, y) => cell(x, y))).join();
      for (let y = 0; y < h && ok; y++) ok = clue(y).join() === runs([...Array(w)].map((_, x) => cell(x, y))).join();
      if (!ok) continue;
      puzzles.push({ id: `q${puzzles.length + 1}`, width: w, height: h, rows: rowsFromBits(w, h, cell) });
    }
    if (!puzzles.length) throw new Error('Puzzles not found.');
    const levels: PackLevel[] = [{ id: 'illust-logic', title: { en: 'Illust Logic', ja: 'イラストロジック' }, rules: 'normal', puzzles }];
    let seqs: string[] = [];
    try { seqs = new Sdat(rom.fileByName('sound_data.sdat')!).seqs.filter(s => s.fileId >= 0).map(s => s.name); } catch { /* no music */ }
    const bgm = seqs.filter(s => /bgm/i.test(s)), list = bgm.length ? bgm : seqs;
    const music = ndsMusic(rom, 'sound_data.sdat', { title: list[0], menu: list[0], play: list[1] ?? list[0] }, list.slice(1, 4));
    if (music.theme.music) music.theme.songs = list.map(s => 'sound.sdat#' + s);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: `dsi-puzzle-iro-iro-${vol}`,
      title: { en: `Puzzle Iro Iro Vol. ${vol}`, ja: `パズルいろいろ Vol.${vol}` },
      source: { game: `Puzzle Iro Iro: Gekkan Crossword House Vol. ${vol}`, platform: 'DSiWare', region: 'JPN', developer: 'Nintendo' },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, assets: music.assets,
      theme: { ...music.theme, palette: { style: 'logic', accent: '#d8508a', cursor: '#f090b8', fill: '#2a2f40', grid5: '#d8508a' } },
    }];
  },
});
