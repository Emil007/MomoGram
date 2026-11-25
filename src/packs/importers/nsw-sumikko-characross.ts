// "Eiga Sumikkogurashi: Sora no Okoku to Futari no Ko Asobo Characross" (Nintendo Switch, 2025) —
// Jupiter's Sumikko Gurashi movie tie-in picross, same Unity "IdxRes2" engine as the other Jupiter
// Switch games but with the game's own puzzle keys ("Prince_…").
//
//   Game                                   Recognised by                        Packs
//   Eiga Sumikkogurashi Asobo Characross   puzzle keys Prince_… (product       one pack
//                                          name "Prj_Prince" in
//                                          globalgamemanagers)
//
// A game is its decrypted RomFS folder (or a zip of it). MomoGram decrypts nothing.
//
// Where the data is (Data/ of the RomFS, Addressables layout like PICROSS S Doraemon and Raden):
//   puzzles  StreamingAssets/aa/Switch/puzzledata_assets_all_*.bundle: MonoBehaviours with m_bytes,
//            one per puzzle, named after the key (Prince_15x15_n001b …). A puzzle is ".PRS" (normal,
//            same format as the other Jupiter Switch games): utf16 magic, u16 version, u16 title
//            length, title (utf16, mostly Japanese), a few bytes, width, height, one byte per cell.
//            The bundle's two extra ".PRS" (Prince_10x10_n078c/n079b, unlocked "bonus" puzzles that
//            IdxRes_PuzzleData also lists) import like the rest. The 15 ".CLP" (200x120 Clip picross
//            samples) and the single ".IPC" colour-set helper are not puzzles and are skipped; there
//            are no ".DPC" (Mega) and no colour puzzles to play.
//   tables   StreamingAssets/IdxResData/*.bytes, "IdxRes2" tables:
//            IdxRes_PuzzleData       rows keyed Prs_<n>: m_titleID (play order), m_key (the puzzle
//                                    key, matches the blob name), m_puzzleType (0 = normal picross,
//                                    2 = clip, 4 = tutorial), sprite name
//            IdxRes_Text_PuzzleTitle names per key, columns title (ja) and title_en (en)
//            IdxRes_PuzzleColorDef   the board's colours, float RGB(A) lists
//   music    StreamingAssets/aa/Switch/snd_assets_snd/<name>.wav_<hash>.bundle (AudioClip + FSB5),
//            played through findSongs by name (PRINCE_bgm_00 menu, PRINCE_bgm_01 puzzle, …).
//
// Update note: the base XCI and the v196608 update NSP hold the same puzzle list and tables; the
// update only re-masters six ".PRS" (a few filled cells) — importing the update's RomFS (or a
// merged / converted copy) is every bit as valid. The importer reads whichever RomFS it is given.

import { registerSetImporter, GameFiles } from './index';
import { Lang, Pack, PackAsset, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { serializedFiles, readSerialized, namedBlobs, audioClip } from '../../rom/unity';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

// name columns of the title table
const COL_LANG: Record<string, Lang> = { title: 'ja', title_en: 'en', title_fr: 'fr', title_es: 'es', title_it: 'it', title_de: 'de', title_ko: 'ko' };
/** Sumikko's title table wraps some words in Unity rich text (<r=ふりがな>漢字</r>): keep the visible text only */
const clean = (s: string) => s.replace(/<[^>]*>/g, '').trim();

// ---- IdxRes2 tables (same as the other Jupiter games) ----
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

/** IdxRes_PuzzleColorDef: per key a list of colours (float r, g, b[, a] 0-255) */
function colorTable(d: Uint8Array): Map<string, number[][]> {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), td = new TextDecoder(), out = new Map<string, number[][]>();
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const str = () => { const n = u32(); const s = td.decode(d.subarray(o, o + n)); o += n; return s; };
  try {
    if (str().endsWith('[2.0]')) for (let i = 0; i < 4; i++) str();
    for (let i = 0, n = u32(); i < n; i++) { u32(); str(); }
    for (let r = 0, n = u32(); r < n; r++) {
      const key = str(), list: number[][] = [];
      for (let k = 0, m = u32(); k < m; k++) { const c = u32(); const v: number[] = []; for (let j = 0; j < c; j++) { v.push(dv.getFloat32(o, true)); o += 4; } list.push(v); }
      out.set(key, list);
    }
  } catch { /* partial */ }
  return out;
}
const hex = (c?: number[]) => c && c.length >= 3 ? '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('') : undefined;

/** the board's colours: the game's table (soft pastel "Sumikko" palette), or the S3 defaults */
function sumikkoPalette(t: Map<string, number[][]>): NonNullable<NonNullable<Pack['theme']>['palette']> {
  const c = (k: string) => t.get(k)?.[0];
  return {
    style: 'switch', accent: '#e05c74',
    fill: hex(c('ColorPrs_Nuri')) ?? '#b7d7c2', cross: hex(c('ColorPrs_Batu')) ?? '#ff7f00', mark: hex(c('ColorPrs_Mark')) ?? '#808080',
    grid: hex(c('ColorPrs_Grid')) ?? '#d3c4be', grid5: hex(c('ColorPrs_Grid5')) ?? '#c97a2a', mistake: hex(c('ColorPrs_Red')) ?? '#c80000',
  };
}

// ---- puzzles ----
interface Raw { key: string; w: number; h: number; cells: Uint8Array; title?: string }
const td16 = new TextDecoder('utf-16le');
/** a normal puzzle: ".PRS" magic, u16 version, u16 title length, title, then width, height, one byte per cell.
 *  The width/height are found by scanning a few bytes past the title (they follow a short fixed header). */
function parsePuzzle(key: string, d: Uint8Array): Raw | null {
  if (td16.decode(d.subarray(0, 8)) !== '.PRS') return null;
  const n = d[10] | (d[11] << 8), p = 12 + n * 2;
  const m = key.match(/(\d+)x(\d+)/);
  for (let q = p; q < p + 16 && q + 2 < d.length; q++) {
    const w = d[q], h = d[q + 1];
    if (m ? (w === +m[1] && h === +m[2]) : (w >= 5 && h >= 5 && w <= 200 && h <= 200)) {
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

// ---- the files of a game ----
registerSetImporter({
  name: 'Asobo Characross (Switch)',
  version: 1,
  find(names) {
    // Raden uses the same Addressables layout (puzzledata_assets_all plus IdxRes_PuzzleData.bytes).
    // This game is the one whose song bundles are named prince_*.
    const roots = new Set<string>();
    const dataRoot = (n: string) => { const i = n.indexOf('StreamingAssets'); return i > 0 ? n.slice(0, i) : n.slice(0, n.lastIndexOf('/') + 1); };
    for (const n of names) {
      if (!/StreamingAssets\/aa\/[^/]+\/puzzledata_assets_all[^/]*\.bundle$/i.test(n) || /\.manifest$/i.test(n)) continue;
      const root = dataRoot(n);
      if (names.some(x => x.startsWith(root) && /\/prince_/i.test(x) && !/\.manifest$/i.test(x))) roots.add(root);
    }
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
        blobs.push(...namedBlobs([o]));
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
    const mine = files.names.filter(n => n.startsWith(root) && !/\.manifest$/i.test(n));
    // verify the game (cheap header reads) before doing any heavy work
    const ggm = has(root + 'globalgamemanagers') ? await files.get(root + 'globalgamemanagers')
      : mine.some(n => n.endsWith('/globalgamemanagers')) ? await files.get(mine.find(n => n.endsWith('/globalgamemanagers'))!) : undefined;
    const product = ggm ? productName(ggm) : null;
    if (product !== 'Prj_Prince') throw new Error('Puzzle data not found.');
    const pd = mine.find(n => /\/puzzledata_assets_all[^/]*\.bundle$/i.test(n));
    if (!pd) throw new Error('Puzzle data not found.');
    await load(pd);
    // tables: plain IdxRes2 files under StreamingAssets/IdxResData
    for (const n of mine) {
      const base = n.slice(n.lastIndexOf('/') + 1).replace(/_[0-9a-f]{32}(?=\.bundle$)/, '');
      const m = base.match(/^(idxres_(?:puzzledata|text_puzzletitle|puzzlecolordef|sounddef|puzzlelist_picross|puzzlelist_title))(\.bytes)?$/i);
      if (!m || !/idxresdata\//i.test(n) || !has(n)) continue;
      const d = await files.get(n);
      if (!d) continue;
      if (d[4] === 0x49 && d[5] === 0x64) blobs.push({ name: m[1], bytes: d }); // "IdxRes2…"
      else await load(n);
    }
    // song bundles by name: snd_assets_snd/<name>.wav_<hash>.bundle
    const clipFiles = new Map<string, string>();
    for (const n of mine) if (/\/snd_assets_snd\//i.test(n) || /\/snd[^/]*\//i.test(n))
      clipFiles.set(n.slice(n.lastIndexOf('/') + 1).toLowerCase().replace(/\.bundle$/, '').replace(/_[0-9a-f]{32}$/, '').replace(/\.wav$/, ''), n);

    const table = (name: string) => { const b = blobs.find(x => x.name.toLowerCase() === name.toLowerCase()); return b ? idxRes2(b.bytes) : null; };
    // puzzles: normal ones only (.PRS); skip the shared Jupiter tutorial keys (S2_T…); clip (.CLP) and the
    // IPC colour set are not puzzles
    const raws = new Map<string, Raw>();
    for (const b of blobs) { if (/_T\d+_/i.test(b.name)) continue; const r = parsePuzzle(b.name, b.bytes); if (r && !raws.has(r.key)) raws.set(r.key, r); }
    if (!raws.size) throw new Error('No puzzles found.');
    // names from IdxRes_Text_PuzzleTitle by puzzle key
    const names = new Map<string, Text>();
    const tb = table('IdxRes_Text_PuzzleTitle');
    if (tb) for (const r of tb.rows) {
      const t: Text = {};
      tb.cols.forEach((c, i) => { const l = COL_LANG[c]; const v = r.values[i]; if (l && typeof v === 'string' && clean(v)) t[l] = clean(v); });
      names.set(r.key.toLowerCase(), t);
    }
    // play order: IdxRes_PuzzleData m_titleID -> m_key
    const order = new Map<string, number>();
    const pdT = table('IdxRes_PuzzleData');
    if (pdT) for (const r of pdT.rows) {
      const id = r.values[0], key = r.values[1];
      if (typeof key === 'string' && typeof id === 'number' && key.length && !order.has(key.toLowerCase())) order.set(key.toLowerCase(), id);
    }
    // sounds: role -> clip name (this game names its songs PRINCE_bgm_00, PRINCE_bgm_01, …)
    const sound = new Map<string, string>();
    const isClip = (v: string) => audio.has(v) || clipFiles.has(v);
    table('IdxRes_SoundDef')?.rows.forEach(r => {
      const vs = r.values.filter((v): v is string => typeof v === 'string' && v.length > 0).map(v => v.toLowerCase().replace(/\.(wav|ogg)$/, ''));
      const v = vs.find(isClip) ?? vs.find(x => /^[\x20-\x7e]+$/.test(x));
      if (v) sound.set(r.key, v);
    });

    const list = [...raws.values()];
    const rules: 'normal' = 'normal';
    const levels = sizeLevels(list, order, names, rules);
    const colors = blobs.find(x => x.name.toLowerCase() === 'idxres_puzzlecolordef');
    const palette = sumikkoPalette(colors ? colorTable(colors.bytes) : new Map());
    const music = await gameMusic(sound, audio, files, clipFiles);
    return [{
      format: 'momogram-pack', version: 1, id: 'nsw-sumikko-characross',
      title: { en: 'Eiga Sumikkogurashi: Sora no Okoku to Futari no Ko Asobo Characross', ja: '映画 すみっコぐらし 空の王国とふたりのコ あそぼうキャラクロス' },
      source: { game: 'Eiga Sumikkogurashi: Sora no Okoku to Futari no Ko Asobo Characross', platform: 'Nintendo Switch', developer: 'Jupiter', year: 2025 },
      levels, theme: { ...music.theme, palette }, assets: music.assets.length ? music.assets : undefined,
    } satisfies Pack];
  },
});

/** levels by size (at most 15 each, this game has 3 sizes + tutorials), in the game's order; ids from the keys */
function sizeLevels(list: Raw[], order: Map<string, number>, names: Map<string, Text>, rules: 'free' | 'normal'): PackLevel[] {
  const bySize = new Map<string, Raw[]>();
  for (const r of list) { const k = `${r.w}x${r.h}`; (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(r); }
  const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
  const levels: PackLevel[] = [];
  const pos = (r: Raw) => order.get(r.key.toLowerCase()) ?? 1e6 + (parseInt(r.key.replace(/^.*?\d+x\d+_/i, '').replace(/^0+/, '')) || 0);
  for (const s of sizes) {
    const rs = bySize.get(s)!.sort((a, b) => pos(a) - pos(b));
    const puzzles: PackPuzzle[] = rs.map(r => {
      const t = names.get(r.key.toLowerCase()) ?? {};
      // embedded title fallback: the game ships a real title in the .PRS itself for a few puzzles that have
      // no title-table row (e.g. the bonus 10×10 Throne); ignore the generic "enter a title" placeholder
      const own = r.title && !/^[\x00-\x7f]*$/.test(r.title) && !r.title.includes('タイトルを入力') ? { ja: clean(r.title) } : undefined;
      const name = { ...own, ...t };
      const rest = r.key.split('_').slice(2).join('-').toLowerCase(); // "n078c"
      return { id: `${s}-${rest}`, width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1), name: name && Object.keys(name).length ? name : undefined };
    });
    const label = s.replace('x', '×');
    for (let i = 0; i < puzzles.length; i += 15) {
      const k = i / 15 + 1, many = puzzles.length > 15;
      levels.push({ id: `s${s}-${k}`, title: { en: many ? `${label} ${k}` : label }, rules, group: s, groupTitle: { en: label }, puzzles: puzzles.slice(i, i + 15) });
    }
  }
  return levels;
}

/** the game's songs as Ogg files: menu, puzzle track, clear jingle */
async function gameMusic(sound: Map<string, string>, audio: Map<string, () => Promise<Uint8Array | undefined>>, files: GameFiles, clipFiles: Map<string, string>): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const pick = (...keys: string[]) => keys.map(k => sound.get(k)).find(Boolean);
  const exists = (c: string) => audio.has(c) || clipFiles.has(c);
  const conv = (...cs: string[]) => cs.find(exists);
  const roles = {
    menu: pick('Mn_Bgm') ?? conv('prince_bgm_00', 'bgm_00', 'bgm_01'),
    clear: pick('Gm_ClearPrsJingle', 'Gm_PrsClearJingle') ?? conv('prince_jng_11', 'jng_11', 'jg_03'),
  };
  let play = [...sound.entries()].filter(([k]) => /^Gm_Bgm/i.test(k)).map(([, v]) => v);
  if (!play.length) play = [...new Set([...audio.keys(), ...clipFiles.keys()])].filter(c => /bgm_0[1-9]/.test(c) && exists(c) && c !== roles.menu);
  const music = (c: string) => !/(^|_)(se|voice|puzzletitlevoice)(_|\d|$)|^snd_/.test(c);
  const every = [...new Set([...audio.keys(), ...clipFiles.keys()])].filter(c => music(c)).sort();
  const clips = [...new Set([roles.menu, roles.clear, ...play, ...every].filter((x): x is string => !!x))];
  const assets: PackAsset[] = [], made = new Set<string>();
  for (const c of clips) {
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
    theme: { music: { title: f(roles.menu), menu: f(roles.menu), play: tracks[0], clear: f(roles.clear) }, tracks, songs: [...made].sort().map(c => c + '.ogg') },
    assets,
  };
}
