// Success's DS Puzzler games (sudoku and picture logic on one card). Only the picture logic puzzles are read.
//
//  Game                                         File (recognised by)       Puzzles
//  DS Puzzler: Nanpure Fan & Oekaki Logic       game code ANQJ             data/question/ilq01.bin: 502 records,
//    (JPN, 2007)                                                             500 of them used, Japanese names
//  Challenge Me: Brain Puzzles (EUR / USA)      game code ANQP / ANQE      the same puzzles; names also in
//                                                                            data/lang/loc_<lang>_c.bin
//  DS Puzzler: Nanpure Fan & Oekaki Logic       game code YZ2J             question/ilq01.bin: 500 other puzzles
//    Wi-Fi Taiou (JPN, 2008)
//
// ilq01.bin: u32 count, count × u32 offset; a record is u8 size (10 / 15 / 20, square), 4 bytes (colours),
//   then size × size bytes, 1 = filled.
// ilq_info.bin: 500 × 28 bytes, in the game's order: u16 record number, u16 level (0-9), u16 target time
//   (seconds), Shift-JIS name (22 bytes).
// loc_<lang>_c.bin: u32 offsets of UTF-16 strings; the 500 names are strings 296-795 (in ilq_info order) in
//   every language of Challenge Me (803 strings).
// Music: <data/>sound/sound_data.sdat, SEQ_BGM01 (menu) and the others (puzzles).
import { registerImporter } from './index';
import { Lang, Pack, PackLevel, PackPuzzle, Text, makeIcon, rowsFromBits } from '../format';
import { NdsRom, ndsMusic, u16, u32 } from '../../rom/nds';

const GAMES: Record<string, { id: string; title: Text; region: string; year: number; wifi: boolean }> = {
  ANQJ: { id: 'nds-ds-puzzler', title: { en: 'Challenge Me: Brain Puzzles', ja: 'DSパズラー ナンプレファン＆お絵かきロジック' }, region: 'JPN', year: 2007, wifi: false },
  ANQP: { id: 'nds-ds-puzzler', title: { en: 'Challenge Me: Brain Puzzles', ja: 'DSパズラー ナンプレファン＆お絵かきロジック' }, region: 'EUR', year: 2008, wifi: false },
  ANQE: { id: 'nds-ds-puzzler', title: { en: 'Challenge Me: Brain Puzzles', ja: 'DSパズラー ナンプレファン＆お絵かきロジック' }, region: 'USA', year: 2008, wifi: false },
  YZ2J: { id: 'nds-ds-puzzler-wifi', title: { en: 'DS Puzzler: Oekaki Logic (Wi-Fi)', ja: 'DSパズラー ナンプレファン＆お絵かきロジック Wi-Fi対応' }, region: 'JPN', year: 2008, wifi: true },
};
const LOC: Record<string, Lang> = { eng: 'en', usa: 'en', fre: 'fr', ger: 'de', ita: 'it', spa: 'es' };
const NAMES_AT = 296, LOC_STRINGS = 803;

const sjis = new TextDecoder('shift_jis'), utf16 = new TextDecoder('utf-16le');

function locNames(rom: NdsRom): Map<Lang, string[]> {
  const out = new Map<Lang, string[]>();
  for (const [code, lang] of Object.entries(LOC)) {
    const f = rom.fileByName(`data/lang/loc_${code}_c.bin`);
    if (!f || u32(f, 0) !== LOC_STRINGS * 4) continue;
    const at = (i: number) => { const a = u32(f, i * 4), b = i + 1 < LOC_STRINGS ? u32(f, i * 4 + 4) : f.length; return utf16.decode(f.subarray(a, b)).replace(/\0.*$/s, '').trim(); };
    if (out.has(lang) && code === 'usa') continue; // the European English comes first
    out.set(lang, Array.from({ length: 500 }, (_, i) => at(NAMES_AT + i)));
  }
  return out;
}

registerImporter({
  name: 'DS Puzzler / Challenge Me (DS)',
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.slice(0, 4) in GAMES,
  read: d => {
    const rom = new NdsRom(d), g = GAMES[rom.gameCode];
    const dir = rom.fileByName('data/question/ilq01.bin') ? 'data/' : '';
    const q = rom.fileByName(dir + 'question/ilq01.bin'), info = rom.fileByName(dir + 'question/ilq_info.bin');
    if (!q || !info) throw new Error('Puzzles not found.');
    const loc = locNames(rom);
    const levels: PackLevel[] = [];
    for (let i = 0; i * 28 + 28 <= info.length; i++) {
      const e = i * 28, rec = u16(info, e), lv = u16(info, e + 2);
      if (rec >= u32(q, 0)) continue;
      const o = u32(q, 4 + rec * 4), n = q[o];
      if (n !== 10 && n !== 15 && n !== 20) continue;
      const name: Text = {};
      const ja = sjis.decode(info.subarray(e + 6, e + 28)).replace(/\0.*$/s, '').trim();
      if (ja) name.ja = ja;
      for (const [l, list] of loc) if (list[i]) name[l] = list[i];
      const pz: PackPuzzle = { id: `p${String(rec + 1).padStart(3, '0')}`, width: n, height: n, rows: rowsFromBits(n, n, (x, y) => q[o + 5 + y * n + x] === 1), name };
      let level = levels.find(l => l.id === `level-${lv + 1}`);
      if (!level) { level = { id: `level-${lv + 1}`, title: { en: `Level ${lv + 1}`, de: `Stufe ${lv + 1}`, ja: `レベル${lv + 1}` }, rules: 'normal', puzzles: [] }; levels.push(level); }
      level.puzzles.push(pz);
    }
    levels.sort((a, b) => parseInt(a.id.slice(6)) - parseInt(b.id.slice(6)));
    const seqs = g.wifi ? ['SEQ_BGM02', 'SEQ_BGM03', 'SEQ_BGM04'] : ['SEQ_BGM02', 'SEQ_BGM03'];
    const music = ndsMusic(rom, dir + 'sound/sound_data.sdat', { title: 'SEQ_BGM01', menu: 'SEQ_BGM01', play: seqs[0] }, seqs);
    const px = rom.icon();
    const pack: Pack = {
      format: 'momogram-pack', version: 1, id: g.id, title: g.title,
      source: { game: g.region === 'JPN' ? g.title.ja! : g.title.en!, platform: 'Nintendo DS', region: g.region, developer: 'Success', year: g.year },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, theme: music.theme, assets: music.assets,
    };
    return [pack];
  },
});
