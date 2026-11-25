// PICROSS S Doraemon & F Characters Edition (Nintendo Switch, Jupiter) — a drop-in set-importer for the
// same Unity RomFS layout as nsw-picross-s.ts (StreamingAssets/AssetBundles with puzzledata, IdxRes2 tables
// in idxresdata, songs as snd/<name> bundles). A game is its decrypted RomFS folder (or a zip of it).
//
//  Game                                   Recognised by (puzzle keys)     Puzzles
//  PICROSS S Doraemon & F Characters      SF_…                           normal .PRS, Mega .DPC, colour .IPC,
//                                                                          Clip .CLP (.CLP not imported)
//
// Why a separate importer file instead of relying on nsw-picross-s.ts:
//   The stock importer already knows the SF_ keys (its PACK id is nsw-picross-s-doraemon and the pack this
//   file builds is byte-identical to it, so progress merges). But the 2024/2025 Jupiter editions importers
//   (NAMCO/Shield Hero, CAPCOM/SNK) are registered BEFORE the stock one (their files sort first), and their
//   find() claims *any* folder that has a puzzledata bundle. On its own that over-broad find() would claim
//   the Doraemon folder and then return "unsupported" because it knows no SF_ key — the folder would never
//   reach the stock importer. This file sorts FIRST among the nsw-picross-* importers and its find() only
//   claims a folder that really is Doraemon (it has StreamingAssets/AssetBundles/gifanimations/sf_*.bundle),
//   so it wins the Doraemon root before the over-broad importers see it, and never touches any other game.
//
// Data (Data/ of the RomFS):
//   puzzles  StreamingAssets/AssetBundles/puzzledata: MonoBehaviours with m_bytes (S3+ layout), one per puzzle.
//            ".PRS" (normal), ".DPC" (Mega, same pictures), ".IPC" (Colour), ".CLP" (Clip). The byte format and
//            the IdxRes2 table layout are identical to nsw-picross-s.ts (titles table: ten languages; only the
//            first seven are mapped to the pack's Lang set). Only the puzzles the puzzle-list tables name are
//            imported, in the game's order.
//   tables   StreamingAssets/AssetBundles/idxresdata/*: "IdxRes2" bundles:
//            IdxRes_PuzzleList_Picross (play order) / _IpcPicross (colour order), IdxRes_Text_PuzzleTitle
//            (names), IdxRes_SoundDef (which clip plays where), IdxRes_PuzzleColorDef (board colours).
//   music    StreamingAssets/AssetBundles/snd/<song>: one bundle per AudioClip (FSB5 Vorbis → Ogg).
//
// Recognised by the puzzle keys: SF_ (every real puzzle; the bundle also holds the stock tutorial blobs
// S2_T01/T02, S3_T04 and the UniversalColorSetMin colour-table helper, which are skipped as everywhere).
// Product name in Data/globalgamemanagers: "Prj_PicrossSDFCe".
import { registerSetImporter, GameFiles } from './index';
import { Lang, Pack, PackAsset, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';
import { parseDpc } from './ctr-picross';
import { serializedFiles, readSerialized, namedBlobs, audioClip } from '../../rom/unity';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

// name columns of the title table (ten languages; tc/sc/pt map onto the pack's narrowed set)
const COL_LANG: Record<string, Lang> = { title: 'ja', title_en: 'en', title_fr: 'fr', title_es: 'es', title_it: 'it', title_de: 'de', title_ko: 'ko' };

// ---- IdxRes2 tables (identical reader to nsw-picross-s.ts) ----
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

/** the board's colours (identical values in every Jupiter Switch game) */
function switchPalette(): NonNullable<NonNullable<Pack['theme']>['palette']> {
  return { style: 'switch', accent: '#1d9e3a', fill: '#333333', cross: '#ff7f00', mark: '#808080', grid: '#666666', grid5: '#00e626', mistake: '#ff0000' };
}

// ---- puzzles ----
interface Raw { key: string; w: number; h: number; cells: Uint8Array; title: string; mega?: { rows: number[]; cols: number[] }; colors?: string[]; colorCells?: Uint8Array }
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
/** a colour puzzle (".IPC", Color Picross): utf16 magic, u16 version, u16 title length, title (utf16), u16, u8 0,
 *  u8 colour count n, 12 bytes (a hash), the n colours (RGB), a few board colours, width, height, one byte per
 *  cell (0xff = empty, else the colour). */
function parseIpc(key: string, d: Uint8Array): Raw | null {
  if (td16.decode(d.subarray(0, 8)) !== '.IPC') return null;
  const n = d[10] | (d[11] << 8), p = 12 + n * 2, k = d[p + 3];
  if (!k || k > 16) return null;
  const c0 = p + 16;
  const m = key.match(/(\d+)x(\d+)/);
  for (let at = c0 + 3 * k; at < c0 + 3 * k + 48 && at + 2 < d.length; at++) {
    const w = d[at], h = d[at + 1];
    if (!w || !h || (m ? w !== +m[1] || h !== +m[2] : w < 5 || h < 5 || w > 50 || h > 50) || at + 2 + w * h > d.length) continue;
    const raw = d.subarray(at + 2, at + 2 + w * h);
    if (!raw.every(v => v === 0xff || v < k) || raw.every(v => v === 0xff)) continue;
    const colors = [...Array(k)].map((_, i) => '#' + [0, 1, 2].map(j => d[c0 + i * 3 + j].toString(16).padStart(2, '0')).join(''));
    return { key, w, h, cells: raw.map(v => (v === 0xff ? 0 : 1)), colorCells: raw.map(v => (v === 0xff ? 0 : v + 1)), colors, title: td16.decode(d.subarray(12, p)).replace(/\0.*$/, '').trim() };
  }
  return null;
}

// ---- the files of a game ----
const AB = 'StreamingAssets/AssetBundles/';

registerSetImporter({
  name: 'Picross S Doraemon (Switch)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // only a folder that is genuinely Doraemon: besides puzzledata it carries the Doraemon-unique
      // gifanimations/sf_*.bundle colour previews (the other editions use sn_/ta_/sc_, stock S3–S9 none)
      const m = n.match(/^(.*?)(?:StreamingAssets\/AssetBundles\/)?puzzledata(\.unity3d)?$/i);
      if (m && !/\.manifest$/i.test(n) && names.some(x => x.startsWith(m[1]) && /\/gifanimations\/sf_[^/]*(?:\.bundle)?$/i.test(x) && !/\.manifest$/i.test(x))) roots.add(m[1]);
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
    const mine = files.names.filter(n => n.startsWith(root) && !/\.manifest$/i.test(n));
    const pd = [root + AB + 'puzzledata', root + AB + 'puzzledata.unity3d', root + 'puzzledata', root + 'puzzledata.unity3d'].find(has);
    if (!pd) throw new Error('Puzzle data not found.');
    await load(pd);
    // tables: bundles (or plain IdxRes2 files)
    for (const n of mine) {
      const base = n.slice(n.lastIndexOf('/') + 1).replace(/_[0-9a-f]{32}(?=\.bundle$)/, '');
      const m = base.match(/^(idxres_(?:puzzlelist_picross|puzzlelist_ipcpicross|puzzlelist_large|text_puzzletitle|sounddef|puzzlecolordef))$/i);
      if (!m || !/idxresdata\//i.test(n)) continue;
      const d = await files.get(n);
      if (!d) continue;
      if (d[4] === 0x49 && d[5] === 0x64) blobs.push({ name: m[1], bytes: d }); // "IdxRes2…"
      else await load(n);
    }
    // song bundles by name: snd/bgm_00, …/bgm_01.wav_<hash>.bundle
    const clipFiles = new Map<string, string>();
    for (const n of mine) if (/\/snd[^/]*\//i.test(n)) clipFiles.set(n.slice(n.lastIndexOf('/') + 1).toLowerCase().replace(/\.bundle$/, '').replace(/_[0-9a-f]{32}$/, '').replace(/\.wav$/, ''), n);

    const table = (name: string) => { const b = blobs.find(x => x.name.toLowerCase() === name.toLowerCase()); return b ? idxRes2(b.bytes) : null; };
    // the puzzles the play lists name, in play order (leftovers in the bundle are never named, so never shown)
    const list = table('IdxRes_PuzzleList_Picross');
    const ipcList = table('IdxRes_PuzzleList_IpcPicross');
    const largeList = table('IdxRes_PuzzleList_Large');
    if (!list) throw new Error('Puzzle table not found.');
    const wanted = new Set(list.rows.map(r => r.values.find(v => typeof v === 'string') as string | undefined).filter((x): x is string => !!x));
    const wantedLarge = new Set(largeList?.rows.map(r => r.values.find(v => typeof v === 'string') as string | undefined).filter((x): x is string => !!x) ?? []);
    const wantedIpc = new Set(ipcList?.rows.map(r => r.values.find(v => typeof v === 'string') as string | undefined).filter((x): x is string => !!x) ?? []);

    // normal puzzles (.PRS) that the play lists name
    const raws = new Map<string, Raw>();
    for (const b of blobs) {
      const r = parsePuzzle(b.name, b.bytes);
      if (r && /^SF_/i.test(r.key) && (wanted.has(r.key) || wantedLarge.has(r.key)) && !raws.has(r.key)) raws.set(r.key, r);
    }
    if (!raws.size) throw new Error('No puzzles found.');
    // Mega Picross: a ".DPC" under the same key holds the pairs of lines (3DS .bdpc format); attach when the
    // picture is the same
    for (const b of blobs) {
      const m = b.name.match(/(\d+)x(\d+)/);
      const dpc = parseDpc(b.bytes, m ? [+m[1], +m[2]] : undefined);
      if (!dpc) continue;
      const r = raws.get(b.name);
      if (r && r.w === dpc.w && r.h === dpc.h && r.cells.every((c, i) => c === dpc.cells[i])) r.mega = { rows: dpc.rows, cols: dpc.cols };
    }
    // Colour Picross (.IPC) that the colour list names — their own puzzles, shown in Colour mode
    const ipcs: Raw[] = [];
    for (const b of blobs) { const r = parseIpc(b.name, b.bytes); if (r && /^SF_/i.test(r.key) && wantedIpc.has(r.key) && !ipcs.some(x => x.key === r.key)) ipcs.push(r); }

    // names: Text_PuzzleTitle (ten languages), by puzzle key
    const names = new Map<string, Text>();
    const tb = table('IdxRes_Text_PuzzleTitle');
    if (tb) for (const r of tb.rows) {
      const t: Text = {};
      tb.cols.forEach((c, i) => { const l = COL_LANG[c]; const v = r.values[i]; if (l && typeof v === 'string' && v.trim()) t[l] = v.trim(); });
      names.set(r.key.toLowerCase(), t);
    }
    // play order (the list's own rows only; the large/bonus keys keep the ascending fallback below,
    // exactly like nsw-picross-s.ts so this pack stays byte-identical to the stock importer's)
    const order = new Map<string, number>();
    list.rows.forEach((r, i) => { const k = r.values.find(v => typeof v === 'string'); if (k && typeof k === 'string' && !order.has(k.toLowerCase())) order.set(k.toLowerCase(), i); });
    const colorOrder = new Map<string, number>();
    ipcList?.rows.forEach((r, i) => { const k = r.values.find(v => typeof v === 'string'); if (k && typeof k === 'string' && !colorOrder.has(k.toLowerCase())) colorOrder.set(k.toLowerCase(), i); });

    // sounds: role → clip name
    const sound = new Map<string, string>();
    const isClip = (v: string) => audio.has(v) || clipFiles.has(v);
    table('IdxRes_SoundDef')?.rows.forEach(r => {
      const vs = r.values.filter((v): v is string => typeof v === 'string' && v.length > 0).map(v => v.toLowerCase().replace(/\.(wav|ogg)$/, ''));
      const v = vs.find(isClip) ?? vs.find(x => /^[\x20-\x7e]+$/.test(x));
      if (v) sound.set(r.key, v);
    });

    const all = [...raws.values(), ...ipcs];
    const seen = new Map<string, Raw>();
    for (const r of all.sort((a, b) => Number(!names.has(a.key.toLowerCase())) - Number(!names.has(b.key.toLowerCase())))) {
      const k = `${r.w}x${r.h}:${r.cells.join('')}`;
      if (!seen.has(k)) seen.set(k, r);
    }
    const list2 = [...seen.values()];
    const levels = [...sizeLevels(list2.filter(r => !r.colors), order, names, 'normal'), ...sizeLevels(list2.filter(r => r.colors), order, names, 'normal', true)];
    const music = await gameMusic(sound, audio, files, clipFiles);
    // the identical pack id/title as the stock importer's SF_ entry, so progress merges with it
    const pack: Pack = {
      format: 'momogram-pack', version: 1, id: 'nsw-picross-s-doraemon',
      title: { en: 'PICROSS S Doraemon & F Characters Edition' },
      source: { game: 'PICROSS S Doraemon & F Characters Edition', platform: 'Nintendo Switch', developer: 'Jupiter', year: 2024 },
      levels, theme: { ...music.theme, palette: switchPalette() }, assets: music.assets.length ? music.assets : undefined,
    };
    return [pack];
  },
});

/** a stable puzzle id within the pack, from the game's own key: SF_05x05_001 → 5x5-1, SF_Ipc_… → c5x5-1 */
function puzzleId(key: string, s: string, color: boolean): string {
  const rest = key.replace(/^SF_(?:Ipc_)?/, '').replace(/^.*?(\d+x\d+)_/, '').replace(/^0(?=\d\d(\D|$))/, '').toLowerCase().replace(/_/g, '-');
  return `${color ? 'c' : ''}${s}-${rest}`;
}

/** levels by size (the usual 15-puzzle levels and the larger sizes), in the game's order */
function sizeLevels(list: Raw[], order: Map<string, number>, names: Map<string, Text>, rules: 'free' | 'normal', color = false): PackLevel[] {
  const bySize = new Map<string, Raw[]>();
  for (const r of list) { const k = `${r.w}x${r.h}`; (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(r); }
  const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
  const levels: PackLevel[] = [];
  const pos = (r: Raw) => order.get(r.key.toLowerCase()) ?? 1e6 + (parseInt(r.key.replace(/^.*?(\d+)x\d+_?/, '')) || 0);
  for (const s of sizes) {
    const rs = bySize.get(s)!.sort((a, b) => pos(a) - pos(b));
    const puzzles: PackPuzzle[] = rs.map(r => {
      const own = r.title && !/^[\x00-\x7f]*$/.test(r.title) ? { ja: r.title } : undefined;
      const name = { ...own, ...names.get(r.key.toLowerCase()) };
      const cc = r.colorCells;
      return { id: puzzleId(r.key, s, color), width: r.w, height: r.h, rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1), name: Object.keys(name).length ? name : undefined,
        ...(r.mega ? { mega: r.mega } : {}),
        ...(cc && r.colors ? { colorGame: true, colorOnly: true, color: { palette: r.colors, rows: [...Array(r.h)].map((_, y) => [...cc.subarray(y * r.w, y * r.w + r.w)].map(v => (v ? (v - 1).toString(36) : '.')).join('')) } } : {}) };
    });
    const label = s.replace('x', '×');
    for (let i = 0; i < puzzles.length; i += 15) {
      const k = i / 15 + 1, many = puzzles.length > 15;
      levels.push(color
        ? { id: `c${s}-${k}`, title: { en: many ? `Color ${label} ${k}` : `Color ${label}`, ja: `カラー ${label}` }, rules, group: 'color', groupTitle: { en: 'Color Picross', ja: 'カラーピクロス' }, puzzles: puzzles.slice(i, i + 15) }
        : { id: `s${s}-${k}`, title: { en: many ? `${label} ${k}` : label }, rules, group: s, groupTitle: { en: label }, puzzles: puzzles.slice(i, i + 15) });
    }
  }
  return levels;
}

/** the game's songs as Ogg files: menu, puzzle tracks, clear jingle (same names as the other Switch games) */
async function gameMusic(sound: Map<string, string>, audio: Map<string, () => Promise<Uint8Array | undefined>>, files: GameFiles, clipFiles: Map<string, string>): Promise<{ theme: Pack['theme']; assets: PackAsset[] }> {
  const pick = (...keys: string[]) => keys.map(k => sound.get(k)).find(Boolean);
  const exists = (c: string) => audio.has(c) || clipFiles.has(c);
  const conv = (...cs: string[]) => cs.find(exists);
  const roles = {
    menu: pick('Mn_Bgm') ?? conv('bgm_00', 'bgm_01'),
    clear: pick('Gm_PrsClearJingle') ?? conv('jng_03', 'jg_03'),
  };
  let play = [...sound.entries()].filter(([k]) => /^Gm_Bgm(\d+|_Relaxing)?$/.test(k)).map(([, v]) => v);
  if (!play.length) play = ['bgm_01', 'bgm_02', 'bgm_03', 'bgm_04', 'bgm_05', 'bgm_06'].filter(c => exists(c) && c !== roles.menu);
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
    theme: { music: { title: f(roles.menu), menu: f(roles.menu), play: tracks[0], clear: f(roles.clear) }, tracks, songs: clips.filter(c => made.has(c)).sort().map(c => c + '.ogg') },
    assets,
  };
}
