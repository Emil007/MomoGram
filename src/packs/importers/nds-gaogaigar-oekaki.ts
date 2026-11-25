// Oekaki Puzzle Battle! - Yuusha Ou GaoGaiGar Hen (Bandai Namco / Sunrise "sunlogic", Nintendo DS).
// All puzzles live in one custom resource container, files/romfile.bin: a flat chain of [u32 size][data]
// resources starting at the container's 0x16F8. ~282 of them (res[39..702] in the 0x4400-0x6100 range) are
// compact per-puzzle records:
//
//  [u32 size][u16 w=0x30][u16 h=0x60][RLE answer (palette-index cells)][row/col clue data …]
//
//  Answer RLE rule (verified byte-level, all 282 records):
//    byte >= 0x80  -> count = (byte & 0x7F) + 1 copies of the next byte
//    byte <  0x80  -> that literal cell
//  The stream at payload+8 decodes to exactly 48×96 = 4608 cells for every record.
//  A cell is a palette index; index 0 is the empty background, a non-zero index is a filled cell.
//
// The header area of romfile.bin holds pointer tables that group the records into four levels, each followed
// by its own run of 0x200-byte BGR555 palettes (80/78/14/110 records per level = 282). A single palette among
// them (res 495) colours every record's used indices coherently, and is used for the pack's colour picture.
// The game is a COLOR (midori/Picross-style) logic game: several colour indices per row, not black/white.
// Music: files/sound_data.sdat (SDAT with SEQ_BGM01.. and SEQ_JINxx). Icon: files/icon.bnr.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, rowsFromBits } from '../format';
import { NdsRom, bgr555Hex, ndsMusic, u16, u32 } from '../../rom/nds';

const W = 48, H = 96, CELLS = W * H;

/** walk files/romfile.bin's [u32 size][data] chain, starting at 0x16F8 (the container header) */
function resources(rb: Uint8Array): Array<{ off: number; size: number }> {
  const out: Array<{ off: number; size: number }> = [];
  let p = 0x16f8;
  while (p + 4 <= rb.length) {
    const size = u32(rb, p);
    out.push({ off: p + 4, size });
    p += 4 + size;
  }
  return out;
}

/** RLE-decode the answer grid (payload+8) to 48×96 palette-index cells; null if it isn't a full grid */
function answerCells(rec: { off: number; size: number }, rb: Uint8Array): number[] | null {
  const raw = rb.subarray(rec.off, rec.off + rec.size);
  const out: number[] = [];
  let i = 8;
  while (i < raw.length && out.length < CELLS) {
    const v = raw[i++];
    if (v & 0x80) {
      const c = (v & 0x7f) + 1;
      if (i >= raw.length) return null;
      const val = raw[i++];
      for (let k = 0; k < c && out.length < CELLS; k++) out.push(val);
    } else out.push(v);
  }
  return out.length === CELLS ? out : null;
}

/** the record's own most-used palette-index set, compacted to at most 32 colours for the colour picture */
function colourOf(cells: number[], hex: (idx: number) => string): { palette: string[]; rows: string[] } | undefined {
  // count usage of each non-empty palette index
  const counts = new Map<number, number>();
  for (const c of cells) if (c !== 0) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (!counts.size) return undefined;
  // the most common colours first, then the rest, capped at 36 (base36) - beyond 32 MomoGram's colour
  // mode keeps them as a picture but not a separate colour puzzle.
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const keep = sorted.slice(0, 32).map(([c]) => c);
  const keepSet = new Set(keep);
  const palette: string[] = [], rows: string[] = [];
  const map = new Map<number, number>();
  keep.forEach((c, k) => { if (!map.has(c)) { map.set(c, palette.length); palette.push(hex(c)); } });
  for (let y = 0; y < H; y++) {
    let s = '';
    for (let x = 0; x < W; x++) {
      const idx = cells[y * W + x];
      const k = map.get(idx);
      s += k === undefined ? '.' : k.toString(36);
    }
    rows.push(s);
  }
  return palette.length ? { palette, rows } : undefined;
}

registerImporter({
  name: 'Oekaki Puzzle Battle: GaoGaiGar (DS)',
  version: 1,
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode === 'AMRJ',
  read: d => {
    const rom = new NdsRom(d);
    const rb = rom.fileByName('files/romfile.bin');
    if (!rb) throw new Error('files/romfile.bin not found.');
    const res = resources(rb);
    const palHex = Array.from({ length: 256 }, (_, k) => bgr555Hex(u16(rb, res[495].off + k * 2)));

    // the four level groups (record resource indices), from the header pointer tables
    const groups = [[92, 171], [212, 289], [71, 84], [329, 438]];
    const levels: PackLevel[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const [a, b] = groups[gi];
      const puzzles: PackPuzzle[] = [];
      for (let wi = a; wi <= b; wi++) {
        const rec = res[wi];
        if (!rec) continue;
        if (u16(rb, rec.off) !== W || u16(rb, rec.off + 2) !== H) continue;
        const cells = answerCells(rec, rb);
        if (!cells) continue;
        const rows = rowsFromBits(W, H, (x, y) => cells[y * W + x] !== 0);
        const color = colourOf(cells, idx => palHex[idx] ?? '#000000');
        const pz: PackPuzzle = {
          id: `${gi + 1}-${String(wi).padStart(3, '0')}`, width: W, height: H, rows,
          colorGame: true, colorOnly: false, color,
        };
        puzzles.push(pz);
      }
      if (puzzles.length) {
        levels.push({ id: `level-${gi + 1}`, title: { en: `Stage ${gi + 1}`, ja: `ステージ${gi + 1}` }, rules: 'normal', puzzles });
      }
    }
    if (!levels.length) throw new Error('Puzzles not found.');
    // music + icon
    const music = ndsMusic(rom, 'files/sound_data.sdat', { title: 'SEQ_BGM01', menu: 'SEQ_BGM01', play: 'SEQ_BGM02' }, ['SEQ_BGM02', 'SEQ_BGM03', 'SEQ_BGM04', 'SEQ_BGM05', 'SEQ_BGM07', 'SEQ_BGM08']);
    const px = rom.icon();
    return [{
      format: 'momogram-pack', version: 1, id: 'nds-gaogaigar-oekaki',
      title: { en: 'Oekaki Puzzle Battle: GaoGaiGar', ja: 'おえかきパズルバトル！ 勇者王ガオガイガー編' },
      source: { game: 'Oekaki Puzzle Battle! - Yuusha Ou GaoGaiGar Hen', platform: 'Nintendo DS', region: 'JPN', developer: 'Sunrise Interactive', year: 2003 },
      levels, icon: px ? makeIcon(32, 32, px) : undefined, assets: music.assets,
      theme: { ...music.theme, palette: { style: 'logic', accent: '#3a6fd8', cursor: '#7fb4f0', fill: '#1c2840', grid5: '#3a6fd8' } },
    }];
  },
});
