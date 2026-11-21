// Hello Kitty no Paku Paku & Logic (Nintendo DS): a maze game and a picture logic game on one card.
//
//  Game                                   File (recognised by)    Puzzles
//  Hello Kitty no Paku Paku & Logic       game code BHKJ          image/LogicQuestion/NNN_b.bmp (001-100) and
//                                                                   EXNN_b.bmp (EX01-EX22): one picture per puzzle,
//                                                                   5×5, 10×10 or 15×15
//
// The pictures are ordinary 24-bit BMP files, one pixel per cell: the dark colour is filled.
// (image/logic_game/*_question/ holds 30 more pictures that the game doesn't use.)
// Music: sound/KPZ-DS.sdat.
import { registerImporter } from './index';
import { PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic, u16, u32 } from '../../rom/nds';

/** a BMP's pixels, top row first, as brightness 0-765 */
function bmp(b: Uint8Array): { w: number; h: number; px: (x: number, y: number) => number } | null {
  if (b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const off = u32(b, 10), w = u32(b, 18), hs = u32(b, 22) | 0, bpp = u16(b, 28), h = Math.abs(hs);
  if (bpp !== 24 || !w || !h || w > 64 || h > 64) return null;
  const stride = Math.ceil(w * 3 / 4) * 4;
  return { w, h, px: (x, y) => { const o = off + (hs > 0 ? h - 1 - y : y) * stride + x * 3; return b[o] + b[o + 1] + b[o + 2]; } };
}

registerImporter({
  name: 'Hello Kitty no Paku Paku & Logic (DS)',
  version: 2, // raise when the importer reads more or reads differently
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.startsWith('BHK'),
  read: d => {
    const rom = new NdsRom(d);
    const files = rom.fileNames().filter(n => /^image\/LogicQuestion\/(\d{3}|EX\d\d)_b\.bmp$/.test(n)).sort();
    const levels: PackLevel[] = [];
    for (const name of files) {
      const img = bmp(rom.fileByName(name)!);
      if (!img) continue;
      const key = name.match(/(\d{3}|EX\d\d)_b/)![1];
      let dark = Infinity;
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) dark = Math.min(dark, img.px(x, y));
      const pz: PackPuzzle = { id: key.toLowerCase(), width: img.w, height: img.h, rows: rowsFromBits(img.w, img.h, (x, y) => img.px(x, y) === dark) };
      // ten questions per level, the extra questions last
      const ex = key.startsWith('EX'), n = parseInt(key.replace('EX', ''));
      const lid = ex ? 'ex' : `q${Math.floor((n - 1) / 10) + 1}`;
      let lv = levels.find(l => l.id === lid);
      if (!lv) {
        const a = ex ? 0 : Math.floor((n - 1) / 10) * 10 + 1;
        lv = { id: lid, title: ex ? { en: 'Extra', ja: 'エクストラ' } : { en: `Questions ${a}–${a + 9}`, ja: `問題 ${a}～${a + 9}` }, rules: 'normal', puzzles: [] };
        levels.push(lv);
      }
      lv.puzzles.push(pz);
    }
    if (!levels.length) throw new Error('Puzzles not found.');
    const music = ndsMusic(rom, 'sound/KPZ-DS.sdat', { title: 'BGM01', menu: 'BGM01', play: 'BGM02' }, ['BGM02', 'BGM03', 'BGM04']);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: 'nds-hello-kitty-logic', title: { en: 'Hello Kitty no Paku Paku & Logic', ja: 'ハローキティのパクパク＆ロジック' },
      source: { game: 'Hello Kitty no Paku Paku & Logic', platform: 'Nintendo DS', region: 'JPN' },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, assets: music.assets,
      theme: { ...music.theme, palette: { style: 'logic', accent: '#e0508a', cursor: '#f890b8', fill: '#4a3038', grid5: '#e0508a' } },
    }];
  },
});
