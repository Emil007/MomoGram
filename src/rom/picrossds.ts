// Reads the puzzle set, names and level structure out of the user's Picross DS ROM.
import { NdsRom, Overlay, u32, sdatSongs } from './nds';
import { Lang, Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../packs/format';

const REC = 140; // w u32, h u32, title utf16[16], unused, rows u32[20] at +60; column x is bit 24-x

export interface DsAnimRef {
  /** pck file indices of the 16-colour palette and 4bpp tiles for the solved picture */
  palette: number;
  tiles: number;
  /** animation script: list of [oamCells(attr0,attr1,attr2)[], frames] */
  script: Array<{ cells: Array<[number, number, number]>; frames: number }>;
  loopTo: number;
}

export interface DsPuzzle extends PackPuzzle {
  anim?: DsAnimRef;
}

export interface PicrossDsData {
  region: 'EUR' | 'USA' | 'JPN' | 'KOR' | 'DEMO';
  gameCode: string;
  pack: Pack; // Easy, Normal 1-10 + Extra, Free 1-10 + Extra
  daily7: PackPuzzle[];
  daily10: PackPuzzle[];
  languages: Lang[];
  pck: Uint8Array | null;
  pckOffsets: number[];
  sdat: Uint8Array | null;
}

interface RawRec { off: number; w: number; h: number; title: string; rows: number[] }

function scanRecords(d: Uint8Array): RawRec[] {
  const out: RawRec[] = [];
  const td = new TextDecoder('utf-16le');
  for (let i = 0; i + REC <= d.length; ) {
    const w = u32(d, i), h = u32(d, i + 4);
    if (w >= 5 && w <= 32 && h >= 5 && h <= 20) {
      const title = td.decode(d.subarray(i + 8, i + 60)).split('\0')[0];
      if (title && [...title].every(c => c >= ' ')) {
        const rows: number[] = [];
        for (let y = 0; y < h; y++) rows.push(u32(d, i + 60 + y * 4));
        out.push({ off: i, w, h, title, rows });
        i += REC;
        continue;
      }
    }
    i += 4;
  }
  return out;
}

function utf16z(d: Uint8Array, o: number): string {
  let e = o;
  while (e + 1 < d.length && (d[e] | d[e + 1])) e += 2;
  return new TextDecoder('utf-16le').decode(d.subarray(o, e));
}

/** Pointer table near the end of a puzzle overlay giving the display order of the 15 records. */
function displayOrder(ov: Overlay, recs: RawRec[]): number[] {
  const d = ov.data;
  const want = new Map(recs.map((r, i) => [ov.ramAddress + r.off, i]));
  for (let i = 0; i + 60 <= d.length; i += 4) {
    const idx: number[] = [];
    for (let k = 0; k < recs.length; k++) {
      const v = want.get(u32(d, i + k * 4));
      if (v === undefined) break;
      idx.push(v);
    }
    if (idx.length === recs.length && new Set(idx).size === idx.length) return idx;
  }
  return recs.map((_, i) => i);
}

/** Solved-picture animation data that accompanies each puzzle set. */
function parseAnims(ov: Overlay, recs: RawRec[], order: number[], pckSize: (i: number) => number): (DsAnimRef | undefined)[] {
  const d = ov.data, base = ov.ramAddress, end = base + d.length;
  const inOv = (p: number) => p >= base && p < end;
  const n = recs.length;
  const res: (DsAnimRef | undefined)[] = new Array(n).fill(undefined);
  // pck index lists: two runs of n consecutive integers (one run of palettes, one of tile sheets)
  let listA: number[] | null = null, listB: number[] | null = null;
  for (let i = 0; i + n * 8 <= d.length && !listB; i += 4) {
    const a = u32(d, i);
    if (a < 1 || a > 4000) continue;
    let ok = true;
    for (let k = 1; k < n * 2 && ok; k++) {
      const v = u32(d, i + k * 4), prev = u32(d, i + (k - 1) * 4);
      ok = k === n ? v > 0 && v < 4000 : v === prev + 1;
    }
    if (ok) {
      listA = [...Array(n)].map((_, k) => u32(d, i + k * 4));
      listB = [...Array(n)].map((_, k) => u32(d, i + (n + k) * 4));
    }
  }
  if (!listA || !listB) return res;
  const [palettes, tiles] = pckSize(listA[0]) <= 64 ? [listA, listB] : [listB, listA];
  // record pointer table (display order); just before it, the per-puzzle animation entries
  // (fnInit, fnFree, scriptPtr), either inline or as a table of pointers to such entries
  const recPtr = new Set(recs.map(r => base + r.off));
  let tbl = -1;
  for (let i = 0; i + n * 4 <= d.length && tbl < 0; i += 4) {
    let all = true;
    for (let k = 0; k < n && all; k++) all = recPtr.has(u32(d, i + k * 4));
    if (all) tbl = i;
  }
  if (tbl < 0) return res;
  const scriptPtrs: number[] = [];
  const looksInline = tbl >= n * 12 && [...Array(n)].every((_, k) => inOv(u32(d, tbl - n * 12 + k * 12 + 8)) && !inOv(u32(d, tbl - n * 12 + k * 12)));
  if (looksInline) for (let k = 0; k < n; k++) scriptPtrs.push(u32(d, tbl - n * 12 + k * 12 + 8));
  else for (let k = 0; k < n; k++) {
    const e = u32(d, tbl - n * 4 + k * 4);
    scriptPtrs.push(inOv(e) ? u32(d, e - base + 8) : 0);
  }
  for (let di = 0; di < n; di++) {
    const sp = scriptPtrs[di];
    if (!inOv(sp)) continue;
    const script: DsAnimRef['script'] = [];
    let p = sp - base, loopTo = 0;
    const starts = new Map<number, number>();
    for (let guard = 0; guard < 1024 && p + 8 <= d.length; guard++) {
      // "show cell" commands are 16 bytes: fn, scale, frames|0x80000000, cellPtr; a jump is fn, target
      const dur = u32(d, p + 8), cell = u32(d, p + 12);
      if ((dur & 0x80000000) && inOv(cell)) {
        const c = cell - base, count = d[c] | (d[c + 1] << 8);
        const cells: Array<[number, number, number]> = [];
        for (let k = 0; k < count && k < 64; k++) {
          const o = c + 2 + k * 6;
          cells.push([d[o] | (d[o + 1] << 8), d[o + 2] | (d[o + 3] << 8), d[o + 4] | (d[o + 5] << 8)]);
        }
        starts.set(p, script.length);
        script.push({ cells, frames: dur & 0xffff });
        p += 16;
      } else if (inOv(u32(d, p + 4))) {
        loopTo = starts.get(u32(d, p + 4) - base) ?? 0;
        break;
      } else break;
    }
    if (!script.length) continue;
    const ri = order[di];
    res[ri] = { palette: palettes[di], tiles: tiles[di], script, loopTo };
  }
  return res;
}

const EU_LANGS: Lang[] = ['fr', 'de', 'it', 'en', 'es'];

function nameOverlay(ov: Overlay): string[] | null {
  const d = ov.data, base = ov.ramAddress;
  let end = d.length;
  while (end >= 4 && u32(d, end - 4) === 0) end -= 4;
  const ptrs: number[] = [];
  for (let j = end; j >= 4; j -= 4) {
    const v = u32(d, j - 4);
    if (v >= base && v < base + d.length) ptrs.unshift(v);
    else break;
  }
  // 75 string pointers (5 languages x 15), followed by 5 pointers to the start of each language list
  const strs = ptrs.filter(p => !(p >= base + (end - ptrs.length * 4)));
  if (strs.length < 75) return null;
  return strs.slice(0, 75).map(p => utf16z(d, p - base));
}

function msgList(rom: NdsRom, name: string): string[] | null {
  const d = rom.fileByName(name);
  if (!d) return null;
  // layout: BOM, u32 offsets[count] (relative to the text block), text block of "\n"-prefixed strings
  if (u32(d, 2) !== 0) return null;
  let best = 0;
  for (let c = 1; 2 + 4 * c + 2 <= d.length; c++) {
    const start = 2 + 4 * c;
    const last = u32(d, 2 + 4 * (c - 1));
    if (c > 1 && last <= u32(d, 2 + 4 * (c - 2))) break; // offsets must keep increasing
    if (d[start] !== 0x0a || d[start + 1] !== 0) continue;
    let ok = true;
    for (let k = 0; k < c && ok; k++) {
      const o = start + u32(d, 2 + 4 * k);
      ok = o + 1 < d.length && d[o] === 0x0a && d[o + 1] === 0;
    }
    if (ok) best = c;
  }
  if (!best) return null;
  const start = 2 + 4 * best;
  const offs = [...Array(best)].map((_, k) => u32(d, 2 + 4 * k));
  const td = new TextDecoder('utf-16le');
  return offs.map((o, k) => td.decode(d.subarray(start + o + 2, k + 1 < best ? start + offs[k + 1] : d.length)).replace(/\0+$/, ''));
}

function findOverlayTable(arm9: Uint8Array, ovs: Map<number, Overlay>) {
  // u32 table in ARM9: 5 daily 10x10 sets, then two runs of 11 descending puzzle-set overlay ids
  // (Normal and Free, order differs per region; the European ROM puts name tables between them),
  // then 12 daily 7x7 sets.
  const n = arm9.length >> 2;
  const run = (at: number) => [...Array(11)].map((_, k) => u32(arm9, (at + k) * 4));
  const asc = (r: number[]) => r.every((v, k) => k === 0 || v - r[k - 1] === 1);
  const desc = (r: number[]) => r.every((v, k) => k === 0 || r[k - 1] - v === 1);
  const sizes = (id: number) => scanRecords(ovs.get(id)?.data ?? new Uint8Array()).map(r => r.w * 100 + r.h);
  for (let i = 5; i < n - 60; i++) {
    const first = u32(arm9, i * 4);
    if (first < 20 || first > 200 || !desc(run(i))) continue;
    const daily10 = [...Array(5)].map((_, k) => u32(arm9, (i - 5 + k) * 4));
    const A = run(i);
    let j = i + 11, namesA: number[] | null = null, namesB: number[] | null = null;
    if (asc(run(j))) { namesA = run(j); j += 11; }
    const B = run(j);
    if (!desc(B) || B.some(id => !ovs.has(id))) continue;
    j += 11;
    if (namesA && asc(run(j))) { namesB = run(j); j += 11; }
    const daily7 = [...Array(12)].map((_, k) => u32(arm9, (j + k) * 4));
    // Normal has five 15x15 levels, Free has four
    const count15 = (r: number[]) => r.filter(id => sizes(id)[0] === 1515).length;
    const aIsNormal = count15(A) > count15(B);
    const normal = aIsNormal ? A : B, free = aIsNormal ? B : A;
    // Europe: the name run after the first set belongs to the *other* mode (verified against content)
    const normalNames = aIsNormal ? namesB : namesA;
    const freeNames = aIsNormal ? namesA : namesB;
    // Easy: the remaining 15-puzzle set that contains 5x5 puzzles
    let easy = -1;
    for (const [id, o] of ovs) {
      if (A.includes(id) || B.includes(id)) continue;
      const r = scanRecords(o.data);
      if (r.length === 15 && r.some(x => x.w === 5 && x.h === 5) && r.some(x => x.w === 10)) { easy = id; break; }
    }
    return { daily10, free, normal, easy, daily7, freeNames, normalNames };
  }
  return null;
}

function findPckOffsets(arm9: Uint8Array, pckLen: number): number[] {
  const n = arm9.length >> 2;
  for (let i = 0; i < n; i++) {
    if (u32(arm9, i * 4) !== 0) continue;
    const offs = [0];
    let j = i + 1;
    while (j < n) {
      const v = u32(arm9, j * 4);
      if (v <= offs[offs.length - 1] || v > pckLen) break;
      offs.push(v);
      j++;
      if (v === pckLen) break;
    }
    if (offs.length > 100 && offs[offs.length - 1] === pckLen) return offs;
  }
  return [];
}

const LEVEL_TITLES: Record<string, Text> = {
  easy: { en: 'Easy', de: 'Leicht', fr: 'Facile', it: 'Facile', es: 'Fácil', ja: 'かんたん', ko: '쉬움' },
  normal: { en: 'Normal', de: 'Normal', fr: 'Normal', it: 'Normale', es: 'Normal', ja: 'ノーマル', ko: '노멀' },
  free: { en: 'Free', de: 'Frei', fr: 'Libre', it: 'Libera', es: 'Libre', ja: 'フリー', ko: '프리' },
};

function levelTitle(mode: 'normal' | 'free', i: number): Text {
  const base = LEVEL_TITLES[mode];
  const t: Text = {};
  for (const [k, v] of Object.entries(base)) t[k as Lang] = i === 10 ? `${v} Extra` : `${v} ${i + 1}`;
  return t;
}

export function readPicrossDs(data: Uint8Array): PicrossDsData {
  const rom = new NdsRom(data);
  if (!/^AXP/.test(rom.gameCode) && rom.title !== 'PICROSSDS') throw new Error('This is not Picross DS (game code ' + rom.gameCode + ').');
  const region: PicrossDsData['region'] = ({ P: 'EUR', E: 'USA', J: 'JPN', K: 'KOR' } as Record<string, PicrossDsData['region']>)[rom.gameCode[3]] ?? 'DEMO';
  const arm9 = rom.arm9().data;
  const ovs = new Map(rom.overlays().map(o => [o.id, o]));
  const tbl = findOverlayTable(arm9, ovs);
  if (!tbl) throw new Error('Could not find the puzzle tables in this Picross DS ROM.');

  const languages: Lang[] = region === 'EUR' ? ['en', 'de', 'fr', 'it', 'es'] : region === 'USA' ? ['en', 'fr', 'es'] : region === 'KOR' ? ['ko', 'en'] : ['ja'];

  // localized names in display order
  const namesFor = (kind: 'Easy' | 'Normal' | 'Free', set: number, ovNames: number | null): Text[] => {
    const out: Text[] = [...Array(15)].map(() => ({}));
    if (ovNames !== null) {
      const o = ovs.get(ovNames);
      const list = o ? nameOverlay(o) : null;
      if (list) for (let li = 0; li < 5; li++) for (let k = 0; k < 15; k++) out[k][EU_LANGS[li]] = list[li * 15 + k];
    }
    for (const [code, lang] of [['ENG', 'en'], ['FRE', 'fr'], ['SPA', 'es']] as const) {
      const all = msgList(rom, `Msg/PicrossDS_messageList_${code}_JP_${kind}.dat`);
      if (all) {
        const idx = kind === 'Easy' ? 0 : set * 15;
        for (let k = 0; k < 15; k++) if (all[idx + k]) out[k][region === 'KOR' ? 'ko' : lang] = all[idx + k];
      }
    }
    return out;
  };

  const buildSet = (ovId: number, id: string, title: Text, rules: 'normal' | 'free', names: Text[]): PackLevel => {
    const ov = ovs.get(ovId);
    if (!ov) throw new Error('Missing overlay ' + ovId);
    const recs = scanRecords(ov.data);
    const order = displayOrder(ov, recs);
    const anims = parseAnims(ov, recs, order, i => pckSizes[i] ?? 0);
    const puzzles: DsPuzzle[] = order.map((ri, di) => {
      const r = recs[ri];
      const name: Text = { ...names[di] };
      if (region === 'JPN' || region === 'KOR' || !Object.keys(name).length) name.ja = r.title;
      return {
        id: `${id}-${String(di + 1).padStart(2, '0')}`,
        width: r.w,
        height: r.h,
        rows: rowsFromBits(r.w, r.h, (x, y) => ((r.rows[y] >>> (24 - x)) & 1) === 1),
        name,
        anim: anims[ri],
      };
    });
    return { id, title, rules, puzzles };
  };

  const pckRaw = rom.fileByName('PackData/_out.pck');
  const pckOffs = pckRaw ? findPckOffsets(arm9, pckRaw.length) : [];
  const pckSizes = pckOffs.map((o, i) => (pckOffs[i + 1] ?? o) - o);
  const levels: PackLevel[] = [];
  const easyNames = tbl.normalNames ? tbl.normalNames[0] - 1 : null;
  levels.push({ ...buildSet(tbl.easy, 'easy', LEVEL_TITLES.easy, 'normal', namesFor('Easy', 0, easyNames)), group: 'easy' });
  const unlock = [0, 0, 0, 0, 40, 50, 60, 70, 80, 90];
  tbl.normal.forEach((ov, i) => {
    const lv = buildSet(ov, i === 10 ? 'nX' : `n${String(i + 1).padStart(2, '0')}`, levelTitle('normal', i), 'normal', namesFor('Normal', i, tbl.normalNames ? tbl.normalNames[i] : null));
    levels.push({ ...lv, group: 'normal', unlockAfter: i < 10 ? unlock[i] : undefined, extra: i === 10 });
  });
  tbl.free.forEach((ov, i) => {
    const lv = buildSet(ov, i === 10 ? 'fX' : `f${String(i + 1).padStart(2, '0')}`, levelTitle('free', i), 'free', namesFor('Free', i, tbl.freeNames ? tbl.freeNames[i] : null));
    levels.push({ ...lv, group: 'free', unlockAfter: i < 10 ? unlock[i] : undefined, extra: i === 10 });
  });

  const plain = (ids: number[]): PackPuzzle[] =>
    ids.flatMap(id => {
      const o = ovs.get(id);
      return o ? scanRecords(o.data).map((r, k) => ({ id: `d${id}-${k}`, width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => ((r.rows[y] >>> (24 - x)) & 1) === 1) })) : [];
    });

  const pck = pckRaw;
  return {
    region,
    gameCode: rom.gameCode,
    languages,
    pack: {
      format: 'momogram-pack',
      version: 1,
      id: 'picross-ds',
      title: { en: 'Picross DS', ja: 'ピクロスDS' },
      source: { game: 'Picross DS', platform: 'Nintendo DS', region, developer: 'Jupiter', year: 2007 },
      levels,
    },
    daily7: plain(tbl.daily7),
    daily10: plain(tbl.daily10),
    pck: pck ? pck.slice() : null,
    pckOffsets: pckOffs,
    sdat: rom.fileByName('Sound/PR.sdat')?.slice() ?? null,
  };
}

/** Demo builds (DS Download Station / Nintendo Channel) lack the full tables: collect every puzzle set. */
export function readPicrossDsDemo(data: Uint8Array): Pack {
  const rom = new NdsRom(data);
  const levels: PackLevel[] = [];
  const seen = new Set<string>();
  const blobs = [rom.arm9().data, ...rom.overlays().map(o => o.data)];
  for (const b of blobs) {
    const recs = scanRecords(b).filter(r => r.title !== 'タイトル');
    if (!recs.length) continue;
    const puzzles: PackPuzzle[] = [];
    for (const r of recs) {
      const rows = rowsFromBits(r.w, r.h, (x, y) => ((r.rows[y] >>> (24 - x)) & 1) === 1);
      const key = rows.join();
      if (seen.has(key) || !rows.some(x => x.includes('#'))) continue;
      seen.add(key);
      puzzles.push({ id: `demo-${puzzles.length + levels.length * 100 + 1}`, width: r.w, height: r.h, rows, name: { ja: r.title } });
    }
    if (puzzles.length) levels.push({ id: `demo${levels.length + 1}`, title: { en: `Demo ${levels.length + 1}`, de: `Demo ${levels.length + 1}` }, rules: 'normal', puzzles });
  }
  if (!levels.length) throw new Error('No puzzles found.');
  return { format: 'momogram-pack', version: 1, id: 'picross-ds-demo', title: { en: 'Picross DS (Demo)', ja: 'ピクロスDS 体験版' },
    source: { game: 'Picross DS (demo)', platform: 'Nintendo DS', region: rom.gameCode.slice(-1), developer: 'Jupiter', year: 2007 }, levels };
}

export function pckFile(d: PicrossDsData, i: number): Uint8Array | null {
  if (!d.pck || i + 1 >= d.pckOffsets.length) return null;
  return d.pck.subarray(d.pckOffsets[i], d.pckOffsets[i + 1]);
}

// ---- Picross DS as a pack: everything MomoGram needs from the ROM, so the ROM itself is not kept ----

export interface DsPackMeta { region: PicrossDsData['region']; gameCode: string; languages: Lang[]; daily7: PackPuzzle[]; daily10: PackPuzzle[]; pckOffsets: number[] }

/** pack (with the DS extras in `ds`) + its assets: the sound archive and the solved-picture animation data */
export function dsToPack(d: PicrossDsData): Pack & { ds: DsPackMeta } {
  const assets = [
    ...(d.sdat ? [{ name: 'sound.sdat', data: d.sdat }] : []),
    ...(d.pck ? [{ name: 'anim.pck', data: d.pck }] : []),
  ];
  return {
    ...d.pack,
    levels: d.pack.levels.map(l => ({ ...l, groupTitle: l.group ? LEVEL_TITLES[l.group] : undefined })),
    theme: { ...dsTheme(), ...(d.sdat ? { songs: sdatSongs(d.sdat) } : {}) },
    assets,
    ds: { region: d.region, gameCode: d.gameCode, languages: d.languages, daily7: d.daily7, daily10: d.daily10, pckOffsets: d.pckOffsets },
  };
}

const DS_STAGES = ['jazz', 'reggae', 'bossanova', 'waltz', 'musette', 'musicbox', 'rock', 'house', 'sine'];
/** the game's music: title, the nine in-game styles, clear jingle */
export function dsTheme(): NonNullable<Pack['theme']> {
  return {
    // the board as in the game: glossy blue blocks, striped clue bands, orange guide lines (MomoGram's own look is
    // modelled on it)
    palette: { style: 'ds', accent: '#1f6fd0', fill: '#1f6fd0' },
    music: { menu: 'sound.sdat#title_SEQ', title: 'sound.sdat#title_SEQ', play: 'sound.sdat#stage_jazz_SEQ', clear: 'sound.sdat#game_clear_jingle_SEQ' },
    tracks: DS_STAGES.map(s => `sound.sdat#stage_${s}_SEQ`),
  };
}

/** rebuild the runtime data from a stored Picross DS pack */
export function dsFromPack(p: Pack & { ds?: DsPackMeta }, sdat: Uint8Array | null, pck: Uint8Array | null): PicrossDsData | null {
  if (!p.ds) return null;
  const { assets, ds, theme, ...pack } = p as any;
  return { region: ds.region, gameCode: ds.gameCode, languages: ds.languages, daily7: ds.daily7, daily10: ds.daily10, pckOffsets: ds.pckOffsets, pack, sdat, pck };
}
