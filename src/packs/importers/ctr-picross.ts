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
import { jtexPixels, dominantColors, jtexImage, packPictures } from '../../rom/jtex';
import { isBcstm } from '../../audio/bcstm';

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
  const toPuzzle = (r: Raw, id: string): PackPuzzle => ({
    id, width: r.w, height: r.h,
    rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1),
    name: ownTitle(r.title),
  });
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
      const list = raws.filter(r => r.file.includes(`/Prs_${mode}_`)).map(r => {
        const p = toPuzzle(r, `${mode.toLowerCase()}-${r.file.match(/_(\d+)\.bprs$/)![1]}`);
        // the table ends with one title per puzzle (in mode order) and an empty entry
        for (const [lang, names] of titles) {
          const s = names[names.length - 1 - raws.length + k];
          if (s) p.name = { ...p.name, [lang]: s };
        }
        k++;
        return p;
      });
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
      const list = bySize.get(s)!.map((r, i) => toPuzzle(r, `${s}-${String(i + 1).padStart(2, '0')}`));
      const label = s.replace('x', '×');
      levels.push(...chunk(`s${s}-`, { en: label }, s, list));
    }
  }
  addMega(t.files, raws, levels);
  addNames(t, data, raws, levels);
  const title: Text = {};
  t.names.forEach((n, i) => { const l = SMDH_LANGS[i] as Lang; if (n && ['ja', 'en', 'fr', 'de', 'it', 'es', 'ko'].includes(l)) title[l] = n; });
  // identify the game across regions by its English (or Japanese) title, not the region-specific code
  // (first 64 characters: ids from versions that read shorter titles stay the same)
  const key = (title.en ?? title.ja ?? t.productCode).slice(0, 64).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  const { theme, assets } = music3ds(t.files);
  // the coloured solved pictures: per puzzle file the illustration (_I), else the coloured picture (_PC / _C)
  const byPath = new Map(t.files.map(f => [f.path, f]));
  const pics: Array<{ key: string; w: number; h: number; rgba: Uint8Array }> = [];
  for (const r of raws) {
    const base = r.file.replace(/\.bprs2?$/i, '');
    for (const suf of ['_I', '_PC', '_C']) {
      const f = byPath.get(base + suf + '.jtex');
      const img = f ? jtexImage(f.data) : null;
      if (!img) continue;
      // keyed by the puzzle's pattern, so the picture follows the puzzle into daily / random picks and merges
      pics.push({ key: [...Array(r.h)].map((_, y) => [...r.cells.subarray(y * r.w, y * r.w + r.w)].map(c => (c ? '#' : '.')).join('')).join('/'), ...img });
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
  detect: d => ctrEncrypted(d) === false,
  read: d => read3ds(d),
});
