// Hudson's Illust Logic games for the Nintendo DS and DSiWare. All of them keep their puzzles in quest/*.bin.
//
//  Game                                   File (recognised by)            Puzzles
//  Puzzle Series Vol. 6: Illust Logic     game code AILJ                   quest/quest10x10 … quest25x25.bin, "ILQT"
//    (DS, 2006)                                                              records (format A below): 50 + 100 + 100 + 50,
//                                                                            each with its answer and a colour picture
//  Illust Logic DS + Colorful Logic       game code YLLJ                   quest/quest00 … quest05_2.bin (format B): 300
//    (DS, 2008)                                                              puzzles; quest06*.bin are colour puzzles
//                                                                            (Colorful Logic, not imported yet)
//  Illust Logic (DSiWare, 2009)           game code KILJ                   quest/quest00 … quest05.bin (format B): 200
//  Illust Logic + Nihon no Mukashi        game code KI2J                   quest/quest00 … quest05.bin (format B): 200
//    Banashi (DSiWare, 2009)
//
// Format A (questWxH.bin): u32 count, u32 file size, then count × (u32 offset, u32 size) of ILQT records.
//   ILQT record: "ILQT", u16 0, u8 width, u8 height, u32 size, 7 × u32 offsets (from the record start) of:
//   the question (Shift-JIS, "what animal appears?"), the size label, the answer (the picture's name),
//   16 BGR555 colours, width × height cells (bit 7 = filled, bits 0-6 = colour), the column clues, the row clues.
// Format B (questNN.bin): records one after another, each padded to an even length: u8 width, u8 height, u16 0,
//   20 BGR555 colours (the picture's 16 colours are entries 4-19), width × height cells (bit 4 = filled,
//   bits 0-3 = colour; the colour puzzles use bits 4-7 for the clue colour). A 300-byte note ends each file.
//   The answers of these games are drawn as pictures of text, so they have no names yet.
// Music: snd/sound_data.sdat.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, bgr555Hex, ndsMusic, u16, u32 } from '../../rom/nds';

const GAMES: Record<string, { id: string; title: Pack['title']; year: number; platform: string; format: 'A' | 'B' }> = {
  AILJ: { id: 'nds-illust-logic-ps6', title: { en: 'Puzzle Series Vol. 6: Illust Logic', ja: 'パズルシリーズVol.6 イラストロジック' }, year: 2006, platform: 'Nintendo DS', format: 'A' },
  YLLJ: { id: 'nds-illust-logic-ds', title: { en: 'Illust Logic DS + Colorful Logic', ja: 'イラストロジックDS＋カラフルロジック' }, year: 2008, platform: 'Nintendo DS', format: 'B' },
  KILJ: { id: 'dsi-illust-logic', title: { en: 'Illust Logic', ja: 'イラストロジック' }, year: 2009, platform: 'DSiWare', format: 'B' },
  KI2J: { id: 'dsi-illust-logic-mukashi', title: { en: 'Illust Logic + Nihon no Mukashi Banashi', ja: 'イラストロジック＋日本の昔話' }, year: 2009, platform: 'DSiWare', format: 'B' },
};

const sjis = new TextDecoder('shift_jis');
const text = (d: Uint8Array, a: number, b: number) => { const s = d.subarray(a, b); const z = s.indexOf(0); return sjis.decode(z < 0 ? s : s.subarray(0, z)).trim(); };

/** a solved picture in colour: cells give a palette index */
function colour(w: number, h: number, pal: string[], index: (i: number) => number): PackPuzzle['color'] {
  const used = new Map<number, number>(), palette: string[] = [], rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      const c = index(y * w + x);
      if (!used.has(c)) { used.set(c, palette.length); palette.push(pal[c] ?? '#000000'); }
      r += used.get(c)!.toString(36);
    }
    rows.push(r);
  }
  return palette.length <= 36 ? { palette, rows } : undefined;
}

function readA(rom: NdsRom): PackLevel[] {
  const levels: PackLevel[] = [];
  for (const n of [10, 15, 20, 25]) {
    const f = rom.fileByName(`quest/quest${n}x${n}.bin`);
    if (!f) continue;
    const puzzles: PackPuzzle[] = [];
    for (let i = 0, count = u32(f, 0); i < count; i++) {
      const o = u32(f, 8 + i * 8), r = f.subarray(o, o + u32(f, 12 + i * 8));
      if (u32(r, 0) !== 0x54514c49) continue; // "ILQT"
      const w = r[6], h = r[7], off = Array.from({ length: 7 }, (_, k) => u32(r, 0x0c + k * 4));
      const cells = r.subarray(off[4], off[4] + w * h);
      const pal = Array.from({ length: 16 }, (_, k) => bgr555Hex(u16(r, off[3] + k * 2)));
      const name = text(r, off[2], off[3]);
      puzzles.push({
        id: `${n}x${n}-${String(i + 1).padStart(3, '0')}`, width: w, height: h,
        rows: rowsFromBits(w, h, (x, y) => (cells[y * w + x] & 0x80) !== 0),
        name: name ? { ja: name } : undefined,
        color: colour(w, h, pal, k => cells[k] & 0x7f),
      });
    }
    if (puzzles.length) levels.push({ id: `${n}x${n}`, title: { en: `${n}×${n}`, ja: `${n}×${n}` }, rules: 'normal', puzzles });
  }
  return levels;
}

function readB(rom: NdsRom): PackLevel[] {
  const levels: PackLevel[] = [];
  const files = rom.fileNames().filter(n => /^quest\/quest\d\d(_\d)?\.bin$/.test(n) && !/quest06/.test(n)).sort();
  files.forEach((name, li) => {
    const f = rom.fileByName(name)!, puzzles: PackPuzzle[] = [];
    const tag = name.match(/quest(\d\d(?:_\d)?)/)![1];
    for (let o = 0, i = 0; o + 44 <= f.length; i++) {
      const w = f[o], h = f[o + 1];
      if (!w || !h || w > 40 || h > 40 || o + 44 + w * h > f.length) break;
      const cells = f.subarray(o + 44, o + 44 + w * h);
      const pal = Array.from({ length: 16 }, (_, k) => bgr555Hex(u16(f, o + 12 + k * 2)));
      puzzles.push({
        id: `${tag}-${String(i + 1).padStart(2, '0')}`, width: w, height: h,
        rows: rowsFromBits(w, h, (x, y) => (cells[y * w + x] & 0x10) !== 0),
        color: colour(w, h, pal, k => cells[k] & 0x0f),
      });
      o += (44 + w * h + 1) & ~1;
    }
    if (puzzles.length) levels.push({ id: `quest-${tag}`, title: { en: `Stage ${li + 1}`, ja: `ステージ${li + 1}` }, rules: 'normal', puzzles });
  });
  return levels;
}

registerImporter({
  name: 'Illust Logic (Hudson, DS / DSiWare)',
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.slice(0, 4) in GAMES,
  read: d => {
    const rom = new NdsRom(d), g = GAMES[rom.gameCode];
    const levels = g.format === 'A' ? readA(rom) : readB(rom);
    if (!levels.length) throw new Error('Puzzles not found.');
    const music = g.format === 'A'
      ? ndsMusic(rom, 'snd/sound_data.sdat', { title: 'SEQ_BGM01', menu: 'SEQ_BGM01', play: 'SEQ_BGM02', clear: 'SEQ_JIN00' }, ['SEQ_BGM02', 'SEQ_BGM03', 'SEQ_BGM04', 'SEQ_BGM05', 'SEQ_BGM06'])
      : ndsMusic(rom, 'snd/sound_data.sdat', { title: 'bgm01', menu: 'bgm01', play: 'bgm02', clear: 'jingle01' }, ['bgm02', 'bgm03', 'bgm04', 'bgm05', 'bgm06', 'bgm07', 'bgm08', 'bgm09', 'bgm10']);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: g.id, title: g.title,
      source: { game: g.title.en!, platform: g.platform, region: 'JPN', developer: 'Hudson Soft', year: g.year },
      levels, icon: px ? makeIcon(32, 32, px) : undefined,
      // the board (from screenshots): white cells, black filled cells, the cursor's lines as yellow beams
      theme: { ...music.theme, palette: { style: 'logic', accent: '#c89010', cursor: '#f0d020', fill: '#1c1c1c', cross: '#806040', grid: '#b8b0a0', grid5: '#706050' } }, assets: music.assets,
    }];
  },
});
