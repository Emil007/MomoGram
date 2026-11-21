// Jupiter's Picross games for Nintendo Switch (Unity). A game is its decrypted RomFS folder (or a zip of it):
// pick the folder, or add only the puzzle file for the puzzles with their Japanese names. MomoGram decrypts nothing.
//
//  Game                                   Recognised by (puzzle keys)        Packs
//  PICROSS S                              prs_WxH_NNN, no tutorial keys      PICROSS S
//  PICROSS S2                             prs_WxH_NNN and prs_T… tutorials   PICROSS S2
//  PICROSS S3 – S9                        S3_… – S9_…                        PICROSS S3 – S9
//  PICROSS S GENESIS & Master System      SS_…                               one pack
//  PICROSS S Doraemon & F Characters      SF_…                               one pack
//  PICROSS Lord of the Nazarick           OVL_…                              one pack
//  Picross -LogiartGrimoire-              RK_…                               one pack
//  Kemono Friends Picross                 prs_…, product "…Picross_kemo"     one pack
//  Picross Juufuutei Raden's Guide        product "Picross_Vtuber"           one pack (Addressables layout:
//                                                                              StreamingAssets/aa/Switch/*.bundle,
//                                                                              tables as plain StreamingAssets/IdxResData/*.bytes)
//
// The game is told by the product name in Data/globalgamemanagers (after "Jupiter Corporation": "Picross S",
// "PicrossS2" … "PicrossS9", "PicrossSPlus", "Prj_KdPicross_kemo" …), else by the puzzle keys.
//  PICROSS S+                             E1_… – E9_…, DL_…                  the Picross e games (same ids as the 3DS
//                                                                              packs, so they merge with them) + S+
//
// Where the data is (Data/ of the RomFS):
//   puzzles  StreamingAssets/AssetBundles/puzzledata(.unity3d): MonoBehaviours with m_bytes (S3 and later) or
//            TextAssets (S2), one per puzzle; PICROSS S: resources.assets (TextAssets). A puzzle is ".PRS"
//            (normal) or ".DPC" (Mega Picross, the same pictures; not imported): utf16 magic, u16 version,
//            u16 title length, title (utf16, Japanese), a few bytes, width, height, one byte per cell.
//            Clip (.CLP) and colour (.IPC) puzzles are not imported yet.
//   tables   StreamingAssets/AssetBundles/idxresdata/* (PICROSS S: resources.assets), "IdxRes2" tables:
//            IdxRes_PuzzleList_Picross (play order), IdxRes_Text_PuzzleTitle / IdxRes_PuzzleList_Title (names in
//            up to ten languages), IdxRes_SoundDef (which song plays where).
//   music    StreamingAssets/AssetBundles/snd/<song> (one bundle per AudioClip) or resources.assets AudioClips
//            in resources.resource: FSB5 Vorbis, rebuilt as Ogg (src/audio/fsb5.ts).
import { registerSetImporter, GameFiles } from './index';
import { Lang, Pack, PackAsset, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { serializedFiles, readSerialized, namedBlobs, audioClip } from '../../rom/unity';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

interface Game { id: string; title: Text; year?: number }
const GAMES: Record<string, Game> = {
  S1: { id: 'nsw-picross-s', title: { en: 'PICROSS S' }, year: 2017 },
  S2: { id: 'nsw-picross-s2', title: { en: 'PICROSS S2' }, year: 2018 },
  S3: { id: 'nsw-picross-s3', title: { en: 'PICROSS S3' }, year: 2019 },
  S4: { id: 'nsw-picross-s4', title: { en: 'PICROSS S4' }, year: 2020 },
  S5: { id: 'nsw-picross-s5', title: { en: 'PICROSS S5' }, year: 2020 },
  S6: { id: 'nsw-picross-s6', title: { en: 'PICROSS S6' }, year: 2021 },
  S7: { id: 'nsw-picross-s7', title: { en: 'PICROSS S7' }, year: 2021 },
  S8: { id: 'nsw-picross-s8', title: { en: 'PICROSS S8' }, year: 2022 },
  S9: { id: 'nsw-picross-s9', title: { en: 'PICROSS S9' }, year: 2023 },
  SS: { id: 'nsw-picross-s-genesis', title: { en: 'PICROSS S GENESIS & Master System edition' }, year: 2021 },
  SF: { id: 'nsw-picross-s-doraemon', title: { en: 'PICROSS S Doraemon & F Characters Edition' }, year: 2024 },
  OVL: { id: 'nsw-picross-nazarick', title: { en: 'PICROSS Lord of the Nazarick' }, year: 2020 },
  RK: { id: 'nsw-picross-logiart-grimoire', title: { en: 'Picross -LogiartGrimoire-' }, year: 2023 },
  DL: { id: 'nsw-picross-s-plus', title: { en: 'PICROSS S+' }, year: 2025 },
  KEMONO: { id: 'nsw-picross-kemono-friends', title: { en: 'Kemono Friends Picross', ja: 'けものフレンズピクロス' }, year: 2019 },
  VTUBER: { id: 'nsw-picross-raden', title: { en: "Picross Juufuutei Raden's Guide for Pixel Museum" }, year: 2024 },
  // PICROSS S+ holds the Picross e games: the 3DS pack ids, so both versions become one pack
  E1: { id: 'ctr-picross-e', title: { en: 'PICROSS e', ja: 'ピクロスe' } },
  E2: { id: 'ctr-picross-e2', title: { en: 'PICROSS e2', ja: 'ピクロスe2' } },
  E3: { id: 'ctr-picross-e3', title: { en: 'PICROSS e3', ja: 'ピクロスe3' } },
  E4: { id: 'ctr-picross-e4', title: { en: 'PICROSS e4', ja: 'ピクロスe4' } },
  E5: { id: 'ctr-picross-e5', title: { en: 'PICROSS e5', ja: 'ピクロスe5' } },
  E6: { id: 'ctr-picross-e6', title: { en: 'PICROSS e6', ja: 'ピクロスe6' } },
  E7: { id: 'ctr-picross-e7', title: { en: 'PICROSS e7', ja: 'ピクロスe7' } },
  E8: { id: 'ctr-picross-e8', title: { en: 'PICROSS e8', ja: 'ピクロスe8' } },
  E9: { id: 'ctr-picross-e9', title: { en: 'PICROSS e9', ja: 'ピクロスe9' } },
};
// name columns of the title tables
const COL_LANG: Record<string, Lang> = { title: 'ja', title_en: 'en', title_fr: 'fr', title_es: 'es', title_it: 'it', title_de: 'de', title_ko: 'ko' };

// ---- IdxRes2 tables: header strings, columns (type, name), rows (key, count, count × the columns' values) ----
type Cell = string | number | number[] | string[];
function idxRes2(d: Uint8Array): { cols: string[]; rows: Array<{ key: string; values: Cell[] }> } | null {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), td = new TextDecoder();
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const str = () => { const n = u32(); const s = td.decode(d.subarray(o, o + n)); o += n; return s; };
  try {
    const magic = str();
    if (!magic.startsWith('IdxRes2')) return null;
    if (magic.endsWith('[2.0]')) for (let i = 0; i < 4; i++) str();
    const cols: Array<[number, string]> = [];
    for (let i = 0, n = u32(); i < n; i++) cols.push([u32(), str()]);
    const rows: Array<{ key: string; values: Cell[] }> = [];
    for (let r = 0, n = u32(); r < n; r++) {
      const key = str(), values: Cell[] = [];
      for (let k = 0, m = u32(); k < m; k++) for (const [t] of cols) {
        if (t === 3) values.push(str());
        else if (t === 0 || t === 1) values.push(u32());
        else if (t === 2) values.push(d[o++]);
        else if (t === 4) { const c = u32(); values.push(Array.from({ length: c }, u32)); }
        else if (t === 5) { const c = u32(); values.push(Array.from({ length: c }, str)); }
        else return null;
      }
      rows.push({ key, values });
    }
    return { cols: cols.map(c => c[1]), rows };
  } catch { return null; }
}

// ---- puzzles ----
interface Raw { key: string; w: number; h: number; cells: Uint8Array; title: string }
const td16 = new TextDecoder('utf-16le');
function parsePuzzle(key: string, d: Uint8Array): Raw | null {
  if (td16.decode(d.subarray(0, 8)) !== '.PRS') return null;
  const n = d[10] | (d[11] << 8), p = 12 + n * 2;
  const m = key.match(/(\d+)x(\d+)/);
  for (let q = p; q < p + 8 && q + 2 < d.length; q++) {
    const w = d[q], h = d[q + 1];
    if (m ? (w === +m[1] && h === +m[2]) : (w >= 5 && h >= 5 && w <= 50 && h <= 50)) {
      const cells = d.subarray(q + 2, q + 2 + w * h);
      if (cells.length === w * h && cells.every(c => c <= 1)) return { key, w, h, cells, title: td16.decode(d.subarray(12, p)).replace(/\0.*$/, '').trim() };
    }
  }
  return null;
}
/** the product name Unity keeps in globalgamemanagers (aligned string after the company name) */
function productName(d: Uint8Array): string | null {
  const company = new TextEncoder().encode('Jupiter Corporation');
  for (let i = 0; i + company.length < d.length && i < 4_000_000; i++) {
    if (d[i] !== company[0]) continue;
    let k = 0; while (k < company.length && d[i + k] === company[k]) k++;
    if (k < company.length) continue;
    const o = (i + k + 3) & ~3, n = d[o] | (d[o + 1] << 8);
    return n > 0 && n < 80 ? new TextDecoder().decode(d.subarray(o + 4, o + 4 + n)) : null;
  }
  return null;
}
const PRODUCTS: Array<[RegExp, string]> = [[/^Picross S$/i, 'S1'], [/^PicrossS2$/i, 'S2'], [/kemo/i, 'KEMONO'], [/Vtuber/i, 'VTUBER']];

/** the game a puzzle key belongs to */
function gameOf(key: string, hasTutorialKeys: boolean, product: string | null): string | null {
  const fromProduct = product ? PRODUCTS.find(([re]) => re.test(product))?.[1] : undefined;
  const prefix = key.match(/^([A-Z]+\d?)_/i)?.[1].toUpperCase();
  if (fromProduct && (/^prs_/i.test(key) || (prefix && !GAMES[prefix]))) return fromProduct;
  if (/^prs_\d+x\d+_\d+$/i.test(key)) return hasTutorialKeys ? 'S2' : 'S1';
  const m = key.match(/^([A-Z]+\d?)_\d+x\d+_\d+$/i);
  return m && GAMES[m[1].toUpperCase()] ? m[1].toUpperCase() : null;
}

// ---- the files of a game ----
const AB = 'StreamingAssets/AssetBundles/';

registerSetImporter({
  name: 'Picross S (Switch)',
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      const m = n.match(/^(.*?)(?:StreamingAssets\/AssetBundles\/)?puzzledata(\.unity3d)?$/i) ?? n.match(/^(.*?)StreamingAssets\/aa\/[^/]+\/puzzledata_assets_all[^/]*\.bundle$/i);
      if (m && !/\.manifest$/i.test(n)) { roots.add(m[1]); continue; }
      // PICROSS S keeps everything in resources.assets
      const r = n.match(/^(.*\/)?resources\.assets$/i);
      if (r && !names.some(x => x.startsWith((r[1] ?? '') + AB + 'puzzledata'))) roots.add(r[1] ?? '');
    }
    // the folder above Data/ is the game's
    return [...roots];
  },
  async read(files, root) {
    const has = (n: string) => files.names.includes(n);
    const blobs: Array<{ name: string; bytes: Uint8Array }> = [];
    const audio = new Map<string, () => Promise<Uint8Array | undefined>>();
    const load = async (n: string) => {
      const d = await files.get(n);
      if (!d) return null;
      const s = serializedFiles(d);
      for (const f of s.files) for (const o of readSerialized(f)) {
        const b = namedBlobs([o]);
        blobs.push(...b);
        const a = audioClip(o);
        if (a) {
          const res = a.source.replace(/^archive:\/[^/]+\//, '');
          const inside = s.resources.get(res);
          audio.set(a.name.toLowerCase(), async () => {
            const src = inside ?? (has(root + res) ? await files.get(root + res) : undefined);
            return src?.subarray(a.offset, a.offset + a.size);
          });
        }
      }
      return s;
    };
    // puzzles (and for PICROSS S also tables and music)
    const mine = files.names.filter(n => n.startsWith(root) && !/\.manifest$/i.test(n));
    const pd = [root + AB + 'puzzledata', root + AB + 'puzzledata.unity3d', root + 'puzzledata', root + 'puzzledata.unity3d'].find(has)
      ?? mine.find(n => /\/puzzledata_assets_all[^/]*\.bundle$/i.test(n)) ?? (has(root + 'resources.assets') ? root + 'resources.assets' : undefined);
    if (!pd) throw new Error('Puzzle data not found.');
    await load(pd);
    // tables: only the ones read here; bundles, or plain IdxRes2 files (Addressables games)
    for (const n of mine) {
      const base = n.slice(n.lastIndexOf('/') + 1).replace(/_[0-9a-f]{32}(?=\.bundle$)/, '');
      const m = base.match(/^(idxres_(?:puzzlelist_picross|text_puzzletitle|puzzlelist_title|sounddef))(\.bytes)?(\.unity3d|\.bundle)?$/i);
      if (!m || !/idxresdata\//i.test(n)) continue;
      const d = await files.get(n);
      if (!d) continue;
      if (d[4] === 0x49 && d[5] === 0x64) blobs.push({ name: m[1], bytes: d }); // "IdxRes2…"
      else await load(n);
    }
    // song bundles by name: snd/bgm_00, …/bgm_01.wav_<hash>.bundle
    const clipFiles = new Map<string, string>();
    for (const n of mine) if (/\/snd[^/]*\//i.test(n)) clipFiles.set(n.slice(n.lastIndexOf('/') + 1).toLowerCase().replace(/\.bundle$/, '').replace(/_[0-9a-f]{32}$/, '').replace(/\.wav$/, ''), n);
    const ggm = has(root + 'globalgamemanagers') ? await files.get(root + 'globalgamemanagers') : undefined;
    const product = ggm ? productName(ggm) : null;
    // music of games with AudioClips in resources.assets (PICROSS S, S2)
    if (pd !== root + 'resources.assets' && has(root + 'resources.assets')) await load(root + 'resources.assets');

    const table = (name: string) => { const b = blobs.find(x => x.name.toLowerCase() === name.toLowerCase()); return b ? idxRes2(b.bytes) : null; };
    // puzzles: normal ones only (Mega Picross reuses the same pictures)
    const raws = new Map<string, Raw>();
    for (const b of blobs) { const r = parsePuzzle(b.name, b.bytes); if (r && !raws.has(r.key)) raws.set(r.key, r); }
    if (!raws.size) throw new Error('No puzzles found.');
    const tutorials = [...raws.keys()].some(k => /_T\d+_/i.test(k)) || blobs.some(b => /^prs_T\d/i.test(b.name));
    // names: Text_PuzzleTitle (S2 and later) or PuzzleList_Title (PICROSS S), by puzzle key
    const names = new Map<string, Text>();
    for (const tb of [table('IdxRes_Text_PuzzleTitle'), table('IdxRes_PuzzleList_Title')]) {
      if (!tb) continue;
      for (const r of tb.rows) {
        const t: Text = {};
        tb.cols.forEach((c, i) => { const l = COL_LANG[c]; const v = r.values[i]; if (l && typeof v === 'string' && v.trim()) t[l] = v.trim(); });
        names.set(r.key.toLowerCase(), t);
      }
    }
    // play order
    const order = new Map<string, number>();
    const list = table('IdxRes_PuzzleList_Picross');
    list?.rows.forEach((r, i) => { const k = r.values.find(v => typeof v === 'string') as string | undefined; if (k && !order.has(k.toLowerCase())) order.set(k.toLowerCase(), i); });
    // sounds: role → clip name
    // (some tables have a description column first: the value that names a song wins)
    const sound = new Map<string, string>();
    const isClip = (v: string) => audio.has(v) || clipFiles.has(v);
    table('IdxRes_SoundDef')?.rows.forEach(r => {
      const vs = r.values.filter((v): v is string => typeof v === 'string' && v.length > 0).map(v => v.toLowerCase().replace(/\.(wav|ogg)$/, ''));
      const v = vs.find(isClip) ?? vs.find(x => /^[\x20-\x7e]+$/.test(x));
      if (v) sound.set(r.key, v);
    });

    // per game (PICROSS S+ holds several)
    const byGame = new Map<string, Raw[]>();
    for (const r of raws.values()) {
      if (/_T\d+_/i.test(r.key)) continue; // tutorials
      const g = gameOf(r.key, tutorials, product);
      if (g) (byGame.get(g) ?? byGame.set(g, []).get(g)!).push(r);
    }
    const packs: Pack[] = [];
    for (const [g, all] of byGame) {
      const game = GAMES[g];
      // the same picture twice (S+ has unnamed _00 copies of the first puzzle of each size): the named one stays
      const seen = new Map<string, Raw>();
      for (const r of all.sort((a, b) => Number(!names.has(a.key.toLowerCase())) - Number(!names.has(b.key.toLowerCase())))) {
        const k = `${r.w}x${r.h}:${r.cells.join('')}`;
        if (!seen.has(k)) seen.set(k, r);
      }
      const list = [...seen.values()];
      const levels = sizeLevels(list, order, names, game.id.startsWith('ctr-') ? 'free' : 'normal');
      const music = await gameMusic(g, sound, audio, files, clipFiles);
      packs.push({
        format: 'momogram-pack', version: 1, id: game.id, title: game.title,
        source: { game: game.title.en!, platform: 'Nintendo Switch', developer: 'Jupiter', year: game.year },
        levels, theme: music.theme, assets: music.assets.length ? music.assets : undefined,
      });
    }
    return packs;
  },
});

/** levels by size like the 3DS games (15 puzzles each), in the game's order; ids from the puzzle keys */
function sizeLevels(list: Raw[], order: Map<string, number>, names: Map<string, Text>, rules: 'free' | 'normal'): PackLevel[] {
  const bySize = new Map<string, Raw[]>();
  for (const r of list) { const k = `${r.w}x${r.h}`; (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(r); }
  const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
  const levels: PackLevel[] = [];
  const pos = (r: Raw) => order.get(r.key.toLowerCase()) ?? 1e6 + (parseInt(r.key.replace(/^.*?\d+x\d+_/i, '')) || 0);
  for (const s of sizes) {
    const rs = bySize.get(s)!.sort((a, b) => pos(a) - pos(b));
    const puzzles: PackPuzzle[] = rs.map(r => {
      const own = r.title && !/^[\x00-\x7f]*$/.test(r.title) ? { ja: r.title } : undefined;
      const name = { ...own, ...names.get(r.key.toLowerCase()) };
      const rest = r.key.replace(/^.*?\d+x\d+_/i, '').replace(/^0(?=\d\d(\D|$))/, '').toLowerCase().replace(/_/g, '-');
      return { id: `${s}-${rest}`, width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1), name: Object.keys(name).length ? name : undefined };
    });
    const label = s.replace('x', '×');
    for (let i = 0; i < puzzles.length; i += 15) {
      const k = i / 15 + 1, many = puzzles.length > 15;
      levels.push({ id: `s${s}-${k}`, title: { en: many ? `${label} ${k}` : label }, rules, group: s, groupTitle: { en: label }, puzzles: puzzles.slice(i, i + 15) });
    }
  }
  return levels;
}

/** the game's songs as Ogg files: menu, puzzle tracks, clear jingle */
async function gameMusic(g: string, sound: Map<string, string>, audio: Map<string, () => Promise<Uint8Array | undefined>>, files: GameFiles, clipFiles: Map<string, string>): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const e = /^E\d$/.test(g) ? '_' + g : '';
  const pick = (...keys: string[]) => keys.map(k => sound.get(k)).find(Boolean);
  const exists = (c: string) => audio.has(c) || clipFiles.has(c);
  // without a sound table: the usual names (bgm_00 menu, bgm_01… puzzles, jng_03 / jg_03 clear)
  const conv = (...cs: string[]) => cs.find(exists);
  const roles = {
    menu: e ? pick('Mn_Bgm_Prs' + e) : pick('Mn_Bgm') ?? conv('bgm_00', 'bgm_01'),
    clear: e ? pick('Gm_PrsClearJingle' + e) : pick('Gm_PrsClearJingle', 'Gm_ClearJingle', 'Gm_ClearJingle01') ?? conv('jng_03', 'jg_03'),
  };
  let play = e ? [pick('Gm_Bgm_Prs' + e)] : [...sound.entries()].filter(([k]) => /^Gm_Bgm(\d+|_Relaxing)?$/.test(k)).map(([, v]) => v);
  if (!e && !play.length) play = ['bgm_01', 'bgm_02', 'bgm_03', 'bgm_04', 'bgm_05', 'bgm_06'].filter(c => exists(c) && c !== roles.menu);
  const clips = [...new Set([roles.menu, roles.clear, ...play].filter((x): x is string => !!x))];
  const assets: PackAsset[] = [], made = new Set<string>();
  for (const c of clips) {
    // the clip's bundle (snd/<name>) unless the clip was found in a file already read
    let get = audio.get(c);
    if (!get) {
      const n = clipFiles.get(c);
      if (n) {
        const d = await files.get(n);
        if (d) {
          const s = serializedFiles(d);
          for (const f of s.files) for (const o of readSerialized(f)) {
            const a = audioClip(o);
            if (a) { const res = s.resources.get(a.source.replace(/^archive:\/[^/]+\//, '')); get = async () => res?.subarray(a.offset, a.offset + a.size); }
          }
        }
      }
    }
    const fsb = get ? await get().catch(() => undefined) : undefined;
    if (!fsb) continue;
    try {
      const { mode, samples } = readFsb5(fsb);
      const ogg = mode === 15 && samples[0] ? fsbVorbisToOgg(samples[0]) : null;
      if (ogg) { assets.push({ name: c + '.ogg', data: ogg }); made.add(c); }
    } catch { /* not a readable sound bank */ }
  }
  if (!made.size) return { theme: undefined, assets: [] };
  const f = (c?: string) => (c && made.has(c) ? c + '.ogg' : undefined);
  const tracks = play.filter(c => c && made.has(c)).map(c => c + '.ogg');
  return {
    theme: { music: { title: f(roles.menu), menu: f(roles.menu), play: tracks[0], clear: f(roles.clear) }, tracks },
    assets,
  };
}
