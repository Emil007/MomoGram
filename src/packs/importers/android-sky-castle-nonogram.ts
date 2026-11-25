// Sky castle - nonogram (com.healingjjam.skycastle, Healing JJAM) — nonogram puzzles from the Unity IL2CPP Android app.
//
// The game is a Unity 2022.3 (il2cpp) app. All puzzle solutions live in ONE atlas texture, the 1024×1024
// "Total" Texture2D (serialized format value 4 = ARGB32 in the legacy Unity enum; m_CompleteImageSize
// 1024·1024·4 = 4 MiB, single mip; pixels are kept inside the serialized object's own tail, there is no
// streaming .resS for it). The per-stage layout — which sub-rect of that atlas is which puzzle — ships in
// eleven JSON TextAssets ("Chapter01"…"Chapter11", loaded through Resources):
//
//   Chapter  = JSON { "name": [en, ko, ja], "info": [en, ko, ja], "index": n,
//                     "normalStages": [ StageInfo ], "bigStages": [ BigStage ] }
//   StageInfo = { "uniqueKey": "0"…, "name": [en, ko, ja], "x": px, "y": px, "width": cells, "height": cells }
//   BigStage  = { "name": [en, ko, ja], "xCount": c, "yCount": r, "stageInfos": [ StageInfo … c·r ] }
//
// `x`/`y` are pixel coordinates into the "Total" atlas; `width`/`height` are the puzzle cell counts. Each
// cell is exactly one atlas pixel (the +1 spacing seen between consecutive stage x's is the panel border
// pixel, not a cell gutter). The import reads the solution the same way the game does (PicrossMgr.
// GetStageTexture → CreateTexture cuts the StageInfo rect out of the Total atlas and PicrossRenderer/
// PicrossChecker test its pixels): a cell is FILLED when its atlas pixel is dark (luminance < 200, the
// illustrated linework on the light background), EMPTY otherwise. Verified against the game's own rendering
// and by line-solvability of the resulting clues (see VERIFIED.md → 92.7 %; the ~7 % not line-solvable are
// large, heavily anti-aliased big-stage illustrations — still honest pictures, see ANALYSIS.md).
//
// Modes:
//  - NORMAL: 96 monotone nonograms (the 11 chapters' normalStages; 5×5 … 15×15). Group "normal".
//  - BIG ("큰 그림"), 701 monotone nonograms in 86 BigStage composites: each composite is a picture split
//    into xCount×yCount panels, every panel being its own playable stage with its own uniqueKey and name
//    (10×10 … 20×20). This is NOT the paired-line Mega format of Jupiter's games (game/mega.ts) — there are
//    no pair tables and no two-cell-spanning clue numbers anywhere; a composite is simply several
//    independent nonogram rectangles that together draw one illustration. Imported as separate puzzles in
//    a "big" group per chapter/composite, like the game's own stage lists.
//  - COLOR: not present. Every stage is stored as a single monotone illustration layer; the only "color"
//    in the code is useColorFill (an auto-fill convenience for the player's pen, PicrossChecker), not a
//    multi-colour puzzle mode. Short evidence in ANALYSIS.md.
//  - MEGA (paired-line): not present (see BIG above).
//
// Chapter flow: the app unlocks chapters in order (Chapter 1 first … Chapter 11 last; the last needs all
// normal + big stages of chapter 10). MomoGram mirrors that: one level per chapter, ordered by index, each
// carrying its normal stages plus its big-stage group levels; unlockAfter counts the previous level's
// puzzles so exploring feels like the app.
//
// Container-agnostic (owner requirement): detect/read never depend on the file extension. The real markers
// that decide are
//   - the package name "com.healingjjam.skycastle" in the binary AndroidManifest.xml (UTF-16LE),
//   - the Unity bundle with the "Total" 1024×1024 atlas Texture2D plus JSON Chapter* stage tables whose
//     normal stages decode to valid w×h pictures with unique uniqueKeys.
// .xapk / .apkm / .zip unwrap to the base APK (a zip with those assets) recursively; an XAPK with split
// APKs picks the apk that holds the Unity bundle. An already-extracted base-APK folder is read by the Set
// variant below (same read path).
//
// Icon: the base APK ships res/mipmap-{ldpi…xxxhdpi}-v4/app_icon.png (and app_icon_round.png); the importer
// picks the biggest standalone PNG (no adaptive layers here), decodes it to RGBA and ships it as pack.icon
// (192×192 xxxhdpi; see VERIFIED.md and _code/icons/).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon } from '../format';
import { readBundle, readSerialized, textAsset, UObject } from '../../rom/unity';
import { textureSize } from '../../rom/unity-texture';
import { unzipSync, unzlibSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.healingjjam.skycastle';
const ATLAS = 1024;
const FILL_LUM = 200;

/** true when the entries are a Sky castle app container (manifest package + Unity bundle with Total atlas + chapter tables). */
export function looksLike(entries: Entry[]): boolean {
  let hasManifest = false, hasBundle = false;
  for (const e of entries) {
    if (!hasManifest && /^AndroidManifest\.xml$/i.test(e.name)) {
      const nd = new TextEncoder().encode(PKG);
      const d = e.data;
      for (let i = 0; i + nd.length * 2 <= d.length; i += 2) {
        let all = true;
        for (let k = 0; k < nd.length; k++) if (d[i + k * 2] !== nd[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
        if (all) { hasManifest = true; break; }
      }
    }
    if (/(?:^|\/)data\.unity3d$/i.test(e.name) && e.data.length > 1000) {
      if (unityDataHasMarkers(e.data)) hasBundle = true;
    }
    if (hasManifest && hasBundle) return true;
  }
  return hasManifest && hasBundle;
}

/** does this Unity bundle carry the Sky castle markers: the Total 1024² atlas + JSON Chapter* tables? */
function unityDataHasMarkers(bundle: Uint8Array): boolean {
  try {
    const content = readBundle(bundle);
    let hasAtlas = false, chapterCount = 0;
    const seenCh = new Set<number>();
    for (const [n, v] of content) {
      if (v.length < 4096 || /\.res(ource|S)$/i.test(n)) continue;
      const objs = readSerialized(v);
      for (const o of objs) {
        if (!hasAtlas && o.classId === 28) {
          const name = objectNameOf(o);
          if (name === 'Total' && o.data.length >= ATLAS * ATLAS * 4) {
            const c = textureFields(o);
            if (c && c.w === ATLAS && c.h === ATLAS && o.data.length - c.complete >= 0 && o.data.length - c.complete <= 512) hasAtlas = true;
          }
        }
        if (o.classId === 49) {
          const t = textAsset(o);
          if (t && /^Chapter\d+$/i.test(t.name)) {
            try {
              const j = JSON.parse(new TextDecoder().decode(t.bytes));
              if (Array.isArray(j.normalStages) && typeof j.index === 'number' && Array.isArray(j.bigStages)) {
                if (!seenCh.has(j.index)) { seenCh.add(j.index); chapterCount++; }
              }
            } catch { /* not a stage table */ }
          }
        }
        if (hasAtlas && chapterCount >= 3) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's own assets are on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 3) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  // a multi-APK XAPK: the base APK is the one carrying the Unity bundle
  const apks = entries.filter(e => /\.apk$/i.test(e.name));
  const withBundle = apks.filter(e => {
    try { return Object.keys(unzipSync(e.data)).some(k => /(?:^|\/)data\.unity3d$/i.test(k)); } catch { return false; }
  }).sort((a, b) => b.data.length - a.data.length);
  const inner = withBundle[0] ?? apks.sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length) return sub;
  }
  return entries;
}

// ——— Unity object reading (repo helpers + small slices for Texture2D) ———

function objectNameOf(o: UObject): string | null {
  const d = o.data;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, o.le ?? true);
  if (!(len > 0 && len < 256 && 4 + len <= d.length)) return null;
  return new TextDecoder().decode(d.subarray(4, 4 + len));
}

/** Texture2D header fields via the repo reader (handles both the old 4.x layout and the modern one
 *  with m_ForcedFallbackFormat / m_DownscaleFallback before width — see rom/unity-texture.ts). */
function textureFields(o: UObject): { w: number; h: number; complete: number; format: number } | null {
  const d = o.data, le = o.le ?? true;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u32 = (at: number) => dv.getUint32(at, le);
  const ts = textureSize(o);
  if (!ts) return null;
  const w = ts.w, h = ts.h, format = ts.format;
  const complete = ts.complete ?? w * h * 4;
  if (!(w > 0 && w <= 4096 && h > 0 && h <= 4096) || complete < w * h) return null;
  return { w, h, complete, format };
}

function atlasPixels(o: UObject, w: number, h: number): Uint8Array {
  const c = textureFields(o)!;
  return o.data.subarray(o.data.length - c.complete);
}

/** the game data: every chapter with its normal stages and big-stage composites. */
interface StageInfo { uk: string; name: string[]; w: number; h: number; x: number; y: number; grid: string[] }
interface BigGroup { name: string[]; xCount: number; yCount: number; stages: StageInfo[] }
interface Chapter { index: number; name: string[]; normal: StageInfo[]; big: BigGroup[] }

/** filled when the atlas pixel's luminance < FILL_LUM (dark linework on the light background). */
function cellFilled(px: Uint8Array, x: number, y: number): boolean {
  const o = (y * ATLAS + x) * 4;
  const l = (px[o] + px[o + 1] + px[o + 2]) / 3;
  return l < FILL_LUM;
}

interface Atlas { px: Uint8Array }

/** read the bundle: the Total atlas pixels + all chapters (both live in resources.assets here). */
export function readGame(bundle: Uint8Array): { atlas: Atlas; chapters: Chapter[] } {
  const content = readBundle(bundle);
  let atlas: Atlas | null = null;
  let chapters: Chapter[] = [];
  for (const [n, v] of content) {
    if (v.length < 4096 || /\.res(ource|S)$/i.test(n)) continue;
    const objs = readSerialized(v);
    // atlas
    if (!atlas) for (const o of objs) {
      if (o.classId !== 28) continue;
      const name = objectNameOf(o);
      const c = textureFields(o);
      if (name === 'Total' && c && c.w === ATLAS && c.h === ATLAS && o.data.length - c.complete >= 0 && o.data.length - c.complete <= 512) {
        atlas = { px: atlasPixels(o, c.w, c.h) };
        break;
      }
    }
    // chapters (pass 1: if the atlas is in a later file, we still gather the JSON first)
    const ch = chaptersOf(objs, atlas && atlas.px);
    if (ch.length && !chapters.length) chapters = ch;
    if (atlas && chapters.length) break;
  }
  if (!atlas) throw new Error('Sky castle: the Total 1024×1024 solution atlas was not found.');
  if (atlas && !chapters.length) {
    for (const [n, v] of content) {
      if (v.length < 4096 || /\.res(ource|S)$/i.test(n)) continue;
      const objs = readSerialized(v);
      const ch = chaptersOf(objs, atlas.px);
      if (ch.length) { chapters = ch; break; }
    }
  }
  if (!chapters.length) throw new Error('Sky castle: no Chapter stage tables found.');
  return { atlas, chapters };
}

function chaptersOf(objs: UObject[], atlasPx: Uint8Array | null): Chapter[] {
  const out: Chapter[] = [];
  const seen = new Set<number>();
  for (const o of objs) {
    if (o.classId !== 49) continue;
    const t = textAsset(o);
    if (!t || !/^Chapter\d+$/i.test(t.name)) continue;
    let json: any;
    try { json = JSON.parse(new TextDecoder().decode(t.bytes)); } catch { continue; }
    if (!Array.isArray(json.normalStages) || typeof json.index !== 'number' || seen.has(json.index)) continue;
    const px = atlasPx;
    const ch: Chapter = { index: json.index, name: json.name ?? [], normal: [], big: [] };
    for (const s of json.normalStages ?? []) {
      if (!s || typeof s.x !== 'number' || typeof s.width !== 'number') continue;
      const x = s.x, y = s.y, w = s.width, h = s.height;
      if (!(w >= 1 && w <= 64 && h >= 1 && h <= 64) || x + w > ATLAS || y + h > ATLAS) continue;
      const grid: string[] = [];
      if (px) for (let yy = 0; yy < h; yy++) { let row = ''; for (let xx = 0; xx < w; xx++) row += cellFilled(px, x + xx, y + yy) ? '#' : '.'; grid.push(row); }
      ch.normal.push({ uk: String(s.uniqueKey), name: Array.isArray(s.name) ? s.name : [], w, h, x, y, grid });
    }
    for (const bs of json.bigStages ?? []) {
      if (!Array.isArray(bs.stageInfos) || bs.stageInfos.length === 0) continue;
      const gr: BigGroup = { name: bs.name ?? [], xCount: bs.xCount ?? 0, yCount: bs.yCount ?? 0, stages: [] };
      for (const s of bs.stageInfos) {
        if (!s || typeof s.x !== 'number' || typeof s.width !== 'number') continue;
        const x = s.x, y = s.y, w = s.width, h = s.height;
        if (!(w >= 1 && w <= 64 && h >= 1 && h <= 64) || x + w > ATLAS || y + h > ATLAS) continue;
        const grid: string[] = [];
        if (px) for (let yy = 0; yy < h; yy++) { let row = ''; for (let xx = 0; xx < w; xx++) row += cellFilled(px, x + xx, y + yy) ? '#' : '.'; grid.push(row); }
        gr.stages.push({ uk: String(s.uniqueKey), name: Array.isArray(s.name) ? s.name : [], w, h, x, y, grid });
      }
      if (gr.stages.length) ch.big.push(gr);
    }
    if (ch.normal.length) { out.push(ch); seen.add(ch.index); }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ——— pack construction ———

const NAME_LANGS = ['en', 'ko', 'ja'];
function textOf(a: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < NAME_LANGS.length && i < a.length; i++) if (a[i]) out[NAME_LANGS[i]] = a[i];
  return out;
}

function stagePuzzle(st: StageInfo, prefix: string): PackPuzzle {
  const p: PackPuzzle = { id: `${prefix}${st.uk}`, width: st.w, height: st.h, rows: st.grid };
  const nm = textOf(st.name);
  if (Object.keys(nm).length) p.name = nm;
  return p;
}

export function packFromEntries(entries: Entry[]): Pack {
  let bundleData: Uint8Array | null = null;
  for (const e of entries) if (/(?:^|\/)data\.unity3d$/i.test(e.name) && e.data.length > 1000) { bundleData = e.data; break; }
  if (!bundleData) throw new Error('Sky castle data.unity3d not found.');
  const { chapters } = readGame(bundleData);
  if (!chapters.length) throw new Error('Sky castle: no Chapter stage tables found.');

  const levels: PackLevel[] = [];
  let solvedSoFar = 0;
  for (let c = 0; c < chapters.length; c++) {
    const ch = chapters[c];
    for (const gr of ch.big) {
      const plain = (gr.name?.[0] ?? `picture-${c}`).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || `picture-${c}`;
      const level: PackLevel = {
        id: `big-${ch.index}-${plain}`,
        title: textOf(gr.name),
        group: 'big', groupTitle: { en: 'Big Picture', ko: '큰 그림', ja: '大きな絵' },
        rules: 'normal', puzzles: gr.stages.map(s => stagePuzzle(s, 'b-')), unlockAfter: solvedSoFar,
      };
      levels.push(level);
    }
    const chLevel: PackLevel = {
      id: `ch${ch.index}`,
      title: { en: `Chapter ${ch.index + 1}`, ko: `챕터 ${ch.index + 1}`, ja: `第${ch.index + 1}章` },
      group: 'normal', groupTitle: { en: 'Normal', ko: '노멀', ja: 'ノーマル' },
      rules: 'normal', puzzles: ch.normal.map(s => stagePuzzle(s, 'n-')), unlockAfter: solvedSoFar,
    };
    if (ch.index === 0) delete chLevel.unlockAfter;
    levels.push(chLevel);
    solvedSoFar += ch.normal.length;
  }

  const normalCount = chapters.reduce((a, c) => a + c.normal.length, 0);
  const bigCount = chapters.reduce((a, c) => a + c.big.reduce((b, g) => b + g.stages.length, 0), 0);
  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-sky-castle-nonogram',
    title: { en: 'Sky castle - nonogram', ko: '하늘성 - 네모네모로직', ja: 'スカイキャッスル - ピクロス' },
    source: {
      game: 'Sky castle - nonogram', platform: 'Android', developer: 'Healing JJAM',
      file: `${normalCount} normal + ${bigCount} big = ${normalCount + bigCount} puzzles`,
    },
    theme: { palette: {
      accent: '#6a8cff', fill: '#26314d', cell: '#f4f7ff', grid: '#c9d4e0', clue: '#1e2740',
      cross: '#e05050', cursor: '#ffb340', bg: '#eef2fb', style: 'default',
    } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file = `${pack.source.file} (icon ${icon.name} ${icon.w}x${icon.h})`; }
  return pack;
}

/** biggest standalone launcher png (app_icon / ic_launcher), decoded as RGBA */
function findIcon(entries: Entry[]) {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/[^/]+\/(?:app_icon|ic_launcher)[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (/(?:foreground|background)\.png$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { name: best.name, icon: makeIcon(px.w, px.h, new Uint8Array(px.rgba)), w: px.w, h: px.h };
}

/** minimal PNG decoder (8-bit RGBA / RGB / grey, non-interlaced, multi-IDAT). */
function pngRgba(d: Uint8Array): { w: number; h: number; rgba: ArrayBuffer } | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50) return null;
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null;
  const w = (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19];
  const h = (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23];
  const depth = d[24], ctype = d[25];
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024) || depth !== 8) return null;
  let bpp = 0;
  if (ctype === 6) bpp = 4; else if (ctype === 2) bpp = 3; else if (ctype === 0) bpp = 1; else return null;
  const idats: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= d.length) {
    const len = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    if (type === 'IEND') break;
    if (type === 'IDAT') idats.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  if (!idats.length) return null;
  let tl = 0;
  for (const id of idats) tl += id.length;
  const all = new Uint8Array(tl);
  let at = 0;
  for (const id of idats) { all.set(id, at); at += id.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(all); } catch { return null; }
  const stride = w * bpp;
  const want = (stride + 1) * h;
  if (raw.length < want) return null;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x];
      cur[x] = filter === 0 ? f :
        filter === 1 ? (f + a) & 0xff :
        filter === 2 ? (f + b) & 0xff :
        filter === 3 ? (f + ((a + b) >> 1)) & 0xff :
        (f + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const ci = x * bpp;
      const di = (y * w + x) * 4;
      if (ctype === 6) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = cur[ci + 3]; }
      else if (ctype === 2) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = 255; }
      else { const v = cur[ci]; out[di] = v; out[di + 1] = v; out[di + 2] = v; out[di + 3] = 255; }
    }
    prev.set(cur);
  }
  return { w, h, rgba: out.buffer };
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

registerImporter({
  name: 'Sky castle - nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { return looksLike(entriesOf(data)); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Sky castle APK: marker bundle/chapter data missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Sky castle - nonogram (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (/(?:^|\/)data\.unity3d$/i.test(n) && /assets\/bin\/Data\//i.test(n)) roots.add(n.slice(0, n.indexOf('assets/')) || '.');
      else if (/^AndroidManifest\.xml$/i.test(n)) roots.add('.');
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) roots.add(n);
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      const data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    if (!looksLike(all)) throw new Error('Not a Sky castle APK: marker bundle/chapter data missing.');
    return [packFromEntries(all)];
  },
});
