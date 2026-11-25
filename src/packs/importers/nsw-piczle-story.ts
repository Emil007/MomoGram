// Piczle Cross: Story of Seasons / Rune Factory (Nintendo Switch) — nonograms by Score Studios,
// engine Unreal Engine 5 (IoStore / cooked DataTable exports). The Steam-only "Piczle Cross
// Adventure" shares the developer but a different storage; these two Switch titles use the same
// UE5 pipeline as each other.
//
// The RomFS of each game holds a UE5 pak (Story of Seasons) or an IoStore .utoc/.ucas (Rune Factory).
// The importer unpacks those itself. The puzzle data is one cooked DataTable export:
//
//   Content/STORYofSEASONS/puzzles/puzzles.uexp      (Story of Seasons)
//   Content/PiczleCrossRuneFactory/puzzles/puzzles.uexp   (Rune Factory — same layout)
//
// Each puzzle is one record, laid out as contiguous fields:
//
//   FString grid    the solution: a dense ASCII string of '0'/'1', row-major, one char per cell
//                   (length includes the trailing NUL); e.g. 225 chars for a 15×15
//   FString × 9     localized titles, in the order en, fr, it, de, es, ja, ko, zh-Hans, zh-Hant.
//                   An FString is length-prefixed: int32 len ≥ 0 → UTF-8/ASCII (len bytes incl. NUL);
//                   len < 0 → UTF-16LE (-len code units incl. NUL). Missing languages are a literal
//                   "-" placeholder or empty. (The S/lower-s/c-preview textures in
//                   puzzles/solutions/*.uexp are presentation art, not per-cell data.)
//
// Some puzzles store their solution inverted (0 = filled). Both the orientation and the polarity
// are recovered with the repo's line-solvability check (puzzleScore) over the game's own board
// sizes; a polarity/orientation that is not line-solvable is never the true one. A handful of
// puzzles whose grid is not line-solvable under any standard size are skipped (they are the
// game's nonstandard collage/bonus states).
//
//   File (recognised by)                                  Puzzles
//   puzzles.uexp (dense 0/1 grids + up to 9-language names)     342 (Story of Seasons)
//   puzzles_C.uasset / puzzle_grid.uasset (same 0/1 grids)      300 (Rune Factory)
//   puzzles_CC.uasset (Rune Factory colour): a grid of '0' and
//   letters A, B, C… plus a hex palette (2–5 colours)           300
//
// Story of Seasons and Adventure have no colour table. Their c01 / solution files are
// anti-aliased pictures, not one colour per cell.

import { readPiczleIoStore } from '../../rom/iostore';
import { readUe5File } from '../../rom/uepak';
import { registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, Text } from '../format';
import { puzzleScore } from '../../game/difficulty';

/** the game's own board dimensions for a given cell count (both orientations that occur). */
const SIZES: Record<number, Array<[number, number]>> = {
  25: [[5, 5]], 50: [[10, 5], [5, 10]], 75: [[15, 5], [5, 15]], 100: [[10, 10]],
  150: [[15, 10], [10, 15]], 200: [[20, 10], [10, 20]], 225: [[15, 15]], 250: [[25, 10], [10, 25]],
  300: [[20, 15], [15, 20]], 375: [[25, 15], [15, 25]], 400: [[20, 20]], 500: [[25, 20], [20, 25]],
};
/** the language of each title column in the records (in file order). */
const LANGS = ['en', 'fr', 'it', 'de', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;

interface Raw { w: number; h: number; cells: string; name: Text | undefined; palette?: string[] }

/** '#' / '.' rows for the line solver. */
function scoreRows(cells: string, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += cells.charCodeAt(y * w + x) === 0x31 ? '#' : '.';
    out.push(row);
  }
  return out;
}

/** resolve a dense '0'/'1' grid to (w,h,polarity). A candidate is kept only when the line solver
 *  finishes it (puzzleScore). Non-square sizes and inverted solutions are both tried; the first
 *  listed size that actually solves wins. Null when none do (a nonstandard/bonus puzzle). */
function orient(cells: string): { w: number; h: number; cells: string } | null {
  const n = cells.length, size = SIZES[n];
  if (!size) return null;
  for (const inv of [false, true]) {
    let cs = cells;
    if (inv) { cs = ''; for (let i = 0; i < n; i++) cs += cells.charCodeAt(i) === 0x31 ? '0' : '1'; }
    for (const [w, h] of size) {
      if (w * h !== n) continue;
      if (puzzleScore(scoreRows(cs, w, h)).solvable) return { w, h, cells: cs };
    }
  }
  return null;
}

function rowsOf(cells: string, w: number, h: number, color = false): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x];
      row += color ? (c === '0' ? '.' : (c.charCodeAt(0) - 65).toString(36)) : (c === '1' ? '#' : '.');
    }
    out.push(row);
  }
  return out;
}

/** width and height for a colour grid. A blank edge is allowed; the orientation with fewer blank lines wins. */
function orientColor(cells: string): { w: number; h: number } | null {
  const n = cells.length;
  const listed = SIZES[n] ?? [];
  const choices = listed.length ? listed : [...Array(36)].flatMap((_, i) => {
    const w = i + 5, h = n / w;
    return Number.isInteger(h) && h >= 5 && h <= 40 ? [[w, h] as [number, number]] : [];
  });
  let best: { w: number; h: number; blank: number } | null = null;
  for (const [w, h] of choices) {
    if (w * h !== n) continue;
    let blank = 0, filled = 0;
    for (let y = 0; y < h; y++) { let any = false; for (let x = 0; x < w; x++) if (cells[y * w + x] !== '0') any = true; if (any) filled++; else blank++; }
    for (let x = 0; x < w; x++) { let any = false; for (let y = 0; y < h; y++) if (cells[y * w + x] !== '0') any = true; if (!any) blank++; }
    if (!filled) continue;
    if (!best || blank < best.blank) best = { w, h, blank };
  }
  return best ? { w: best.w, h: best.h } : null;
}

/** Rune Factory colour records: a letter grid, 8 bytes, then "RRGGBB,RRGGBB,…". */
function colorGrids(d: Uint8Array): Array<{ cells: string; palette: string[] }> {
  const out: Array<{ cells: string; palette: string[] }> = [];
  let guard = 0;
  for (let o = 0; o + 8 < d.length; o++) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const ln = dv.getInt32(o, true);
    if (ln < 21 || ln > 1500 || o + 4 + ln > d.length || d[o + 4 + ln - 1] !== 0) continue;
    if (guard && o < guard) continue;
    let letters = false, ok = true;
    for (let i = 0; i < ln - 1; i++) {
      const c = d[o + 4 + i];
      if (c !== 0x30 && (c < 0x41 || c > 0x5a)) { ok = false; break; }
      if (c >= 0x41) letters = true;
    }
    if (!ok || !letters) continue;
    const pal = fs(d, o + 4 + ln + 8);
    if (!pal || !/^[0-9A-F]{6}(,[0-9A-F]{6})+$/.test(pal.s)) continue;
    const cells = new TextDecoder().decode(d.subarray(o + 4, o + 4 + ln - 1));
    const palette = pal.s.split(',');
    if ([...cells].some(c => c !== '0' && c.charCodeAt(0) - 65 >= palette.length)) continue;
    out.push({ cells, palette: palette.map(h => '#' + h) });
    guard = o + 4 + ln;
  }
  return out;
}

/** read one UE FString at `off`; returns the string (stripped of the trailing NUL) and the offset
 *  of the next field. */
function fs(d: Uint8Array, off: number): { s: string; next: number } | null {
  if (off + 4 > d.length) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const len = dv.getInt32(off, true);
  if (len === 0) return { s: '', next: off + 4 };
  const wide = len < 0, n = Math.abs(len), nb = wide ? n * 2 : n;
  if (nb > 64 * 1024 || off + 4 + nb > d.length) return null;
  const raw = d.subarray(off + 4, off + 4 + nb);
  const s = wide
    ? new TextDecoder('utf-16le').decode(raw).replace(/\0+$/, '')
    : new TextDecoder().decode(raw).replace(/\0+$/, '');
  // reject surrogates (a lone surrogate means we overran a UTF-16 title's boundary)
  if (wide && /[\uD800-\uDFFF]/.test(s)) return null;
  return { s, next: off + 4 + nb };
}

function pack(id: string, title: string, accent: string, raws: Raw[]): Pack {
  const bySize = new Map<string, PackLevel>();
  for (const r of raws) {
    const color = !!r.palette;
    const sz = `${r.w}x${r.h}`;
    const key = (color ? 'c' : '') + sz;
    let l = bySize.get(key);
    if (!l) {
      l = color
        ? { id: 'c-' + sz, title: { en: `Color ${sz.replace('x', '×')}`, ja: `カラー ${sz.replace('x', '×')}` }, group: 'color', groupTitle: { en: 'Color Picross', ja: 'カラーピクロス' }, rules: 'normal' as const, puzzles: [] }
        : { id: 'pl-' + sz, title: { en: title + ' ' + sz.replace('x', '×') }, group: 'piczle', groupTitle: { en: title }, rules: 'normal' as const, puzzles: [] };
      bySize.set(key, l);
    }
    const puz: PackPuzzle = {
      id: `${color ? 'c' : ''}${sz}-${l.puzzles.length + 1}`, width: r.w, height: r.h,
      rows: rowsOf(color ? r.cells.replace(/[A-Z]/g, '1') : r.cells, r.w, r.h),
    };
    if (color && r.palette) {
      puz.color = { palette: r.palette, rows: rowsOf(r.cells, r.w, r.h, true) };
      puz.colorGame = true; puz.colorOnly = true;
    }
    if (r.name) puz.name = r.name;
    l.puzzles.push(puz);
  }
  const levels = [...bySize.values()].sort((a, b) => a.puzzles.length - b.puzzles.length || a.id.localeCompare(b.id));
  if (!levels.length) throw new Error('No puzzles found.');
  return {
    format: 'momogram-pack', version: 1, id,
    title: { en: title },
    source: { game: title, platform: 'Nintendo Switch', developer: 'Score Studios' },
    theme: {
      palette: {
        style: 'logic', accent, fill: '#e63b49', grid: '#8ab6d0', cursor: '#f0b020', hint: accent,
        clue: '#202020', bg: '#eaf4fb', cell: '#ffffff', cross: '#7090a8',
        board: {
          clueArea: '#eaf4fb', clueAreaAlt: '#dceaf6', clueBg: '#d0e6f4', clueBgAlt: '#ffffff',
          grid5: accent, bg: '#ffffff', cell: '#ffffff', clueFocusBg: '#f0b02088',
        },
        screen: { bg: '#d0e4f4', panel: '#ffffff', top: '#9ecce8' },
      },
    },
    levels,
  };
}

registerSetImporter({
  name: 'Piczle Cross (Nintendo Switch)',
  version: 5, // 5: orientation and polarity from the line solver, not "no blank line"
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      const proj = n.match(/^(.*?(?:PiczleCross_SoS|PiczleCross_RF)\/)/i);
      if (proj && (/\.pak$/i.test(n) || /\.utoc$/i.test(n) || /puzzles\.uexp$/i.test(n))) roots.add(proj[1]);
      else if (/(?:puzzles|Puzzles)\/puzzles\.uexp$/i.test(n) && /STORYofSEASONS|StoryOfSeasons|PiczleCrossRuneFactory|PiczleCross_RF/i.test(n))
        roots.add(n.slice(0, n.lastIndexOf('/') + 1) || '.');
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string): Promise<Pack[]> {
    const pre = root === '.' ? '' : root;
    const buffers: Uint8Array[] = [];
    const loose = files.names.find(n => n.startsWith(pre) && /(?:puzzles|Puzzles)\/puzzles\.uexp$/i.test(n));
    if (loose) {
      const d = await files.get(loose);
      if (d) buffers.push(d);
    } else {
      const utoc = files.names.find(n => n.startsWith(pre) && /PiczleCross_RF[^/]*\.utoc$/i.test(n));
      const ucas = files.names.find(n => n.startsWith(pre) && /PiczleCross_RF[^/]*\.ucas$/i.test(n) && !/global\.ucas$/i.test(n));
      if (utoc && ucas) {
        const a = await files.get(utoc), b = await files.get(ucas);
        if (a && b) buffers.push(...await readPiczleIoStore(a, b));
      } else {
        const pak = files.names.find(n => n.startsWith(pre) && /PiczleCross_SoS[^/]*\.pak$/i.test(n));
        if (pak) {
          const p = await files.get(pak);
          if (p) {
            const d = await readUe5File(p, n => /STORYofSEASONS\/puzzles\/puzzles\.uexp$/i.test(n));
            if (d) buffers.push(d);
          }
        }
      }
    }
    if (!buffers.length) throw new Error('puzzles.uexp (the puzzle DataTable export) not in the picked files.');

    const raws: Raw[] = [];
    for (const d of buffers) {
    for (const g of colorGrids(d)) {
      const box = orientColor(g.cells);
      if (box) raws.push({ w: box.w, h: box.h, cells: g.cells, name: undefined, palette: g.palette });
    }
    // Pass 1: locate every grid FString by its length prefix + [01]+ payload, then read the
    // title fields that follow. This mirrors the byte-level verified parsing of the game's file.
    const gs: Array<{ off: number; len: number }> = [];
    const last = d.length - 4;
    for (let o = 0; o + 4 <= last; o++) {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const ln = dv.getInt32(o, true);
      if (ln < 21 || ln > 1500 || o + 4 + ln > d.length) continue;
      const seg = d.subarray(o + 4, o + 4 + ln - 1); // exclude trailing NUL
      let all = true;
      for (let i = 0; i < seg.length; i++) { const c = seg[i]; if (c !== 0x30 && c !== 0x31) { all = false; break; } }
      if (!all || d[o + 4 + ln - 1] !== 0) continue;
      // de-dup: a grid may be matched twice (a length prefix inside the grid)
      if (gs.length && o < gs[gs.length - 1].off + gs[gs.length - 1].len) continue;
      gs.push({ off: o, len: ln });
    }

    for (let i = 0; i < gs.length; i++) {
      const g = gs[i], end = gs[i + 1]?.off ?? d.length;
      const grid = new TextDecoder().decode(d.subarray(g.off + 4, g.off + 4 + g.len - 1));
      const title: Record<string, string> = {};
      let p = g.off + 4 + g.len; // points just past the grid's trailing NUL
      let col = 0;
      while (col < LANGS.length && p + 4 <= end) {
        const f = fs(d, p);
        if (!f) break;
        if (/^[01]{20,}$/.test(f.s)) break; // next record's grid
        const v = f.s.trim();
        if (v && v !== '-') title[LANGS[col]] = v;
        p = f.next; col++;
      }
      const name: Text | undefined = Object.keys(title).length ? title as unknown as Text : undefined;
      const res = orient(grid);
      if (res) raws.push({ ...res, name: name && (name.en || name.fr || name.de) ? name : undefined });
    }
    }

    // de-dup by cells
    const seen = new Set<string>(); let j = 0;
    for (const r of raws) if (!seen.has(r.cells)) { seen.add(r.cells); raws[j++] = r; }
    raws.length = j;

    if (!raws.length) throw new Error('No puzzle grids found in puzzles.uexp.');

    const allPaths = files.names.filter(n => n.startsWith(root)).join(' ');
    const sos = /STORYofSEASONS|StoryOfSeasons|PiczleCrossSoS|SoS/i.test(root + ' ' + allPaths) && !/Rune ?Factory/i.test(root + ' ' + allPaths);
    const id = sos ? 'nsw-piczle-cross-story-of-seasons' : 'nsw-piczle-cross-rune-factory';
    const title = sos ? 'Piczle Cross: Story of Seasons' : 'Piczle Cross: Rune Factory';
    const accent = sos ? '#2f9ee0' : '#c93a5b';
    return [pack(id, title, accent, raws)];
  },
});
