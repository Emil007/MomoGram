// SIMPLE DS Series Vol. 7 / Vol. 28: THE Illust Puzzle & Suuji Puzzle (1, 2) (D3 Publisher, Nintendo DS).
//
//  Game                                   File (recognised by)    Puzzles
//  Vol. 7 THE イラストパズル＆数字パズル     game code AZIJ          data/numclo0-9.data (100 each) + numclo_00-03
//  Vol. 28 THE イラストパズル＆数字パズル2   game code YZIJ          the same files, other puzzles in numclo0-9
//
// "numclo" files: the text "str_numclo", then records of 77 bytes: the size (width << 4 | height: 0xAA 10×10,
// 0xDD 13×13, 0xFF 15×15), one byte (0), and 75 bytes of cells, three cells per byte in base 6 (lowest digit
// first): 0 empty, 1-5 a colour. The cells are a 15×15 grid, row by row; the puzzle is its top-left part.
// The pictures are coloured; MomoGram plays them as ordinary nonograms (every coloured cell filled) and shows
// the colours as the solved picture. numclo_seikaiN.dat: the names of file N's puzzles (Shift-JIS, one per line).
// (The EU version, Essential Sudoku DS, has only the number puzzles.)
// Music: data/sound_data.sdat.
import { registerImporter } from './index';
import { PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic } from '../../rom/nds';
import { Sdat } from '../../audio/sdat';

/** the game's five colours (red, green, blue, yellow, black) */
const COLOURS = ['#d83a30', '#2f9a3c', '#2f55d0', '#e8b01e', '#202020'];

function readFile(d: Uint8Array): Array<{ w: number; h: number; cells: number[] }> {
  const out: Array<{ w: number; h: number; cells: number[] }> = [];
  // after the name "str_numclo"
  for (let o = 10; o + 77 <= d.length; o += 77) {
    const w = d[o] >> 4, h = d[o] & 15;
    if (w < 5 || h < 5 || d[o + 1] !== 0) break;
    const cells: number[] = [];
    for (let i = 0; i < 75; i++) { const b = d[o + 2 + i]; cells.push(b % 6, Math.floor(b / 6) % 6, Math.floor(b / 36)); }
    if (cells.some(c => c)) out.push({ w, h, cells });
  }
  return out;
}

const VOLS: Record<string, { id: string; vol: number; ja: string }> = {
  AZI: { id: 'nds-simple-ds-7-illust-puzzle', vol: 7, ja: 'SIMPLE DS Vol.7 THE イラストパズル' },
  YZI: { id: 'nds-simple-ds-28-illust-puzzle-2', vol: 28, ja: 'SIMPLE DS Vol.28 THE イラストパズル2' },
};

registerImporter({
  name: 'SIMPLE DS: THE Illust Puzzle (DS)',
  version: 2, // raise when the importer reads more or reads differently
  detect: d => NdsRom.looksLike(d) && !!VOLS[new NdsRom(d).gameCode.slice(0, 3)],
  read: d => {
    const rom = new NdsRom(d);
    const game = VOLS[rom.gameCode.slice(0, 3)];
    const levels: PackLevel[] = [];
    const books: Array<[string, string | null, { en: string; ja: string }]> = [
      ...[...Array(10)].map((_, n) => [`data/numclo${n}.data`, `data/numclo_seikai0${n}.dat`, { en: `Book ${n + 1}`, ja: `第${n + 1}巻` }] as [string, string, { en: string; ja: string }]),
      ...[...Array(4)].map((_, n) => [`data/numclo_0${n}.data`, null, { en: `Extra ${n + 1}`, ja: `おまけ ${n + 1}` }] as [string, null, { en: string; ja: string }]),
    ];
    books.forEach(([file, names, title], b) => {
      const f = rom.fileByName(file);
      if (!f) return;
      const list = readFile(f);
      const nm = names ? new TextDecoder('shift_jis').decode(rom.fileByName(names) ?? new Uint8Array()).split(/\r?\n/) : [];
      const group = `b${b + 1}`;
      // a level per size within the book (25 puzzles at most)
      list.forEach((p, i) => {
        const pz: PackPuzzle = {
          id: `${group}-${String(i + 1).padStart(3, '0')}`, width: p.w, height: p.h,
          rows: rowsFromBits(p.w, p.h, (x, y) => p.cells[y * 15 + x] > 0),
          colorGame: true, color: { palette: COLOURS, rows: [...Array(p.h)].map((_, y) => [...Array(p.w)].map((_, x) => { const c = p.cells[y * 15 + x]; return c ? String(c - 1) : '.'; }).join('')) },
        };
        if (nm[i]?.trim()) pz.name = { ja: nm[i].trim() };
        const sz = `${p.w}x${p.h}`;
        const same = levels.filter(l => l.group === group && l.id.startsWith(`${group}-${sz}-`));
        let lv = same[same.length - 1];
        if (!lv || lv.puzzles.length >= 25) {
          const t = `${p.w}×${p.h}` + (same.length ? ` (${same.length + 1})` : '');
          lv = { id: `${group}-${sz}-${same.length + 1}`, group, groupTitle: title, title: { en: t, ja: t }, rules: 'normal', puzzles: [] };
          levels.push(lv);
        }
        lv.puzzles.push(pz);
      });
    });
    if (!levels.length) throw new Error('Puzzles not found.');
    // the songs are only numbered (SEQ_01 …): all of them are offered, the first one for the menus
    let seqs: string[] = [];
    try { seqs = new Sdat(rom.fileByName('data/sound_data.sdat')!).seqs.filter(s => s.fileId >= 0).map(s => s.name); } catch { /* no music */ }
    const music = ndsMusic(rom, 'data/sound_data.sdat', { title: seqs[0], menu: seqs[0], play: seqs[1] }, seqs.slice(1, 4));
    if (music.theme.music) music.theme.songs = seqs.map(s => 'sound.sdat#' + s);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: game.id,
      title: { en: `SIMPLE DS Vol. ${game.vol}: THE Illust Puzzle${game.vol === 28 ? ' 2' : ''}`, ja: game.ja },
      source: { game: `SIMPLE DS Series Vol. ${game.vol}`, platform: 'Nintendo DS', region: 'JPN', developer: 'D3 Publisher' },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, assets: music.assets,
      theme: { ...music.theme, palette: { style: 'logic', accent: '#e8862a', cursor: '#f4b060', fill: '#3a3a48', grid5: '#e8862a' } },
    }];
  },
});
