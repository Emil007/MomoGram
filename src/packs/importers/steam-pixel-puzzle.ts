// Pixel Puzzle Makeout League (Steam) — colour nonograms in Unity Addressables bundles.
//
//   File (recognised by)                                      Puzzles
//   <game>_Data/StreamingAssets/aa/catalog.bundle             288 colour nonograms in 6 chapters
//     plus StandaloneWindows64/*.bundle                         22 × 5×5, 79 × 10×10, 187 × 15×15
//
// The catalogue names each puzzle `Assets/Data/Puzzles/<chapter>_<episode>_<Title>.txt`.
// The text is a palette (`1: #a53b31`) and a grid of those indices. Every cell is part of
// the picture, so the puzzle exists only as a colour nonogram. The bundles themselves sit in
// StandaloneWindows64/, next to the catalogue rather than beside it.
//
// Music is FSB5 Vorbis. The game ships about forty arrangements (about 300 MB), so the pack
// keeps the title theme, the four puzzle tracks the chapters use most, and the clear jingle.

import { registerSetImporter } from './index';
import { Pack, PackAsset, PackLevel, PackPuzzle, Text } from '../format';
import { readBundle, readSerialized, audioClip, serializedFiles, namedBlobs } from '../../rom/unity';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

const CHAPTERS = ['1', '2', '3', '4', '5', '6'];
const MENU = 'music_youre_alright.ogg';
const PLAY = ['music_take_you.ogg', 'music_the_pieces_fit.ogg', 'music_talk_jams.ogg', 'music_trees_and_stuff.ogg'];
const CLEAR = 'ending_piano1.wav';
const MUSIC = new Set([
  'Assets/Audio/Music/music_youre_alright.asset',
  'Assets/Audio/Music/music_take_you.asset',
  'Assets/Audio/Music/music_the_pieces_fit.asset',
  'Assets/Audio/Music/music_talk_jams.asset',
  'Assets/Audio/Music/music_trees_and_stuff.asset',
  'Assets/Audio/SFX/ending_piano1.wav',
]);

registerSetImporter({
  name: 'Pixel Puzzle Makeout League (Steam)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (!/makeout/i.test(n)) continue;
      const m = n.match(/^(.*\/)?aa\/catalog\.bundle$/i);
      if (m) roots.add(m[1] ?? '');
    }
    return [...roots];
  },
  async read(files, root): Promise<Pack[]> {
    const cat = files.names.find(n => n.startsWith(root) && /\/aa\/catalog\.bundle$/i.test(n));
    if (!cat) return [];
    const data = await files.get(cat);
    if (!data) return [];
    const catalogJson = readCatalogText(data);
    if (!catalogJson) throw new Error('Addressables catalogue could not be read.');
    const pathToBundle = readCatalogLocations(catalogJson);
    const puzzles: Array<{ name: string; bundle: string }> = [];
    for (const [path, bundle] of pathToBundle) {
      if (!/^Assets\/Data\/Puzzles\/\d+_\d+_.+\.txt$/.test(path) || /\/Groups\//.test(path)) continue;
      puzzles.push({ name: path.split('/').pop()!.replace(/\.txt$/, ''), bundle });
    }
    if (!puzzles.length) return [];
    const aa = cat.replace(/\/catalog\.bundle$/i, '');
    const cache = new Map<string, Uint8Array | null>();
    const readAt = async (p: string) => { try { return await files.get(p); } catch { return undefined; } };
    const getBundle = async (name: string) => {
      if (cache.has(name)) return cache.get(name)!;
      const file = name.split('/').pop()!;
      const d = await readAt(`${aa}/StandaloneWindows64/${file}`) ?? await readAt(`${aa}/${name}`) ?? await readAt(`${aa}/${file}`);
      cache.set(name, d ?? null);
      return d ?? null;
    };
    const levels = new Map<string, PackLevel>();
    let missed = 0;
    for (const { name, bundle } of puzzles) {
      const m = name.match(/^(\d+)_(\d+)_(.+)$/);
      if (!m) continue;
      const [, chapter, episode, title] = m;
      const d = await getBundle(bundle);
      const text = d ? textAsset(d, name) : null;
      const parsed = text ? parseTxt(text) : null;
      if (!parsed) { missed++; continue; }
      const pz: PackPuzzle = {
        id: `c${chapter}-e${episode.padStart(2, '0')}-${slug(title)}`,
        width: parsed.w, height: parsed.h, rows: parsed.rows,
        name: { en: title.replace(/_/g, ' ') },
        colorGame: true, colorOnly: true,
        color: { palette: parsed.palette, rows: parsed.colorRows },
      };
      let lv = levels.get(chapter);
      if (!lv) {
        lv = { id: `ch${chapter}`, title: { en: `Chapter ${chapter}` } as Text, group: 'story', groupTitle: { en: 'Story' }, rules: 'normal', puzzles: [] };
        levels.set(chapter, lv);
      }
      lv.puzzles.push(pz);
    }
    if (!levels.size) throw new Error('No readable colour grids in the Addressables bundles.');
    if (missed) console.warn(`[Pixel Puzzle Makeout League] skipped ${missed} puzzles whose bundles could not be read`);
    const list = CHAPTERS.filter(c => levels.has(c)).map(c => levels.get(c)!);
    for (const lv of list) lv.puzzles.sort((a, b) => a.id < b.id ? -1 : 1);
    for (let i = 1; i < list.length; i++) list[i].unlockAfter = 1;
    const assets = await musicAssets(pathToBundle, getBundle);
    const has = (n: string) => assets.some(a => a.name === n);
    const menu = has(MENU) ? MENU : undefined;
    const play = PLAY.filter(has);
    const clear = has(CLEAR) ? CLEAR : undefined;
    const songs = [menu, ...play, clear].filter((n): n is string => !!n);
    return [{
      format: 'momogram-pack', version: 1,
      id: 'steam-pixel-puzzle-makeout-league',
      title: { en: 'Pixel Puzzle Makeout League' },
      source: { game: 'Pixel Puzzle Makeout League', platform: 'Steam', developer: 'Rude Ghost, LLC', file: root.replace(/\/$/, '') || cat },
      theme: {
        palette: { accent: '#ff4d8d', fill: '#2b1a2e', bg: '#f6eef2', style: 'default', grid: '#d9c4cf', clue: '#4a2b3a', cursor: '#ff7bab' },
        ...(songs.length ? { music: { ...(menu ? { menu, title: menu } : {}), ...(play[0] ? { play: play[0] } : {}), ...(clear ? { clear } : {}) }, tracks: play, songs } : {}),
      },
      levels: list,
      assets,
    }];
  },
});

function readCatalogText(data: Uint8Array): string | null {
  try {
    for (const [, v] of readBundle(data)) {
      for (const o of readSerialized(v)) {
        if (o.classId !== 49) continue;
        const dv = new DataView(o.data.buffer, o.data.byteOffset, o.data.byteLength);
        const nameLen = dv.getUint32(0, o.le);
        const oo = 4 + nameLen + (nameLen % 4 ? 4 - (nameLen % 4) : 0);
        const n = dv.getUint32(oo, o.le);
        const payload = new TextDecoder().decode(o.data.subarray(oo + 4, oo + 4 + n));
        if (payload.trimStart().startsWith('{')) return payload;
      }
    }
  } catch { /* not this bundle layout */ }
  return null;
}

/** asset path → bundle file, from the Addressables catalogue (key list + 7-word entries) */
function readCatalogLocations(json: string): Map<string, string> {
  const c = JSON.parse(json);
  const out = new Map<string, string>();
  const keys: string[] = Array.isArray(c.m_Keys) ? c.m_Keys : [];
  const raw = typeof c.m_EntryDataString === 'string' ? atob(c.m_EntryDataString) : '';
  const entry = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) entry[i] = raw.charCodeAt(i);
  const dv = new DataView(entry.buffer);
  const n = entry.length >= 4 ? dv.getUint32(0, true) : 0;
  let p = 4;
  for (let i = 0; i < n && p + 28 <= entry.length; i++, p += 28) {
    const asset = keys[dv.getUint32(p + 20, true)];
    const bundle = keys[dv.getUint32(p + 8, true)];
    if (bundle?.endsWith('.bundle') && asset) out.set(asset, bundle);
  }
  return out;
}

function textAsset(bundle: Uint8Array, name: string): string | null {
  const want = new Set([name, `${name}.txt`, name.replace(/\.txt$/, '')]);
  try {
    for (const [, v] of readBundle(bundle)) {
      for (const b of namedBlobs(readSerialized(v))) if (want.has(b.name)) return new TextDecoder().decode(b.bytes);
    }
  } catch { /* a bundle that is not a puzzle */ }
  return null;
}

function parseTxt(text: string): { palette: string[]; rows: string[]; colorRows: string[]; w: number; h: number } | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const palette: string[] = [];
  const palMap = new Map<string, number>();
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^([0-9A-Za-z]+):\s*(#[0-9a-fA-F]{6,8})\s*$/);
    if (!m) break;
    palMap.set(m[1], palette.length);
    palette.push(m[2].toLowerCase().slice(0, 7));
  }
  const grid = lines.slice(i).filter(l => !l.startsWith('#')).map(l => l.split(/\s+/).filter(Boolean)).filter(r => r.length);
  if (!grid.length) return null;
  const h = grid.length, w = Math.max(...grid.map(r => r.length));
  if (w < 1 || h < 1 || w > 40 || h > 40) return null;
  const rows: string[] = [], colorRows: string[] = [];
  for (const r of grid) {
    let mono = '';
    const color: string[] = [];
    for (let x = 0; x < w; x++) {
      const cell = r[x] ?? '.';
      const v = palMap.get(cell);
      mono += v === undefined ? '.' : '#';
      color.push(v === undefined ? '.' : v.toString(36));
    }
    rows.push(mono);
    colorRows.push(color.join(''));
  }
  return { palette, rows, colorRows, w, h };
}

/** FSB5 Vorbis is remuxed to Ogg. A short PCM16 sting (the clear jingle) is wrapped as WAV. */
async function musicAssets(locations: Map<string, string>, getBundle: (name: string) => Promise<Uint8Array | null>): Promise<PackAsset[]> {
  const out: PackAsset[] = [];
  for (const [path, bundle] of locations) {
    if (!MUSIC.has(path)) continue;
    const d = await getBundle(bundle);
    if (!d) { console.warn('[Pixel Puzzle Makeout League] missing bundle for', path); continue; }
    const audio = clipAudio(d);
    if (!audio) { console.warn('[Pixel Puzzle Makeout League] no readable audio in', path); continue; }
    out.push({ name: path.split('/').pop()!.replace(/\.(asset|wav)$/, '') + audio.ext, data: audio.data });
  }
  return out;
}

function clipAudio(d: Uint8Array): { data: Uint8Array; ext: string } | null {
  const { files, resources } = serializedFiles(d);
  for (const f of files) {
    let objs;
    try { objs = readSerialized(f); } catch { continue; }
    for (const o of objs) {
      const a = audioClip(o);
      if (!a?.size) continue;
      const file = a.source.split('/').pop() ?? '';
      const res = resources.get(file) ?? [...resources.values()].find(v => v.length >= a.offset + a.size);
      if (!res) continue;
      try {
        const { mode, samples } = readFsb5(res.subarray(a.offset, a.offset + a.size));
        const s = samples[0];
        if (!s) continue;
        if (mode === 15) { const ogg = fsbVorbisToOgg(s); if (ogg) return { data: ogg, ext: '.ogg' }; }
        if (mode === 2) return { data: pcm16Wav(s), ext: '.wav' };
      } catch { /* not a readable bank */ }
    }
  }
  return null;
}

/** FSB5 mode 2 is little-endian PCM16, which a WAV header makes playable. */
function pcm16Wav(s: { rate: number; channels: number; samples: number; data: Uint8Array }): Uint8Array {
  const pcm = s.data.subarray(0, Math.min(s.data.length, s.samples * s.channels * 2));
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  dv.setUint32(4, 36 + pcm.length, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, s.channels, true);
  dv.setUint32(24, s.rate, true);
  dv.setUint32(28, s.rate * s.channels * 2, true);
  dv.setUint16(32, s.channels * 2, true);
  dv.setUint16(34, 16, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
