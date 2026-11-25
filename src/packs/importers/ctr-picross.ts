// Jupiter's Picross games for Nintendo 3DS. One import method for all of them: the files inside the game
// (RomFS) are named the same way. Needs decrypted files; MomoGram decrypts nothing.
//
//  Game                            Product codes (CTR-N-…)   Puzzle names, besides the Japanese title in each puzzle file
//  Picross e                       JEX(J/E/P)                IdxRes_PrsTitle_<language>.dat, one entry per puzzle, mode order
//  Picross e2                      JP2(J/E/P)                IdxRes_PrsTitle_<language>.dat in play order; the play order
//                                                              itself is a list of puzzle numbers in the program (code.bin)
//  Picross e3 – e8                 JET, JEP, KPQ, KP6, KPA,  IdxRes_PuzzleBuiltin.dat: columns of puzzle file names
//                                    KP8 …                     (Prs_…), then the same columns per language
//  Picross e9                      (J; fan translation)      as e3 – e8
//  Club Nintendo Picross (+ Plus)  JPQJ, KXXJ                Plus: IdxRes_PuzzleBuiltin.dat (Japanese)
//  My Nintendo Picross: Zelda,     —                         Japanese titles only for now
//    Pokémon Picross, Sanrio …
//
// Puzzles: .bprs (title utf16[16], w, h, cells) or .bprs2 (".PRS" header, title, w, h, cells), LZ11 packed.
// Also read: the coloured solved pictures (_I / _PC / _C textures), the board colours (GameL textures),
// the music (.bcstm) and the icon.
import { registerImporter } from './index';
import { readCtr, ctrCode, lz11, ctrEncrypted, SMDH_LANGS, u16, u32, CtrFile, CtrTitle } from '../../rom/ctr';
import { Lang, Pack, PackLevel, PackPuzzle, PackTheme, PackAsset, Text, rowsFromBits, makeIcon } from '../format';
import { accentFromColors } from '../theme';
import { jtexPixels, dominantColors, jtexImage, jtexOldHeader, packPictures } from '../../rom/jtex';
import { isBcstm } from '../../audio/bcstm';
import { solutionCount } from '../../game/unique';

interface Raw { file: string; w: number; h: number; cells: Uint8Array; title: string }

/**
 * Mega Picross (.bdpc, ".DPC" header, LZ11): like .bprs2 (title, w, h, one byte per cell), then one byte per
 * column and per row: 1 = this line and the next form a pair. Then the clues (per plain line: count, numbers; per
 * pair: count, then type (1 = mega), number in the first line, number in the second line, 0xFF = none) and more
 * data MomoGram doesn't need: the clues follow from the picture and the pairs (game/mega.ts).
 */
export function parseDpc(d: Uint8Array, sizeHint?: [number, number]): { w: number; h: number; cells: Uint8Array; title: string; rows: number[]; cols: number[] } | null {
  if (!(d[0] === 0x2e && d[2] === 0x44 && d[4] === 0x50 && d[6] === 0x43)) return null;
  const n = u16(d, 10), p = 12 + n * 2;
  for (let q = p; q < p + 8; q++) {
    const w = d[q], h = d[q + 1];
    if (sizeHint ? w !== sizeHint[0] || h !== sizeHint[1] : w < 5 || h < 5 || w > 40 || h > 40) continue;
    const cells = d.subarray(q + 2, q + 2 + w * h);
    if (cells.length !== w * h || !cells.every(c => c <= 1)) continue;
    const f = q + 2 + w * h;
    const flags = d.subarray(f, f + w + h);
    if (flags.length !== w + h || !flags.every(c => c <= 1)) continue;
    const pairs = (a: Uint8Array) => [...a].flatMap((v, i) => (v ? [i] : []));
    return { w, h, cells, title: new TextDecoder('utf-16le').decode(d.subarray(12, p)), cols: pairs(flags.subarray(0, w)), rows: pairs(flags.subarray(w)) };
  }
  return null;
}

/**
 * .MRS ("Master" / "Micross") next to the .bprs2 files: utf16 ".MRS", a title, then the grid.
 * Sanrio and Pictlogica keep some puzzles only this way. A grid already stored as .bprs is not added twice.
 */
function parseMrs(f: CtrFile): Raw | null {
  const d = lz11(f.data);
  const td = new TextDecoder('utf-16le');
  let m = -1;
  for (let i = 0; i + 8 <= d.length && i < 128; i += 2) {
    if (d[i] === 0x2e && d[i + 2] === 0x4d && d[i + 4] === 0x52 && d[i + 6] === 0x53) { m = i; break; }
  }
  if (m < 0) return null;
  const n = u16(d, m + 10), p = m + 12 + n * 2;
  if (p < 0 || p > d.length) return null;
  const title = td.decode(d.subarray(m + 12, p)).replace(/\0.*$/, '').trim();
  const candidates: Array<[number, number]> = [];
  for (const [a, b] of [[d[p + 4], d[p + 5]], [d[p + 2], d[p + 3]], [d[p + 1], d[p + 2]], [d[p], d[p + 1]], [d[p + 5], d[p + 6]]]) {
    if (a === undefined || b === undefined) continue;
    if (a >= 3 && b >= 3 && a <= 25 && b <= 25) candidates.push([a, b]);
  }
  const seen = new Set<string>();
  let best: { w: number; h: number; cells: Uint8Array; score: number } | null = null;
  for (const [w, h] of candidates) {
    const k = `${w}x${h}`; if (seen.has(k)) continue; seen.add(k);
    if (w * h > 625 || w * h < 16) continue;
    const sweeps: Array<{ off: number; clue: boolean }> = [];
    for (let off = p + 2; off <= Math.min(p + 34, d.length - w * h); off++) {
      const g = d.subarray(off, off + w * h);
      if ([...g].some(v => v > 1)) continue;
      const fill = [...g].filter(v => v).length;
      if (fill < 3 || fill > w * h - 3) continue;
      sweeps.push({ off, clue: mrsCluesMatch(d, g, w, h, off + w * h) });
    }
    if (!sweeps.length) continue;
    let chosen = sweeps.find(s => s.clue) ?? null;
    if (!chosen) {
      for (const s of sweeps) {
        const rows: string[] = [];
        const g = d.subarray(s.off, s.off + w * h);
        for (let y = 0; y < h; y++) rows.push([...g.subarray(y * w, y * w + w)].map(v => (v ? '#' : '.')).join(''));
        if (solutionCount(rows, 200) === 1) { chosen = s; break; }
      }
    }
    chosen ??= sweeps[0];
    const score = (chosen.clue ? 2 : 0) + (chosen === sweeps[0] ? 0 : 1);
    if (!best || score > best.score) best = { w, h, cells: d.slice(chosen.off, chosen.off + w * h), score };
  }
  return best ? { file: f.path, title, w: best.w, h: best.h, cells: best.cells } : null;
}

function mrsCluesMatch(d: Uint8Array, grid: Uint8Array, w: number, h: number, after: number): boolean {
  const cols: number[][] = [];
  for (let x = 0; x < w; x++) {
    const line: number[] = []; let run = 0;
    for (let y = 0; y < h; y++) { if (grid[y * w + x]) run++; else if (run) { line.push(run); run = 0; } }
    if (run) line.push(run);
    cols.push(line);
  }
  if (!cols.length) return false;
  const seq: number[] = [];
  for (const line of cols) seq.push(line.length, ...line);
  for (let s = after; s + seq.length <= d.length && s <= after + 120; s++) {
    let ok = true;
    for (let i = 0; i < seq.length; i++) if (d[s + i] !== seq[i]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function parseBprs(f: CtrFile): Raw | null {
  const d = lz11(f.data);
  const td = new TextDecoder('utf-16le');
  if (/\.bprs2$/i.test(f.path)) {
    // ".PRS" magic (utf16), u16 version, u16 title length, title, then a few bytes before w,h
    const n = u16(d, 10), p = 12 + n * 2;
    const m = f.path.match(/(\d+)x(\d+)/);
    for (let q = p; q < p + 8; q++) {
      const w = d[q], h = d[q + 1];
      if (m ? (w === +m[1] && h === +m[2]) : (w >= 5 && h >= 5 && w <= 40 && h <= 40)) {
        const cells = d.subarray(q + 2, q + 2 + w * h);
        if (cells.length === w * h && cells.every(c => c <= 1)) return { file: f.path, w, h, cells, title: td.decode(d.subarray(12, p)) };
      }
    }
    return null;
  }
  const w = d[0x20], h = d[0x21];
  const cells = d.subarray(0x22, 0x22 + w * h);
  if (w < 1 || h < 1 || cells.length !== w * h || !cells.every(c => c <= 1)) return null;
  return { file: f.path, w, h, cells, title: td.decode(d.subarray(0, 0x20)).replace(/\0+$/, '') };
}

/** IdxRes string tables: u32 offsets, utf16 strings. The puzzle titles are the last N entries. */
function idxStrings(d: Uint8Array): string[] {
  d = lz11(d);
  const n = (d[0] | (d[1] << 8) | (d[2] << 16)) >> 2;
  const offs = [...Array(n)].map((_, i) => d[i * 4] | (d[i * 4 + 1] << 8) | (d[i * 4 + 2] << 16));
  const td = new TextDecoder('utf-16le');
  return offs.map((o, i) => td.decode(d.subarray(o, i + 1 < n ? offs[i + 1] : d.length)).replace(/\0+$/, ''));
}

const MODE: Record<string, { key: string; title: Text }> = {
  E: { key: 'easy', title: { en: 'Easy', de: 'Leicht', fr: 'Facile', it: 'Facile', es: 'Fácil', ja: 'かんたん' } },
  N: { key: 'normal', title: { en: 'Normal', de: 'Normal', fr: 'Normal', it: 'Normale', es: 'Normal', ja: 'ノーマル' } },
  F: { key: 'free', title: { en: 'Free', de: 'Frei', fr: 'Libre', it: 'Libera', es: 'Libre', ja: 'フリー' } },
  X: { key: 'extra', title: { en: 'Extra', de: 'Extra', fr: 'Extra', it: 'Extra', es: 'Extra', ja: 'エクストラ' } },
};
const IDX_LANG: Record<string, Lang> = { English: 'en', French: 'fr', Germany: 'de', German: 'de', Italian: 'it', Spanish: 'es', Japanese: 'ja' };

function chunk(prefix: string, title: Text, group: string, puzzles: PackPuzzle[]): PackLevel[] {
  const out: PackLevel[] = [];
  for (let i = 0; i < puzzles.length; i += 15) {
    const k = i / 15 + 1, many = puzzles.length > 15;
    const t: Text = {};
    for (const [l, v] of Object.entries(title)) t[l as Lang] = many ? `${v} ${k}` : v;
    out.push({ id: `${prefix}${k}`, title: t, rules: 'free', group, puzzles: puzzles.slice(i, i + 15) });
  }
  return out;
}

export function read3ds(data: Uint8Array): Pack[] {
  const t = readCtr(data);
  const raws = t.files.filter(f => /\.bprs2?$/i.test(f.path) && !/sample/i.test(f.path)).map(parseBprs).filter((r): r is Raw => !!r);
  if (!raws.length) throw new Error('No puzzles found in this 3DS title.');
  raws.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
  const mrs = t.files.map(f => ({ f, r: /\/.*\.(mrs|bmrs)$/i.test(f.path) ? parseMrs(f) : null })).filter((x): x is { f: CtrFile; r: Raw } => !!x.r);
  const toPuzzle = (r: Raw, id: string): PackPuzzle => ({
    id, width: r.w, height: r.h,
    rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1),
    name: ownTitle(r.title),
  });
  // a grid listed again in the same mode is a placeholder (Club Nintendo Easy 12–15 are one melon, four identical files).
  // The solved picture is stored once per grid, so that comparison never removed the extra puzzles.
  const fresh = (seen: Set<string>, p: PackPuzzle) => { const k = p.rows.join('/'); return seen.has(k) ? false : (seen.add(k), true); };
  const levels: PackLevel[] = [];
  const modeStyle = raws.every(r => /\/Prs_[ENFX]_\d+\.bprs$/.test(r.file));
  if (modeStyle) {
    // Picross e: Easy, Normal, Free, Extra; localized titles in mode order
    const titles = new Map<Lang, string[]>();
    for (const f of t.files) {
      const m = f.path.match(/IdxRes_PrsTitle_(\w+)\.dat$/);
      if (m && IDX_LANG[m[1]]) titles.set(IDX_LANG[m[1]], idxStrings(f.data));
    }
    let k = 0;
    for (const mode of ['E', 'N', 'F', 'X']) {
      const seen = new Set<string>();
      const list: PackPuzzle[] = [];
      for (const r of raws.filter(r => r.file.includes(`/Prs_${mode}_`))) {
        const p = toPuzzle(r, `${mode.toLowerCase()}-${r.file.match(/_(\d+)\.bprs$/)![1]}`);
        // the table ends with one title per puzzle (in mode order) and an empty entry
        for (const [lang, names] of titles) {
          const s = names[names.length - 1 - raws.length + k];
          if (s) p.name = { ...p.name, [lang]: s };
        }
        k++;
        if (fresh(seen, p)) list.push(p);
      }
      levels.push(...chunk(MODE[mode].key, MODE[mode].title, MODE[mode].key, list));
    }
  } else {
    // later games: files grouped by size (…_15x15_07.bprs / E9_20x15_03.bprs2)
    const bySize = new Map<string, Raw[]>();
    for (const r of raws) {
      const key = `${r.w}x${r.h}`;
      (bySize.get(key) ?? bySize.set(key, []).get(key)!).push(r);
    }
    const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
    for (const s of sizes) {
      const seen = new Set<string>();
      const list: PackPuzzle[] = [];
      bySize.get(s)!.forEach((r, i) => {
        const p = toPuzzle(r, `${s}-${String(i + 1).padStart(2, '0')}`);
        if (fresh(seen, p)) list.push(p);
      });
      const label = s.replace('x', '×');
      levels.push(...chunk(`s${s}-`, { en: label }, s, list));
    }
  }
  addMega(t.files, raws, levels);
  addMrs(mrs, levels);
  addNames(t, data, raws, levels);
  const title: Text = {};
  t.names.forEach((n, i) => { const l = SMDH_LANGS[i] as Lang; if (n && ['ja', 'en', 'fr', 'de', 'it', 'es', 'ko'].includes(l)) title[l] = n; });
  // identify the game across regions by its English (or Japanese) title, not the region-specific code
  // (first 64 characters: ids from versions that read shorter titles stay the same)
  const key = (title.en ?? title.ja ?? t.productCode).slice(0, 64).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  // the only My Nintendo Picross is the Zelda one, but its title only says "My Nintendo Picross"
  fullTitle(title);
  const { theme, assets } = music3ds(t.files);
  // the coloured solved pictures: per puzzle file the illustration (_I), else the coloured picture (_PC / _C)
  const byPath = new Map(t.files.map(f => [f.path, f]));
  const pics: Array<{ key: string; w: number; h: number; rgba: Uint8Array }> = [];
  const seenPic = new Set<string>();
  const pictureRaws = [...raws, ...mrs.map(m => m.r)];
  const upright = uprightPictures(pictureRaws, byPath);
  for (const r of pictureRaws) {
    const base = r.file.replace(/\.bprs2?|\.\w*mrs$/i, '');
    for (const suf of ['_I', '_PC', '_C']) {
      const f = byPath.get(base + suf + '.jtex');
      const img = f ? jtexImage(f.data, upright) : null;
      if (!img) continue;
      // keyed by the puzzle's pattern, so the picture follows the puzzle into daily / random picks and merges.
      // a second file with the same grid is the same picture; it is not stored again
      const key = [...Array(r.h)].map((_, y) => [...r.cells.subarray(y * r.w, y * r.w + r.w)].map(c => (c ? '#' : '.')).join('')).join('/');
      if (!seenPic.has(key)) { seenPic.add(key); pics.push({ key, ...img }); }
      break;
    }
  }
  if (pics.length) { assets.push({ name: 'pictures.bin', data: packPictures(pics) }); theme.pictures = true; }
  const accent = accentFromColors(t.iconColors);
  const board = boardColors(t.files);
  theme.palette = { style: '3ds', accent: accent ?? board?.cursor ?? '#1f9be0', ...board, ...KNOWN_LOOKS.find(([re]) => re.test(key))?.[1] };
  return [{
    icon: t.icon ? makeIcon(48, 48, t.icon) : undefined,
    theme,
    assets: assets.length ? assets : undefined,
    format: 'momogram-pack', version: 1,
    id: 'ctr-' + key,
    title: Object.keys(title).length ? title : { en: t.productCode },
    source: { game: title.en ?? title.ja ?? t.productCode, platform: 'Nintendo 3DS', region: t.productCode.slice(-1), developer: 'Jupiter' },
    levels,
  }];
}

/** titles that don't say which game they are (the pack id stays the one made from the short title) */
export function fullTitle(title: Partial<Record<string, string>>): boolean {
  if (!Object.values(title).some(v => /^my nintendo picross$/i.test(v ?? '') || /^マイニンテンドー\s*ピクロス$/.test(v ?? ''))) return false;
  // short, it has to fit on a game card
  for (const [l, v] of Object.entries(title)) if (v) title[l] = l === 'ja' ? 'マイニンテンドー: ゼルダの伝説 TP' : 'MyNintendo: Legend of Zelda TP';
  return true;
}

/**
 * Are this game's old-style textures stored top-down? Decided on the coloured pictures that have the puzzle's
 * size: the right way up, filled cells and empty cells differ most in brightness.
 */
function uprightPictures(raws: Raw[], byPath: Map<string, CtrFile>): boolean {
  let votes = 0;
  for (const r of raws.slice(0, 40)) {
    const f = byPath.get(r.file.replace(/\.bprs2?$/i, '') + '_C.jtex');
    if (!f || !jtexOldHeader(f.data)) continue;
    const contrast = (up: boolean) => {
      const img = jtexImage(f.data, up);
      if (!img || img.w !== r.w || img.h !== r.h) return 0;
      let a = 0, na = 0, b = 0, nb = 0;
      for (let i = 0; i < r.w * r.h; i++) {
        const l = img.rgba[i * 4] * 0.3 + img.rgba[i * 4 + 1] * 0.59 + img.rgba[i * 4 + 2] * 0.11;
        if (r.cells[i]) { a += l; na++; } else { b += l; nb++; }
      }
      return na && nb ? Math.abs(a / na - b / nb) : 0;
    };
    const d = contrast(true) - contrast(false);
    if (Math.abs(d) > 1) votes += d > 0 ? 1 : -1;
  }
  return votes > 0;
}

// ---- Mega Picross (PICROSS e6 and later): the pairs of each puzzle, and the puzzles that exist only as Mega ----
function addMega(files: CtrFile[], raws: Raw[], levels: PackLevel[]) {
  const byRows = new Map<string, PackPuzzle>();
  for (const l of levels) for (const p of l.puzzles) byRows.set(p.rows.join('/'), p);
  const only: Array<{ size: string; p: PackPuzzle }> = [];
  for (const f of files.filter(f => /\.bdpc$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))) {
    const m = f.path.match(/(\d+)x(\d+)/);
    const dpc = parseDpc(lz11(f.data), m ? [+m[1], +m[2]] : undefined);
    if (!dpc) continue;
    const rows = rowsFromBits(dpc.w, dpc.h, (x, y) => dpc.cells[y * dpc.w + x] === 1);
    const mega = { rows: dpc.rows, cols: dpc.cols };
    const known = byRows.get(rows.join('/'));
    if (known) { known.mega = mega; continue; }
    // Dpc_15x15_s03: a puzzle of the Mega mode only
    const size = `${dpc.w}x${dpc.h}`;
    const n = only.filter(o => o.size === size).length + 1;
    only.push({ size, p: { id: `mega-${size}-${String(n).padStart(2, '0')}`, width: dpc.w, height: dpc.h, rows, name: ownTitle(dpc.title), mega, megaOnly: true } });
  }
  if (only.length) levels.push(...chunk('mega-', { en: 'Mega', de: 'Mega', fr: 'Méga', it: 'Mega', es: 'Mega', ja: 'デカ' }, 'mega', only.map(o => o.p)));
  void raws;
}

/** .MRS puzzles that are not already in the pack, grouped by size */
function addMrs(mrs: Array<{ f: CtrFile; r: Raw }>, levels: PackLevel[]) {
  if (!mrs.length) return;
  const sorted = [...mrs].sort((a, b) => a.r.file.localeCompare(b.r.file, 'en', { numeric: true }));
  const have = new Set<string>();
  for (const l of levels) for (const p of l.puzzles) have.add(p.rows.join('/'));
  const bySize = new Map<string, Array<{ r: Raw; id: string }>>();
  for (const { f, r } of sorted) {
    const rows = rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1);
    if (have.has(rows.join('/'))) continue;
    have.add(rows.join('/'));
    const base = f.path.split('/').pop()!.replace(/\.\w+$/i, '');
    bySize.set(`${r.w}x${r.h}`, [...(bySize.get(`${r.w}x${r.h}`) || []), { r, id: base }]);
  }
  const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
  const out: PackLevel[] = [];
  for (const s of sizes) {
    const list = bySize.get(s)!.map(({ r, id }) => ({ id: 'mr-' + id, width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1), name: ownTitle(r.title) }));
    out.push(...chunk(`mrs${s}-`, { en: s.replace('x', '×') }, 'mrs', list));
  }
  if (out.length) out[0].groupTitle = { en: 'Micross', ja: 'マイクロス' };
  levels.push(...out);
}

// ---- the board's look: the colours a game's textures don't give, measured from screenshots ----
const KNOWN_LOOKS: Array<[RegExp, Partial<NonNullable<PackTheme['palette']>>]> = [
  [/^picross-e$/, { fill: '#40b0f8', cursor: '#40b0f8' }],
  [/^picross-e3$/, { fill: '#f870a8', cursor: '#f870a8', accent: '#c8407a' }],
  // Pokémon Picross: dark cells on pale green, orange crosses, an amber cursor line
  [/pok.?mon/, { fill: '#484858', cell: '#dfe8bc', cross: '#e88000', cursor: '#e8c050', accent: '#c87800', board: { clueArea: '#eef3d8', clueAreaAlt: '#e2eac6', clueBg: '#eef3d8', clueBgAlt: '#e2eac6', grid5: '#e88000' } }],
  // Sanrio Characters Picross: brown cells on cream, brown crosses, a turquoise cursor line
  [/sanrio/, { fill: '#987840', cell: '#f8e8c0', cross: '#987840', cursor: '#40d0d8', accent: '#a07838', board: { clueArea: '#fbf6dc', clueAreaAlt: '#f3edcc', clueBg: '#fbf6dc', clueBgAlt: '#f3edcc', grid: '#c8b890', grid5: '#40c0d0' } }],
];

// ---- puzzle names ----

/** the title stored in a puzzle file: Japanese, or English in translations; placeholders and dev names are skipped */
function ownTitle(s: string): Text | undefined {
  s = s.replace(/\0.*$/, '').trim();
  if (!s || /タイトルを入力/.test(s)) return undefined;
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(s)) return { ja: s };
  if (/^[\x20-\x7e]+$/.test(s) && /^[A-Z0-9]|\s/.test(s)) return { en: s };
  return undefined;
}

const td16 = new TextDecoder('utf-16le');
/** IdxRes resources: u32 offsets (LZ11 packed), each entry a UTF-16 block */
function idxEntries(raw: Uint8Array): string[] {
  const d = lz11(raw);
  const n = (u32(d, 0) & 0xffffff) >> 2;
  const offs = [...Array(n)].map((_, i) => u32(d, i * 4) & 0xffffff);
  return offs.map((o, i) => { const e = d.subarray(o, i + 1 < n ? offs[i + 1] : d.length); return td16.decode(e.subarray(0, e.length & ~1)); });
}

/** language columns per round, by number of rounds (USA releases: 3, European: 5, Japanese: 1) */
const ROUND_LANGS: Record<number, Lang[]> = { 1: ['ja'], 3: ['en', 'fr', 'es'], 5: ['en', 'fr', 'it', 'de', 'es'] };

/**
 * IdxRes_PuzzleBuiltin (e3 and later): columns of strings. First the key columns (file names like Prs_10x10_04,
 * in play order), then for every language the same columns with the names. Columns are matched by length.
 */
function builtinNames(f: CtrFile): Map<string, Text> {
  const cols = idxEntries(f.data).map(s => { const a = s.split('\0'); while (a.length && a[a.length - 1] === '') a.pop(); return a; });
  const isKey = (c: string[]) => c.length > 0 && c.every(s => /^(Prs|Dpc|Mrs|filename)_/.test(s));
  let last = -1;
  const keys: string[][] = [];
  for (let i = 0; i < cols.length; i++) {
    if (!cols[i].length) continue;
    if (isKey(cols[i])) { keys.push(cols[i]); last = i; } else if (keys.length) break;
  }
  const out = new Map<string, Text>();
  const named = cols.slice(last + 1).filter(c => c.length && !isKey(c));
  for (const len of new Set(keys.map(k => k.length))) {
    const ks = keys.filter(k => k.length === len), ns = named.filter(c => c.length === len);
    const langs = ROUND_LANGS[ns.length / ks.length];
    if (!langs) continue;
    langs.forEach((lang, li) => ks.forEach((k, j) => {
      if (!k[0].startsWith('Prs_')) return;
      const col = ns[li * ks.length + j];
      k.forEach((file, row) => { const s = col[row]?.trim(); if (s) out.set(file, { ...out.get(file), [lang]: s }); });
    }));
  }
  return out;
}

/** a list of 32-bit numbers in the program that is an ordering of 0 … n-1 (the play order of n puzzles) */
function playOrder(code: Uint8Array, n: number): number[] | null {
  for (let o = 0; o + n * 4 <= code.length; o += 4) {
    if (u32(code, o) >= n) continue;
    const seen = new Uint8Array(n);
    let ok = true;
    for (let i = 0; i < n && ok; i++) { const v = u32(code, o + i * 4); ok = v < n && !seen[v]; seen[v] = 1; }
    if (ok) return [...Array(n)].map((_, i) => u32(code, o + i * 4));
  }
  return null;
}

/** names from the game's tables, added to the Japanese titles of the puzzle files */
function addNames(t: CtrTitle, data: Uint8Array, raws: Raw[], levels: PackLevel[]) {
  const all = levels.flatMap(l => l.puzzles);
  const byFile = new Map<string, PackPuzzle>();
  // puzzles were made from raws in this order (sizes, then files): rebuild the link by pattern
  const key = (w: number, h: number, rows: string[]) => `${w}x${h}:${rows.join('/')}`;
  const pz = new Map(all.map(p => [key(p.width, p.height, p.rows), p]));
  for (const r of raws) {
    const p = pz.get(key(r.w, r.h, rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1)));
    if (p) byFile.set(r.file.replace(/^.*\/|\.bprs2?$/g, ''), p);
  }
  const add = (p: PackPuzzle | undefined, n: Text) => { if (p) p.name = { ...p.name, ...n }; };
  const builtin = t.files.find(f => /IdxRes_PuzzleBuiltin\.dat$/.test(f.path));
  if (builtin) {
    for (const [file, n] of builtinNames(builtin)) add(byFile.get(file), n);
    return;
  }
  // e2: name tables in play order; the order is a list in the program
  const tables = t.files.map(f => [f.path.match(/IdxRes_PrsTitle_(\w+)\.dat$/)?.[1], f] as const).filter(([l]) => l && IDX_LANG[l!]);
  if (!tables.length) return;
  const lists = tables.map(([l, f]) => { const e = idxEntries(f.data); return [IDX_LANG[l!], e.length === 4 && e[2].includes('\0') ? e[2].split('\0') : null] as const; });
  if (lists.some(([, v]) => !v) || lists.some(([, v]) => v!.length < all.length)) return; // Picross e: handled with its modes
  const code = ctrCode(data);
  const order = code ? playOrder(code, all.length) : null;
  if (!order) return;
  order.forEach((g, i) => { const n: Text = {}; for (const [l, v] of lists) if (v![i]?.trim()) n[l] = v![i].trim(); add(all[g], n); });
}

/**
 * The game's own board colours, from its in-game textures (GameL_<size>_Bg / _Paint / _Check / _Cursor / _Number).
 * Only formats that decode unambiguously are used; anything else keeps MomoGram's colours for that part.
 */
function boardColors(files: CtrFile[]): Partial<NonNullable<PackTheme['palette']>> | null {
  const tex = (part: string) => {
    const f = files.find(x => new RegExp(`/GameL_1010_${part}\\.jtex$`).test(x.path)) ?? files.find(x => new RegExp(`/GameL_\\d{4}_${part}\\.jtex$`).test(x.path));
    const px = f ? jtexPixels(f.data) : null;
    return px ? dominantColors(px) : null;
  };
  const lum = (c: [number, number, number]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const sat = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);
  const out: Record<string, string> = {};
  const bg = tex('Bg');
  if (bg?.length) { const light = bg.filter(c => lum(c.rgb) > 170); if (light[0]) out.cell = light[0].hex; }
  const paint = tex('Paint');
  if (paint?.length) { const dark = paint.filter(c => lum(c.rgb) < 140); if (dark[0]) out.fill = dark[0].hex; }
  const check = tex('Check');
  if (check?.length && sat(check[0].rgb) > 60) out.cross = check[0].hex;
  const cur = tex('Cursor');
  if (cur?.length && sat(cur[0].rgb) > 60) out.cursor = cur[0].hex;
  const num = tex('Number');
  if (num?.length) {
    const dark = num.find(c => lum(c.rgb) < 60); if (dark) out.clue = dark.hex;
    const blue = num.find(c => c.rgb[2] > 150 && c.rgb[0] < 80); if (blue) out.hint = blue.hex;
  }
  return Object.keys(out).length ? out : null;
}

// Stream music (.bcstm) by role. Picross e-style names: GA = in game, ME = menu, MG / MI = Mega / Micross;
// Pokémon Picross style: Bgm_Home, Bgm_Picross, Jingle_Cliear, …
const ROLES: Array<[keyof NonNullable<PackTheme['music']>, RegExp]> = [
  ['play', /(^|_)(ga_b_00|bgm_picross|bgm_normal)\b/i],
  ['play2', /(^|_)(mg_b_00|bgm_mega|mi_b_00|bgm_micross|ga_b_01)\b/i],
  ['menu', /(^|_)(me_b_00|bgm_home)\b/i],
  ['title', /(^|_)(bgm_title|me_b_01|tu_b_00)\b/i],
  ['clear', /(^|_)(jingle_cliear|jingle_clear)\b/i],
];

function music3ds(files: CtrFile[]): { theme: PackTheme; assets: PackAsset[] } {
  const theme: PackTheme = {};
  const assets: PackAsset[] = [];
  const streams = files.filter(f => /\.bcstm$/i.test(f.path) && isBcstm(f.data));
  const nameOf = (f: CtrFile) => f.path.split('/').pop()!.replace(/\.dspadpcm/i, '');
  // every stream is a song of the game; the roles pick the ones it plays where
  for (const f of streams) if (!assets.some(a => a.name === nameOf(f))) assets.push({ name: nameOf(f), data: f.data.slice() });
  for (const [role, re] of ROLES) {
    const f = streams.find(s => re.test(nameOf(s).replace(/\.bcstm$/i, '')));
    if (f) (theme.music ??= {})[role] = nameOf(f);
  }
  if (assets.length) theme.songs = assets.map(a => a.name);
  return { theme, assets };
}

registerImporter({
  name: 'Nintendo 3DS',
  version: 4, // raise when the importer reads more or reads differently
  // packs read before a title was made complete keep their id, only the title changes
  upgrade: p => p.id.startsWith('ctr-') && fullTitle(p.title as Record<string, string>),
  detect: d => ctrEncrypted(d) === false,
  read: d => read3ds(d),
});
