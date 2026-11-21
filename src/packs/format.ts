// MomoGram pack format. A pack is plain JSON (pack.json), optionally zipped together with
// other packs. Packs are generated locally by the user from games they own; none ship with MomoGram.

export type Lang = 'en' | 'de' | 'fr' | 'it' | 'es' | 'ja' | 'ko';
export type Text = Partial<Record<Lang, string>>;
export type Rules = 'normal' | 'free';

export interface PackPuzzle {
  /** where a puzzle comes from when it is shown outside its game (daily, random) */
  from?: string;
  /** the same puzzle in its game ("<pack id>/<puzzle id>"): solving it here counts there too (daily puzzles) */
  origin?: string;
  /** only in this region's release of the game (set when regions are merged) */
  exclusive?: string;
  /** stable id within the pack, e.g. "n01-03" */
  id: string;
  width: number;
  height: number;
  /** one string per row, '#' = filled, '.' = empty */
  rows: string[];
  name?: Text;
  /** optional full-colour solved picture: one string per row of palette indices (base36), '.' = use default */
  color?: { palette: string[]; rows: string[] };
}

export interface PackLevel {
  id: string;
  title: Text;
  /** name of the level's group (mode), shown when a pack has several */
  groupTitle?: Text;
  rules: Rules;
  puzzles: PackPuzzle[];
  /** puzzles solved (across the pack) needed to unlock; 0 = open */
  unlockAfter?: number;
  /** unlocked when every other level in the same group is cleared under the time limit */
  extra?: boolean;
  group?: string;
}

/** Look & sound of the original game. Music lives in separate asset files next to the pack (never in the JSON). */
export interface PackTheme {
  /** colours imitating the original: an accent colour (UI and grid tint), optional explicit fill / background */
  palette?: {
    accent: string; fill?: string; bg?: string; cell?: string; grid?: string; clue?: string; cross?: string; cursor?: string; hint?: string;
    /** the board's design: dmg / gbc (Game Boy), switch (Jupiter's Switch games), default (MomoGram's look in the game's colours) */
    style?: 'dmg' | 'gbc' | 'switch' | '3ds' | 'stone' | 'notebook' | 'ds' | 'logic' | 'default';
    /** exact board colours and shape settings of the game, over the style's own (see Theme in game/view.ts) */
    board?: Record<string, string | number | boolean | string[]>;
    /** screen colours around the board: page background, panels, top bar */
    screen?: { bg?: string; panel?: string; top?: string };
    /** more board colours (used by the switch style): guide lines every 5, the cursor's line in the clues and on the board, marks, solved clues */
    grid5?: string; clueFocus?: string; hl?: string; mark?: string; done?: string; cursorBox?: string; mistake?: string;
  };
  /** asset names per role; an SDAT asset also names the sequence ("sound.sdat#SEQ_NAME") */
  music?: Partial<Record<'menu' | 'play' | 'play2' | 'clear' | 'title', string>>;
  /** the pack has coloured solved pictures (asset pictures.bin) */
  pictures?: boolean;
  /** every in-game track the game offers (random music picks from these); defaults to play / play2 */
  tracks?: string[];
  /** every song of the game, also those it plays nowhere MomoGram knows of (for the sound test) */
  songs?: string[];
  /** songs the player switched off: never played */
  off?: string[];
  /** when the player last changed where songs are played (sound test): such a pack keeps its tags on a new import */
  edited?: number;
}

/** small picture of the game: width × height RGBA pixels, base64 */
export interface PackIcon { w: number; h: number; rgba: string }

export function makeIcon(w: number, h: number, px: Uint8Array): PackIcon {
  let bin = '';
  for (let i = 0; i < px.length; i++) bin += String.fromCharCode(px[i]);
  return { w, h, rgba: btoa(bin) };
}

/** Binary file belonging to a pack (music), kept in IndexedDB and written next to the pack in zip exports. */
export interface PackAsset { name: string; data: Uint8Array }

export interface Pack {
  format: 'momogram-pack';
  version: 1;
  id: string;
  title: Text;
  /** where the puzzles came from, shown in the pack manager */
  source: { game: string; platform: string; region?: string; developer?: string; year?: number; file?: string; sha1?: string };
  levels: PackLevel[];
  createdBy?: string;
  theme?: PackTheme;
  /** the game's own icon, read from the user's file (RGBA, base64) */
  icon?: PackIcon;
  /** revision: when this version of the pack was made (ms since 1970); missing = 1, older pack files */
  rev?: number;
  /** only while importing: assets the importer extracted (stored separately, stripped before saving) */
  assets?: PackAsset[];
}

export function rowsFromBits(w: number, h: number, bit: (x: number, y: number) => boolean): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += bit(x, y) ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

export function validatePack(p: any): p is Pack {
  if (!p || p.format !== 'momogram-pack' || p.version !== 1 || !Array.isArray(p.levels)) return false;
  for (const l of p.levels) {
    if (!Array.isArray(l.puzzles)) return false;
    for (const z of l.puzzles) {
      if (!Array.isArray(z.rows) || z.rows.length !== z.height) return false;
      if (z.rows.some((r: string) => typeof r !== 'string' || r.length !== z.width || /[^#.]/.test(r))) return false;
    }
  }
  return true;
}

export function pickText(t: Text | undefined, lang: Lang, fallback = ''): string {
  if (!t) return fallback;
  // Japanese names are often development names in Western releases: only show them to Japanese players
  // or when nothing else exists in a pack that is Japanese-only
  if (t[lang]) return t[lang]!;
  if (t.en) return t.en;
  const other = Object.entries(t).find(([k, v]) => k !== 'ja' && v);
  if (other) return other[1]!;
  return lang === 'ja' ? t.ja ?? fallback : fallback;
}

/** Combine regional versions of the same game: same pack id → one pack with every language's names. */
export function mergePacks(a: Pack, b: Pack): Pack {
  const { assets: aa, ...aj } = a;
  const out: Pack = JSON.parse(JSON.stringify(aj));
  // keep the theme (and its music) of whichever version has one; the songs of both (a game read from its 3DS and
  // its Switch release has the music of both), and where songs are played as the player set it
  out.theme = mergeThemes(out.theme, b.theme);
  const assets = [...(aa ?? []), ...(b.assets ?? []).filter(x => !aa?.some(y => y.name === x.name))];
  if (assets.length) out.assets = assets;
  out.title = { ...b.title, ...a.title };
  const regions = new Set([a.source.region, b.source.region].flatMap(r => (r ?? '').split('/')).filter(Boolean));
  out.source.region = [...regions].join('/');
  // puzzles are matched by their pattern, not their id: regions number some puzzles differently and some
  // puzzles exist in one region only
  const all = out.levels.flatMap(l => l.puzzles);
  const byRows = new Map(all.map(p => [p.rows.join('/'), p]));
  // a puzzle both versions have keeps the id of the other version (b: the copy stored so far), so progress saved
  // under it stays (a game read again, another region or the Switch release of a 3DS game numbers it differently)
  const keep = new Map<PackPuzzle, string>();
  for (const l of b.levels) for (const p of l.puzzles) { const q = byRows.get(p.rows.join('/')); if (q && q.id !== p.id) keep.set(q, p.id); }
  if (keep.size) {
    const taken = new Set([...keep.values()]);
    for (const q of all) {
      if (keep.has(q)) q.id = keep.get(q)!;
      else if (taken.has(q.id)) { let n = 2; while (taken.has(`${q.id}~${n}`)) n++; q.id = `${q.id}~${n}`; }
      taken.add(q.id);
    }
  }
  const ids = new Set(all.map(p => p.id));
  const region = b.source.region || 'other';
  for (const l of b.levels) for (const p of l.puzzles) {
    const q = byRows.get(p.rows.join('/'));
    if (q) { q.name = { ...p.name, ...q.name }; continue; }
    // exclusive to the other version: into the level it has there, or a level of its own
    const x: PackPuzzle = JSON.parse(JSON.stringify(p));
    delete (x as any).anim; // animation data belongs to the other version's files
    x.exclusive = x.exclusive ?? region;
    let id = x.id;
    for (let n = 2; ids.has(id); n++) id = `${x.id}~${region.toLowerCase()}${n > 2 ? n : ''}`;
    x.id = id; ids.add(id); byRows.set(x.rows.join('/'), x);
    const mine = out.levels.find(v => v.id === l.id);
    if (mine) mine.puzzles.push(x);
    else {
      let lv = out.levels.find(v => v.id === l.id + '~' + region.toLowerCase());
      if (!lv) { lv = JSON.parse(JSON.stringify({ ...l, id: l.id + '~' + region.toLowerCase(), puzzles: [] })) as PackLevel; out.levels.push(lv); }
      lv.puzzles.push(x);
    }
  }
  return out;
}

function mergeThemes(a: PackTheme | undefined, b: PackTheme | undefined): PackTheme | undefined {
  if (!a || !b) return JSON.parse(JSON.stringify(a ?? b ?? null)) ?? undefined;
  const out: PackTheme = JSON.parse(JSON.stringify(a));
  const songs = [...new Set([...songsOf(a), ...songsOf(b)])];
  if (songs.length) out.songs = songs;
  if (!out.music && b.music) { out.music = { ...b.music }; out.tracks = b.tracks?.slice(); }
  const newer = (b.edited ?? 0) > (a.edited ?? 0) ? b : a;
  if (newer.edited) {
    out.edited = newer.edited;
    out.music = newer.music && { ...newer.music };
    out.tracks = newer.tracks?.slice();
    out.off = newer.off?.slice();
  }
  return out;
}

/** every song of a theme: its song list, then the songs it plays */
export function songsOf(th: PackTheme | undefined): string[] {
  if (!th) return [];
  const m = th.music ?? {};
  return [...new Set([...(th.songs ?? []), m.title, m.menu, ...(th.tracks ?? []), m.play, m.play2, m.clear].filter((r): r is string => !!r))];
}

/** for pack and level titles: any language is better than nothing */
export function pickAny(t: Text | undefined, lang: Lang): string {
  return pickText(t, lang) || (t ? Object.values(t).find(Boolean) ?? '' : '');
}
