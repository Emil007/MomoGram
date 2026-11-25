// SherloCAT Holmes Nonogram (Steam) — nonogram puzzles from its Unity asset bundle.
//
// The game keeps its puzzles as textures in a UnityFS bundle
// (`<game>_Data/data.unity3d` → `sharedassets0.assets`). Each Texture2D is named
// `<W>x<H>_<name>_pb`. The file stores the bottom row first, so the importer flips it.
// In the game only a black pixel is a clue cell, and blue or yellow pixels are given
// already filled. Those given cells are part of the finished picture, so here they count
// as filled too: with black cells only, 55 of the 114 puzzles are not line-solvable.
//
//   File (recognised by)              Puzzles
//   data.unity3d (UnityFS 5.x)        every Texture2D named <W>x<H>_…_pb in sharedassets0.assets
//                                     (114 puzzles; bebedouro and canhao are scene art and are dropped)
//
// The colored illustrations are not a color-picross layer. No mega mode, no color mode.
// Music is FSB5 Vorbis in sharedassets0.resource, remuxed to Ogg without a second encode.

import { registerSetImporter, GameFiles } from './index';
import { Pack, PackAsset, PackLevel, Text } from '../format';
import { readBundle, readSerialized, audioClip } from '../../rom/unity';
import { objectName, textureSize, gridFromTexture } from '../../rom/unity-texture';
import { readFsb5, fsbVorbisToOgg } from '../../audio/fsb5';

const SIZE_NAME: Record<string, string> = {
  '10x10': 'Pequeno', '15x10': 'Médio', '15x15': 'Médio', '20x15': 'Grande',
  '20x20': 'Grande', '25x20': 'Extra', '25x25': 'Extra', '30x30': 'Extra', '35x35': 'Extra',
};

registerSetImporter({
  name: 'SherloCAT Holmes Nonogram (Steam)',
  version: 2, // 2: texture header prefers the Unity 4/5 layout unless the 2017+ size is the one that fits
  find(names) {
    // only this game: every Unity player has a data.unity3d
    return names.filter(n => /sherlocat/i.test(n) && /data\.unity3d$/i.test(n))
      .map(n => n.split('/').slice(0, -1).join('/') || '.');
  },
  async read(files: GameFiles, root: string): Promise<Pack[]> {
    // the bundle file name as the player picked it
    const candidates = files.names.filter(n => /data\.unity3d$/i.test(n));
    if (!candidates.length) throw new Error('data.unity3d not in the picked files.');
    for (const c of candidates) {
      const rootOf = c.split('/').slice(0, -1).join('/') || '.';
      if (rootOf === root || rootOf === '.') {
        const bundle = await files.get(c);
        if (!bundle) continue;
        try {
          const pack = readBundlePack(bundle);
          await addMusic(pack, files);
          return [pack];
        } catch (e: any) {
          // try the next candidate (e.g. another game's data.unity3d)
          continue;
        }
      }
    }
    throw new Error('SherloCAT bundle could not be read.');
  },
});

function readBundlePack(bundle: Uint8Array): Pack {
  const content = readBundle(bundle);
  const shared = content.get('sharedassets0.assets');
  if (!shared) throw new Error('sharedassets0.assets not found in bundle.');
  const objs = readSerialized(shared);
  const puzzles: Array<{ id: string; w: number; h: number; rows: string[]; label: string }> = [];
  for (const o of objs) {
    if (o.classId !== 28) continue;               // Texture2D
    const name = objectName(o); if (!name) continue;
    const m = /^(\d+)[xX](\d+)_(.+)_(pb|col|pg)$/.exec(name); if (!m) continue;
    const w = +m[1], h = +m[2], key = m[4];
    if (key !== 'pb') continue;                    // solution textures only
    const t = textureSize(o); if (!t || t.w !== w || t.h !== h) continue;
    // row 0 is the top of the picture. Blue and yellow pixels are cells the game paints in
    // from the start; they are part of the finished picture, so they count as filled.
    const rows = gridFromTexture(o, w, h, t.format, t.complete, 200, true, false); if (!rows) continue;
    if (/^(bebedouro|canhao)$/i.test(m[3])) continue; // scene illustrations, not puzzles
    const rstr = rows.map(r => r.map(c => c ? '#' : '.').join(''));
    const filled = rstr.reduce((a, row) => a + row.split('#').length - 1, 0);
    if (!filled || filled === w * h) continue;
    puzzles.push({ id: `${w}x${h}-${m[3]}`, w, h, rows: rstr, label: m[3].replace(/_/g, ' ') });
  }
  if (!puzzles.length) throw new Error('No SherloCAT nonogram solution textures found.');
  puzzles.sort((a, b) => a.w * a.h - b.w * b.h);

  const bySize = new Map<string, typeof puzzles>();
  for (const p of puzzles) { const k = `${p.w}x${p.h}`; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k)!.push(p); }

  const levels: PackLevel[] = [...bySize.entries()].map(([size, ps], i) => ({
    id: `sh-${size}`,
    title: { en: `SherloCAT ${SIZE_NAME[size] ?? size}` },
    group: 'sherlocat',
    groupTitle: { en: 'SherloCAT Holmes' } as Text,
    rules: 'normal' as const,
    unlockAfter: i === 0 ? undefined : 1,
    puzzles: ps.map(p => ({ id: p.id, width: p.w, height: p.h, rows: p.rows, name: { en: p.label } })),
  }));

  return {
    format: 'momogram-pack',
    version: 1,
    id: 'steam-sherlocat',
    title: { en: 'SherloCAT Holmes Nonogram' },
    source: { game: 'SherloCAT Holmes Nonogram', platform: 'Steam', developer: 'MomBak' },
    theme: {
      palette: {
        accent: '#5a3a7a', fill: '#f7efdf', bg: '#efe4c8',
        style: 'notebook', grid: '#c8b890', clue: '#3a2a4a', cursor: '#8a5a9a',
      },
    },
    levels,
  };
}

async function addMusic(pack: Pack, files: GameFiles): Promise<void> {
  // FSB5 Vorbis is remuxed to Ogg with the bank's loop points in the comment header.
  // The packets stay as they are: a second encode would move the loop.
  // the sound bank is a separate file next to the bundle: <game>_Data/sharedassets0.resource
  const bankName = files.names.find(n => /sharedassets0\.resource$/i.test(n));
  if (!bankName) return;
  const res = await files.get(bankName);
  if (!res) return;
  // AudioClip references (name + offset + size) are in sharedassets0.assets, which we already parsed
  // to build the puzzles. Re-read the bundle so we know each BGM clip's offset into the .resource file.
  const bundleName = files.names.find(n => /data\.unity3d$/i.test(n));
  if (!bundleName) return;
  const bundle = await files.get(bundleName);
  if (!bundle) return;
  const content = readBundle(bundle);
  const shared0 = content.get('sharedassets0.assets');
  if (!shared0) return;
  const objs = readSerialized(shared0);
  const clips: Array<{ name: string; off: number; size: number }> = [];
  for (const o of objs) {
    const a = audioClip(o);
    if (a && a.source.endsWith('.resource') && a.name.startsWith('BGM_')) clips.push({ name: a.name, off: a.offset, size: a.size });
  }
  if (!clips.length) return;
  const assets: PackAsset[] = [];
  const made = new Set<string>();
  for (const c of clips) {
    const seg = res.subarray(c.off, c.off + (c.size || res.length - c.off));
    try {
      const { mode, samples } = readFsb5(seg);
      const ogg = mode === 15 && samples[0] ? fsbVorbisToOgg(samples[0]) : null;
      if (ogg) { assets.push({ name: c.name + '.ogg', data: ogg }); made.add(c.name); }
    } catch { /* clip not a readable bank */ }
  }
  if (!made.size) return;
  const f = (c?: string) => (c && made.has(c) ? c + '.ogg' : undefined);
  const role = (prefix: string) => clips.find(c => c.name.startsWith(prefix) && made.has(c.name))?.name;
  const m = role('BGM_title_birdy') ?? role('BGM_title_sherlocat');
  const es = role('BGM_game_ES'), ba = role('BGM_game_BA'), rj = role('BGM_game_RJ');
  const plays = [es, ba, rj, role('BGM_title_sherlock')].filter((x): x is string => !!x);
  pack.theme = pack.theme ?? {};
  if (m) pack.theme.music = { menu: f(m), title: f(m) };
  const tracks = [...new Set([...plays, m].filter((x): x is string => !!x))].map(c => c + '.ogg');
  if (tracks.length) pack.theme.tracks = tracks;
  const songs = [...made].map(c => c + '.ogg').sort();
  if (songs.length) pack.theme.songs = songs;
  pack.assets = assets;
}
