// Hatena Satena — "パズルシリーズ？ Hatena Satena" (GBA, JP, Hudson Soft 2001) — MomoGram importer.
//
//  Game                       File (recognised by)            Puzzles
//  Hatena Satena (GBA, JP)    GBA header title "HATENA SATENA" (code AHSJ)  352 puzzles (colour picross)
//
// This is Hudson's "Caribbo"-style *colour* picross (nonogram + minesweeper): every puzzle is a picture
// drawn in up to 6 colours (cell values 1..6, 0 = empty), played like a normal mono nonogram. The ROM keeps
// the puzzles in a pointer table of 213 entries at 0x11D8A4 (compact records), each pointing at a range
// that contains one or more sub-records (a pointer is a range boundary, not a single record — scanning each
// range for the sub-record header below yields **352** puzzles: pointer 71 holds 4, pointer 212 the last 138).
//
//  Sub-record (ROM, *compressed* — see the decode below; byte-verified across all 352):
//    +0  u32 0x00000190   LZ77UnCompWram size field = 400 (the grid buffer the loader decodes into)
//         The first 4 bytes are the GBA BIOS LZ77UnCompWram header: byte0 = 0x10 (magic), bytes 1..3 = 24-bit
//         little-endian output length. The OLD analysis mistook these for a "max grid buffer" field; they are
//         actually exactly 400 = the decompressed record size.
//    then  LZ77UnCompWram stream (the game's loader 0x0804CFA4 calls SWI 0x11, the BIOS LZ77UnCompWram).
//    The decompressed 400-byte record:
//      +0  u8 0x6D        magic, constant
//      +1  u8 0x33        magic, constant
//      +2  u8  width      (5,10,11,15,20,30)
//      +3  u8  height     (5,10,10,10,20,20)
//      +4  ..  cell grid: width×height cells, one 4-bit nibble per cell, rows padded to 16 bytes,
//            high nibble of each byte = the even (0,2,4…) cell, low nibble = the odd (1,3,5…) cell.
//            Cell values: 0 = empty, 1..6 = the picture's 6 colours, 7..8 = extra shades (rare).
//      (a tail holds the 6-colour BGR555 palette and the Shift-JIS puzzle name; the importer re-derives
//      the picture rows directly from the grid and a friendly colour palette.)
//
//  The LZ77UnCompWram bit layout is the GBA BIOS one (GBATEK): byte0 = 0x10, next 3 bytes = size LE, then
//  blocks: one flags byte per 8 tokens, iterated MSB-first; a SET bit is a back-reference (2 bytes: b1,b2 →
//  length = (b1>>4)+3, distance = ((b1&7)<<8)|b2 … verified) and a CLEAR bit is a literal byte. The earlier
//  analysis inverted this and decompressed nonsense; with the correct polarity all 352 records expand to
//  exactly 400 bytes with matching dimensions. See VERIFIED.md for the byte-by-byte evidence.

import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text } from '../format';

const GAME = {
  id: 'gb-hatena-satena',
  title: { en: 'Hatena Satena', ja: 'ハテナ・サテナ' },
  year: 2001, platform: 'Game Boy Advance', region: 'JPN', developer: 'Hudson Soft',
};

const B_TABLE = 0x11D8A4;   // 213 pointers, ranges of compact puzzle records
const B_END = 0x363E78;     // end of the last range
const SUB_HEADER = /^\x10\x90\x01\x00[\x00-\x02]\x6d\x33..$/s;

const sjis = new TextDecoder('shift_jis');

/** GBA header title (0xA0). Hatena Satena keeps it there (not at 0x134 like GB). */
const gbaTitle = (d: Uint8Array) => String.fromCharCode(...d.subarray(0xA0, 0xAC)).replace(/\0.*$/, '').trim();
// The GBA header title lives at 0xA0; this Hudson cart does not carry the classic Nintendo logo at 0x104
// (that region holds the game's own boot/vector code), so detect on title + code + size + structure only.
const gbaCode = (d: Uint8Array) => String.fromCharCode(...d.subarray(0xAC, 0xB0)).replace(/\0.*$/, '').trim();
const isGba = (d: Uint8Array) => d.length >= 0x8000 && d[0xA0] !== 0 && d[0x104] === 0x00;

function readU32(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
}

interface Sub {
  /** stable id within the pack (uses the record's ROM offset: never shifts) */
  id: string;
  off: number; w: number; h: number; flag: number; name?: Text;
  /** decompressed 400-byte record (see header: grid + tail) */
  grid: Uint8Array;
}

/**
 * GBA BIOS LZ77UnCompWram (SWI 0x11). Mirror of the game's loader, uses the real bit polarity:
 * a SET flag bit is a back-reference, a CLEAR bit is a literal. Byte-verified: expands every one of
 * the 352 Hatena Satena records to exactly the declared size (400).
 */
function lzUncompVram(d: Uint8Array, off: number): Uint8Array {
  // magic + 24-bit LE output size (byte1..3 of the header)
  if (d[off] !== 0x10) throw new Error(`Not an LZ77 record at ${off.toString(16)}`);
  const size = d[off + 1] | (d[off + 2] << 8) | (d[off + 3] << 16);
  const out: number[] = [];
  let p = off + 4, blocks = 0, head = 0;
  while (out.length < size && p < d.length) {
    if (blocks) {
      if (head & 0x80) {
        // back-reference
        const b1 = d[p], b2 = d[p + 1]; p += 2;
        const len = (b1 >> 4) + 3, disp = ((b1 << 8) | b2) & 0xFFF;
        if (disp + 1 > out.length) throw new Error(`Bad LZ77 back-ref at ${p.toString(16)}`);
        for (let i = 0; i < len && out.length < size; i++) out.push(out[out.length - 1 - disp]);
      } else {
        // literal
        out.push(d[p]); p++;
      }
      head <<= 1; blocks--;
    } else { head = d[p]; p++; blocks = 8; }
  }
  if (out.length < size) throw new Error('LZ77 stream ended early');
  return new Uint8Array(out.slice(0, size));
}

function decodeName(d: Uint8Array): Text | undefined {
  // sum the best shift-JIS run (allowing 0x20/0x00 between chars) anywhere in the tail
  let best = '';
  for (let s = 0; s < d.length; s++) {
    let p = s, chars = '';
    while (p + 1 < d.length) {
      const b1 = d[p], b2 = d[p + 1];
      const lead = (b1 >= 0x81 && b1 <= 0x9F) || (b1 >= 0xE0 && b1 <= 0xFC);
      if (lead && b2 >= 0x40 && b2 !== 0x7F && b2 <= 0xFC) {
        const ch = sjis.decode(new Uint8Array([b1, b2]));
        if (ch === '\uFFFD') break;
        chars += ch; p += 2;
      } else if (b1 === 0x20 || b1 === 0x00) { chars += ' '; p += 1; }
      else break;
      if (chars.length > 40) break;
    }
    if (!chars.includes('\uFFFD') && chars.replace(/ /g, '').length >= 2 && chars.length > best.length) best = chars;
  }
  const t = best.trim().replace(/ +$/, '').trim();
  return t ? { ja: t } : undefined;
}

/**
 * Read every puzzle record from the player's ROM.
 * Each pointer's range is scanned for sub-record headers; each yields one puzzle (dimensions from the
 * header's own bytes) and its LZ77-decompressed 400-byte grid — 352 in total on the JP cart.
 */
export function hatenaSubRecords(d: Uint8Array): Sub[] {
  const subs: Sub[] = [];
  for (let i = 0; i < 213; i++) {
    const tgt = readU32(d, B_TABLE + i * 4) & 0x01FFFFFF;
    const nxt = i + 1 < 213 ? readU32(d, B_TABLE + (i + 1) * 4) & 0x01FFFFFF : B_END;
    if (tgt >= nxt || tgt >= d.length) continue;
    const range = d.subarray(tgt, nxt);
    for (let k = 0; k + 9 <= range.length; k++) {
      if (range[k] === 0x10 && range[k + 1] === 0x90 && range[k + 2] === 0x01 && range[k + 3] === 0x00 &&
          range[k + 5] === 0x6d && range[k + 6] === 0x33) {
        const w = range[k + 7], h = range[k + 8];
        if (w < 3 || w > 30 || h < 3 || h > 30) continue;
        const off = tgt + k;
        const grid = lzUncompVram(d, off);
        if (grid[0] !== 0x6d || grid[1] !== 0x33 || grid[2] !== w || grid[3] !== h) continue;
        const all0 = grid.subarray(0);
        subs.push({
          id: `r${(i + 1).toString().padStart(3, '0')}-${k.toString(16).padStart(3, '0')}`,
          off, w, h, flag: range[k + 4],
          name: decodeName(all0), grid,
        });
      }
    }
  }
  return subs;
}

/** the picture as w×h colour cells (0 = empty, 1..6 = colour) from the decompressed 400-byte record */
function decodeCells(s: Sub): Uint8Array {
  const cells = new Uint8Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const idx = 4 + y * 16 + (x >> 1);
    cells[y * s.w + x] = (x & 1) ? (s.grid[idx] & 0x0F) : (s.grid[idx] >> 4);
  }
  return cells;
}

/** mono basis rows: any non-zero cell is filled */
function monoRows(w: number, h: number, cells: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += cells[y * w + x] ? '#' : '.';
    rows.push(r);
  }
  return rows;
}

/** a colour picture from w*h colour cells (a cell's value is a 1..6 colour id; 0 = empty) */
function colourRows(w: number, h: number, cells: Uint8Array, paletteOf: (id: number) => string): PackPuzzle['color'] {
  const used = new Map<number, number>();
  const palette: string[] = [];
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x];
      if (!c) { r += '.'; continue; }
      if (used.has(c)) { r += used.get(c)!.toString(36); continue; }
      const pi = used.size; used.set(c, pi); palette.push(paletteOf(c));
      r += pi.toString(36);
    }
    rows.push(r);
  }
  return palette.length <= 36 ? { palette, rows } : undefined;
}

registerImporter({
  name: 'Hatena Satena (Game Boy Advance)',
  version: 2, // v2: the proprietary LZ77 cell decoder landed (v1 threw the documented half-blocker)
  detect(d, fileName) {
    return d.length === 0x400000 && gbaCode(d) === 'AHSJ' && /^HATENA.?SATENA/i.test(gbaTitle(d)) && d[0x11D8A4] === 0x60;
  },
  read(d, fileName): Pack[] {
    const subs = hatenaSubRecords(d);
    if (!subs.length) throw new Error('Puzzle table not found.');
    // colour palette of the game: cell ids 1..6 are the picture's 6 colours (plus rare 7..8 shades),
    // rendered in friendly fixed hues until the record's own BGR555 palette is wired for asset output.
    const colours = ['#2f6fb0', '#e05030', '#e0b120', '#58a030', '#a048c0', '#c07818',
       '#5f6f7f', '#efe7d0'];

    // group by size: the game's packs are organised by difficulty/theme via the attribute tables
    // (0x576F8 / 0x577CD); sizes are a good stable grouping.
    const bySize = new Map<string, Sub[]>();
    for (const s of subs) {
      const k = `${s.w}x${s.h}`;
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k)!.push(s);
    }
    const sizeOrder = [...bySize.keys()].sort((a, b) => {
      const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
      return (aw * ah) - (bw * bh);
    });

    const levels: PackLevel[] = [];
    for (const size of sizeOrder) {
      const subsOf = bySize.get(size)!;
      const puzzles: PackPuzzle[] = [], nn: PackPuzzle[] = [];
      for (const s of subsOf) {
        const cells = decodeCells(s);
        nn.push({
          id: s.id, width: s.w, height: s.h,
          rows: monoRows(s.w, s.h, cells),
          colorGame: true, colorOnly: true,
          color: colourRows(s.w, s.h, cells, c => colours[c - 1] ?? '#000'),
          name: s.name,
        });
      }
      puzzles.push(...nn);
      const title: Text = { en: `${size.replace('x', '×')}`, ja: `${size.replace('x', '×')}` };
      levels.push({ id: `hs-${size}`, title, rules: 'normal', puzzles });
    }

    const pack: Pack = {
      format: 'momogram-pack', version: 1, id: GAME.id, title: GAME.title,
      source: { game: GAME.title.en!, platform: GAME.platform, region: GAME.region, developer: GAME.developer, year: GAME.year },
      theme: {
        palette: { style: 'logic', accent: '#c98020', cursor: '#ffd060', fill: '#1a1a1a', cross: '#888', grid: '#aaa' },
      },
      levels,
    };
    return [pack];
  },
});
