// Illu-Logi VOW (Success, Nintendo DS, 2008).
//
//  Game              File (recognised by)    Puzzles
//  Illu-Logi VOW     game code A8IJ          Data/ilNNNNNN.zil, one file per puzzle: 1-100, 1001-1100 and
//                                              2001-2100 are the three levels (mono and colour puzzles taking
//                                              turns), 99999x a few extra ones. 139 mono puzzles are imported;
//                                              the colour ones (Colour Logic) need colour clues, not supported yet.
//
// ZIL file: "ZIL\0", u16 3, u8 width, u8 height, u8 colours (1 = a normal puzzle), 11 bytes 0, then one row
//   after another, ceil(3 × width / 8) bytes each: 3 bits per cell, least significant bit first, 0 = empty,
//   otherwise the cell's colour.
// Music: Sound/sound_data.sdat (title, main menu and the ten puzzle-screen "skins").
import { registerImporter } from './index';
import { PackLevel, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic } from '../../rom/nds';

const LEVELS = [
  { from: 1, to: 999, id: 'level-1', en: 'Level 1', ja: 'レベル1' },
  { from: 1001, to: 1999, id: 'level-2', en: 'Level 2', ja: 'レベル2' },
  { from: 2001, to: 2999, id: 'level-3', en: 'Level 3', ja: 'レベル3' },
  { from: 3000, to: 999999, id: 'extra', en: 'Extra', ja: 'エクストラ' },
];

registerImporter({
  name: 'Illu-Logi VOW (DS)',
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.startsWith('A8I'),
  read: d => {
    const rom = new NdsRom(d);
    const files = rom.fileNames().filter(n => /^Data\/il\d+\.zil$/.test(n)).sort();
    const levels: PackLevel[] = LEVELS.map(l => ({ id: l.id, title: { en: l.en, ja: l.ja }, rules: 'normal', puzzles: [] }));
    for (const name of files) {
      const z = rom.fileByName(name)!, num = parseInt(name.slice(7));
      if (z[0] !== 0x5a || z[1] !== 0x49 || z[2] !== 0x4c || z[8] !== 1) continue; // "ZIL", one colour
      const w = z[6], h = z[7], bpr = Math.ceil(3 * w / 8);
      const cell = (x: number, y: number) => { const b = 3 * x, o = 0x14 + y * bpr + (b >> 3); return ((z[o] | (z[o + 1] << 8)) >> (b & 7)) & 7; };
      const li = LEVELS.findIndex(l => num >= l.from && num <= l.to);
      levels[li].puzzles.push({ id: `il${num}`, width: w, height: h, rows: rowsFromBits(w, h, (x, y) => cell(x, y) !== 0) });
    }
    const used = levels.filter(l => l.puzzles.length);
    if (!used.length) throw new Error('Puzzles not found.');
    const skins = Array.from({ length: 10 }, (_, i) => `SEQ_BGM_SKIN_${String(i + 1).padStart(2, '0')}`);
    const music = ndsMusic(rom, 'Sound/sound_data.sdat', { title: 'SEQ_BGM_ITITLE', menu: 'SEQ_BGM_MAINMENU', play: skins[0] }, skins);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: 'nds-illu-logi-vow', title: { en: 'Illu-Logi VOW', ja: 'イラロジVOW' },
      source: { game: 'Illu-Logi VOW', platform: 'Nintendo DS', region: 'JPN', developer: 'Success', year: 2008 },
      levels: used, icon: px ? makeIcon(32, 32, px) : undefined, theme: music.theme, assets: music.assets,
    }];
  },
});
