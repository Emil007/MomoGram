// Kemono Friends Picross (Nintendo Switch) — Jupiter's 2019 licensed picross, in the same Unity RomFS layout as
// PICROSS S / S2: the puzzles are a bundle (StreamingAssets/AssetBundles/puzzledata.unity3d) and the tables and
// music live in Data/resources.assets + Data/resources.resource. A game is its decrypted RomFS folder (or a zip
// of it): pick the folder.
//
//  Game                     Recognised by (puzzle keys + product)        Puzzles
//  Kemono Friends Picross   prs_/dpc_/clp_ keys, product                150 normal (.PRS) + 150 Mega (.DPC, same
//                           "Prj_KdPicross_kemo" in globalgamemanagers   pictures) + 5 Clip (.CLP, 30×30/60×60/
//                           and StreamingAssets/AssetBundles/            120×120, not imported). No colour mode.
//                           kemochara.unity3d (only this game ships it)
//
// The key signals are deliberately narrow so the game can never be mistaken for PICROSS S / S2 (whose normal keys
// are also prs_…, with prs_T… tutorials) or any other Jupiter Switch game:
//   - the product name after "Jupiter Corporation" in Data/globalgamemanagers is "Prj_KdPicross_kemo" (the
//     S/S2-era games read "Picross S" / "PicrossS2");
//   - the folder holds StreamingAssets/AssetBundles/kemochara.unity3d, which only this game ships;
//   - here every puzzle is a MonoBehaviour with m_bytes (S3+ serialized layout), while PICROSS S/S2 keep each
//     puzzle as a TextAsset — so within the prs_ family the blob type already separates them;
//   - there is no idxresdata/ and no snd/ folder: tables + music are inside resources.assets / resources.resource
//     (the PICROSS S/S2-era layout), whereas S3+ games keep them as idxresdata/-bundles and their own snd/ files.
//
// Where the data is (Data/ of the RomFS):
//   puzzles  StreamingAssets/AssetBundles/puzzledata(.unity3d): MonoBehaviours with m_bytes, one per puzzle.
//            ".PRS" (normal), ".DPC" (Mega Picross, the same pictures), ".CLP" (Clip Picross). No ".IPC".
//   tables   Data/resources.assets: "IdxRes2" TextAssets —
//            IdxRes_PuzzleList_Picross (the 150 normal puzzles, play order), IdxRes_PuzzleList_Mega (the same
//            150 as Mega, own order), IdxRes_PuzzleList_ClipPicross (5), IdxRes_PuzzleList_Title (names in six
//            languages: ja, en, fr, es, it, de), IdxRes_SoundDef (role → clip), IdxRes_PuzzleList_Tutorial_PrsDpc.
//   music    Data/resources.resource, FSB5 Vorbis banks for the AudioClips declared in resources.assets
//            (bgm_00/01/02, jng_*, se_*) → rebuilt as Ogg.
//
// The 150 normal puzzles (sizes 5×5, 10×10, 15×15, 20×15) appear once, ordered by IdxRes_PuzzleList_Picross; the
// same pictures also have a Mega version (IdxRes_PuzzleList_Mega) and the ".DPC" under the same key carries the
// pairs of lines, attached with the pack's `mega` property (exactly like PICROSS S / S2). Some keys carry an
// animal-name suffix ("prs_10x10_002_EzoRedfox", "prs_15x15_014_Prairiedog", …) that the title table uses too.
import { registerSetImporter, GameFiles } from './index';
import { Lang, Pack, PackAsset, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { parseDpc } from './ctr-picross';
import { serializedFiles, readSerialized, namedBlobs, audioClip } from '../../rom/unity';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

const GAME = { id: 'nsw-picross-kemono-friends', title: { en: 'Kemono Friends Picross', ja: 'けものフレンズピクロス' } as Text, year: 2019 };
// name columns of the title table (six languages in this game)
const COL_LANG: Record<string, Lang> = { title: 'ja', title_en: 'en', title_fr: 'fr', title_es: 'es', title_it: 'it', title_de: 'de' };

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
interface Raw { key: string; w: number; h: number; cells: Uint8Array; title: string; mega?: { rows: number[]; cols: number[] } }
const td16 = new TextDecoder('utf-16le');
/** a normal .PRS puzzle: utf16 magic, u16 version, u16 title length, title (utf16, Japanese), a few bytes,
 *  width, height, one byte per cell. Same layout as every Jupiter Switch game. */
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

const AB = 'StreamingAssets/AssetBundles/';

registerSetImporter({
  name: 'Kemono Friends Picross (Switch)',
  version: 1,
  find(names) {
    // Claim a folder only when it is really this game. The one unambiguous marker is its character bundle
    // StreamingAssets/AssetBundles/kemochara.unity3d, which no other Jupiter Switch game ships. gating on it
    // (rather than on puzzledata alone) is what stops this importer from swallowing a PICROSS S / S2 folder
    // (whose keys are also prs_… and whose puzzledata has the same filename) before the stock importer can read
    // it — importFileSet marks any root this find() returns as taken and skips every later importer for it.
    const roots = new Set<string>();
    for (const n of names) {
      const k = n.match(/^(.*?)StreamingAssets\/AssetBundles\/kemochara\.unity3d$/i);
      if (k && !/\.manifest$/i.test(n)) roots.add(k[1] ?? '');
    }
    // keep the shallowest roots (the game's Data/ folder)
    return [...roots].filter(r => ![...roots].some(o => o !== r && o.startsWith(r)));
  },
  async read(files, root) {
    const has = (n: string) => files.names.includes(n);
    const mine = files.names.filter(n => n.startsWith(root) && !/\.manifest$/i.test(n));
    // only folders that are really this game: the character bundle or the product name must be present, else a
    // prs_… bundle from another game (PICROSS S / S2 share the key family) is not ours to claim
    if (!mine.some(n => /(^|\/)kemochara\.unity3d$/i.test(n) || /(^|\/)globalgamemanagers$/i.test(n))) return [];
    const ggm = has(root + 'globalgamemanagers') ? await files.get(root + 'globalgamemanagers') : undefined;
    const product = ggm ? productName(ggm) : null;
    if (product && !/kemo/i.test(product)) return [];

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
    // puzzles in puzzledata(.unity3d); tables + music in resources.assets (+ resources.resource for the banks)
    const pd = [root + AB + 'puzzledata', root + AB + 'puzzledata.unity3d', root + 'puzzledata', root + 'puzzledata.unity3d'].find(has);
    if (!pd) throw new Error('Puzzle data not found.');
    await load(pd);
    if (has(root + 'resources.assets')) await load(root + 'resources.assets');

    const table = (name: string) => { const b = blobs.find(x => x.name.toLowerCase() === name.toLowerCase()); return b ? idxRes2(b.bytes) : null; };
    const list = table('IdxRes_PuzzleList_Picross');
    if (!list) throw new Error('Puzzle table not found.');
    const wanted = new Set(list.rows.map(r => r.values.find(v => typeof v === 'string') as string | undefined).filter((x): x is string => !!x));
    // normal puzzles (.PRS) that the play list names (the bundle also carries 2 prs_T… tutorial keys: skipped)
    const raws = new Map<string, Raw>();
    for (const b of blobs) {
      const r = parsePuzzle(b.name, b.bytes);
      if (r && wanted.has(r.key) && !raws.has(r.key)) raws.set(r.key, r);
    }
    if (!raws.size) throw new Error('No puzzles found.');
    // Mega Picross: a ".DPC" under the same key holds the pairs of lines (same 3DS .bdpc format as PICROSS S/S2).
    // The Mega list (IdxRes_PuzzleList_Mega) names the same 150 pictures; the .DPC is attached to the normal
    // puzzle record so the app derives the Mega mode from it. DPC keys mirror the PRS keys (same suffix).
    // Tutorial keys (_T\d+_, incl. the leftover dpc_T03_10x10 of the Tutorial list) are skipped here.
    for (const b of blobs) {
      if (/_T\d+_/i.test(b.name)) continue;
      const m = b.name.match(/(\d+)x(\d+)/);
      const dpc = parseDpc(b.bytes, m ? [+m[1], +m[2]] : undefined);
      if (!dpc) continue;
      const key = b.name.replace(/^dpc_/i, 'prs_'), r = raws.get(key);
      if (r && r.w === dpc.w && r.h === dpc.h && r.cells.every((c, i) => c === dpc.cells[i])) r.mega = { rows: dpc.rows, cols: dpc.cols };
      else if (!r) {
        // a Mega-only puzzle (a .DPC with no matching normal .PRS in the play list)
        raws.set(key, { key, w: dpc.w, h: dpc.h, cells: dpc.cells, title: '', mega: { rows: dpc.rows, cols: dpc.cols } } as Raw);
      }
    }
    // names: the Title table (six languages), by puzzle key (the suffixed keys are used there too)
    const names = new Map<string, Text>();
    const tb = table('IdxRes_PuzzleList_Title');
    if (tb) for (const r of tb.rows) {
      const t: Text = {};
      tb.cols.forEach((c, i) => { const l = COL_LANG[c]; const v = r.values[i]; if (l && typeof v === 'string' && v.trim()) t[l] = v.trim(); });
      names.set(r.key.toLowerCase(), t);
    }
    // play order (the game's own list)
    const order = new Map<string, number>();
    list.rows.forEach((r, i) => { const k = r.values.find(v => typeof v === 'string'); if (k && typeof k === 'string' && !order.has(k.toLowerCase())) order.set(k.toLowerCase(), i); });
    // sounds: role → clip name
    const sound = new Map<string, string>();
    table('IdxRes_SoundDef')?.rows.forEach(r => {
      const vs = r.values.filter((v): v is string => typeof v === 'string' && v.length > 0).map(v => v.toLowerCase().replace(/\.(wav|ogg)$/, ''));
      const v = vs.find(x => audio.has(x)) ?? vs.find(x => /^[\x20-\x7e]+$/.test(x));
      if (v) sound.set(r.key, v);
    });

    // the same picture appears once (a "…_Name" suffixed key is not a separate puzzle)
    const seen = new Map<string, Raw>();
    for (const r of [...raws.values()].sort((a, b) => Number(!names.has(a.key.toLowerCase())) - Number(!names.has(b.key.toLowerCase())))) {
      const k = `${r.w}x${r.h}:${r.cells.join('')}`;
      if (!seen.has(k)) seen.set(k, r);
    }
    const levels = sizeLevels([...seen.values()], order, names, 'normal');
    const music = await gameMusic(sound, audio, files);
    return [{
      format: 'momogram-pack', version: 1, id: GAME.id, title: GAME.title,
      source: { game: GAME.title.en!, platform: 'Nintendo Switch', developer: 'Jupiter', year: GAME.year },
      levels, theme: { ...music.theme, palette: { style: 'switch', accent: '#1d9e3a', fill: '#333333', cross: '#ff7f00', mark: '#808080', grid: '#666666', grid5: '#00e626', mistake: '#ff0000' } },
      assets: music.assets.length ? music.assets : undefined,
    }];
  },
});

/** levels by size (the usual 15-puzzle levels), in the game's order; ids from the puzzle keys */
function sizeLevels(list: Raw[], order: Map<string, number>, names: Map<string, Text>, rules: 'free' | 'normal'): PackLevel[] {
  const bySize = new Map<string, Raw[]>();
  for (const r of list) { const k = `${r.w}x${r.h}`; (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(r); }
  const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
  const levels: PackLevel[] = [];
  const pos = (r: Raw) => order.get(r.key.toLowerCase()) ?? 1e6 + (parseInt(r.key.replace(/^.*?\d+x\d+_/, '')) || 0);
  for (const s of sizes) {
    const rs = bySize.get(s)!.sort((a, b) => pos(a) - pos(b));
    const puzzles: PackPuzzle[] = rs.map(r => {
      const rest = r.key.replace(/^.*?(\d+x\d+)_/, '').replace(/_[A-Z][a-z]+$/, '').replace(/^0(?=\d\d(\D|$))/, '').toLowerCase().replace(/_/g, '-');
      const own = r.title && !/^[\x00-\x7f]*$/.test(r.title) ? { ja: r.title } : undefined;
      const name = { ...own, ...names.get(r.key.toLowerCase()) };
      return { id: `${s}-${rest}`, width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1), name: Object.keys(name).length ? name : undefined, ...(r.mega ? { mega: r.mega } : {}) };
    });
    const label = s.replace('x', '×');
    for (let i = 0; i < puzzles.length; i += 15) {
      const k = i / 15 + 1, many = puzzles.length > 15;
      levels.push({ id: `s${s}-${k}`, title: { en: many ? `${label} ${k}` : label }, rules, group: s, groupTitle: { en: label }, puzzles: puzzles.slice(i, i + 15) });
    }
  }
  return levels;
}

/** the game's songs as Ogg files: menu, puzzle tracks, clear jingle (from the SoundDef roles) */
async function gameMusic(sound: Map<string, string>, audio: Map<string, () => Promise<Uint8Array | undefined>>, files: GameFiles): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const pick = (...keys: string[]) => keys.map(k => sound.get(k)).find(Boolean);
  const exists = (c: string) => audio.has(c);
  const roles = {
    menu: pick('Mn_Bgm', 'Titl_Bgm') ?? (exists('bgm_00') ? 'bgm_00' : undefined),
    clear: pick('Gm_ClearJingle', 'Mn_CompleteJingle') ?? (exists('jng_03') ? 'jng_03' : undefined),
  };
  let play = [pick('Gm_Bgm')].filter(Boolean) as string[];
  if (!play.length) play = ['bgm_01', 'bgm_02', 'bgm_03', 'bgm_04', 'bgm_05', 'bgm_06'].filter(exists);
  // all the music + jingle banks, but not the one-shot sound-effect banks (se_*)
  const music = (c: string) => !/^se_/.test(c);
  const every = [...new Set([...audio.keys()])].filter(c => music(c)).sort();
  const clips = [...new Set([roles.menu, roles.clear, ...play, ...every].filter((x): x is string => !!x))];
  const assets: PackAsset[] = [], made = new Set<string>();
  for (const c of clips) {
    const get = audio.get(c);
    if (!get) continue;
    const fsb = await get().catch(() => undefined);
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
    theme: { music: { title: f(roles.menu), menu: f(roles.menu), play: tracks[0], clear: f(roles.clear) }, tracks, songs: clips.filter(c => made.has(c)).sort().map(c => c + '.ogg') },
    assets,
  };
}
