// MomoGram pack format. A pack is plain JSON (pack.json), optionally zipped together with
// other packs. Packs are generated locally by the user from games they own; none ship with MomoGram.

export type Lang = 'en' | 'de' | 'fr' | 'it' | 'es' | 'ja' | 'ko';
export type Text = Partial<Record<Lang, string>>;
export type Rules = 'normal' | 'free';

/**
 * A solved-picture animation in the 4bpp sprite format of the DS (see rom/dsgfx.ts): the files of the pack's
 * animation asset (`Pack.anims`) with its 16-colour palette and tiles, and the script of sprite cells per frame.
 */
export interface AnimRef {
  palette: number;
  tiles: number;
  /** list of [sprite cells (attr0, attr1, attr2)[], frames] */
  script: Array<{ cells: Array<[number, number, number]>; frames: number }>;
  loopTo: number;
}

export interface PackPuzzle {
  /** an animated solved picture (in the files of `Pack.anims`) */
  anim?: AnimRef;
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
  /** Mega version from the game: which lines are paired (the first line of each pair); see game/mega.ts */
  mega?: { rows: number[]; cols: number[] };
  /** a puzzle the game has only as a Mega puzzle: shown in Mega mode only */
  megaOnly?: boolean;
  /** the colour picture is the game's own colour puzzle (played in Colour mode as it is) */
  colorGame?: boolean;
  /** a puzzle the game has only as a colour puzzle: shown in Colour mode only */
  colorOnly?: boolean;
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
    /** the board's design: dmg / gbc (Game Boy), switch / 3ds (the Switch / 3DS games' designs), stone, notebook, ds, logic (see theme.ts), default (MomoGram's look in the game's colours) */
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
  /** several songs for a role (the first is also in `music`, for older versions of MomoGram) */
  roles?: Partial<Record<'title' | 'menu' | 'clear', string[]>>;
  /** when the player last changed where songs are played (sound test): such a pack keeps its tags on a new import */
  edited?: number;
}

/** small picture of the game: width × height RGBA pixels, base64 */
/**
 * A colour from a pack, safe to put into a style attribute: packs come from files and from other players on a
 * server, so anything that isn't a plain colour (hex, rgb()/hsl() with numbers, a colour name) becomes `fallback`.
 */
export function safeColor(c: unknown, fallback = '#202020'): string {
  return typeof c === 'string' && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9.,%\s/]+\)|[a-z]{3,20})$/i.test(c.trim()) ? c.trim() : fallback;
}

export interface PackIcon { w: number; h: number; rgba: string }

export function makeIcon(w: number, h: number, px: Uint8Array): PackIcon {
  let bin = '';
  for (let i = 0; i < px.length; i++) bin += String.fromCharCode(px[i]);
  return { w, h, rgba: btoa(bin) };
}

/** Binary file belonging to a pack (music), kept in IndexedDB and written next to the pack in zip exports. */
export interface PackAsset { name: string; data: Uint8Array }

export interface ScanStamp { by: string; v: number; file: string; size: number }
/** the files a pack was read from (older packs only remember the last one) */
export function scansOf(p: Pack): ScanStamp[] { return p.source.scans ?? (p.source.scan ? [p.source.scan] : []); }
/** both lists of files, one entry per file (the newer importer version wins) */
export function joinScans(a: ScanStamp[], b: ScanStamp[]): ScanStamp[] {
  const m = new Map<string, ScanStamp>();
  for (const s of [...a, ...b]) { const k = s.file + '|' + s.size, o = m.get(k); if (!o || s.v >= o.v) m.set(k, s); }
  return [...m.values()];
}

export interface Pack {
  format: 'momogram-pack';
  version: 1;
  id: string;
  title: Text;
  /** where the puzzles came from, shown in the pack manager */
  source: {
    game: string; platform: string; region?: string; developer?: string; year?: number; file?: string; sha1?: string;
    /** older packs: the last import only (see scans) */
    scan?: ScanStamp;
    /** every file this pack was read from (a game can come from several: regions, revisions, copies in an archive):
     * importer, its version, the file (name and size), so reading one of them again can be skipped */
    scans?: ScanStamp[];
  };
  levels: PackLevel[];
  createdBy?: string;
  theme?: PackTheme;
  /** solved-picture animations: one asset holding many small files, split at these offsets (`PackPuzzle.anim`) */
  anims?: { asset: string; offsets: number[] };
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

/** the order in which languages are tried for a puzzle's or game's own texts (set by the interface language) */
let textOrder: string[] = ['en', 'ja'];
export function setTextOrder(order: string[]) { textOrder = order; }
export function pickText(t: Text | undefined, lang: Lang, fallback = ''): string {
  if (!t) return fallback;
  // the interface language first, then the language file's order (e.g. English, then Japanese), then anything
  for (const l of [lang, ...textOrder]) if ((t as any)[l]) return (t as any)[l];
  return Object.values(t).find(Boolean) ?? fallback;
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
  const platforms = new Set([a.source.platform, b.source.platform].flatMap(r => (r ?? '').split(/\s*\/\s*/)).filter(Boolean));
  if (platforms.size) out.source.platform = [...platforms].join(' / ');
  // remember every file both were read from, so none of them is read again needlessly
  const scans = joinScans(scansOf(a), scansOf(b));
  delete out.source.scan;
  if (scans.length) out.source.scans = scans;
  // puzzles are matched by their pattern, not their id: regions number some puzzles differently and some
  // puzzles exist in one region only
  const all = out.levels.flatMap(l => l.puzzles);
  // a game can have the same picture twice (in two levels): such puzzles are matched by id first, then in order
  const byRows = new Map<string, PackPuzzle[]>();
  for (const p of all) byRows.set(p.rows.join('/'), [...(byRows.get(p.rows.join('/')) ?? []), p]);
  const matched = new Map<PackPuzzle, PackPuzzle>(); // b's puzzle → out's
  const used = new Set<PackPuzzle>();
  const bAll = b.levels.flatMap(l => l.puzzles);
  for (const pass of [0, 1]) for (const p of bAll) {
    if (matched.has(p)) continue;
    const c = (byRows.get(p.rows.join('/')) ?? []).filter(q => !used.has(q));
    const q = pass === 0 ? c.find(q => q.id === p.id) : c[0];
    if (q) { matched.set(p, q); used.add(q); }
  }
  // a puzzle both versions have keeps the id of the other version (b: the copy stored so far), so progress saved
  // under it stays (a game read again, another region or the Switch release of a 3DS game numbers it differently)
  const keep = new Map<PackPuzzle, string>();
  for (const [p, q] of matched) if (q.id !== p.id) keep.set(q, p.id);
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
    const q = matched.get(p);
    // the Mega version of a puzzle may come from the other release (PICROSS S+ has one for every e game)
    if (q) { const n = { ...p.name, ...q.name }; if (Object.keys(n).length) q.name = n; else delete q.name; if (!q.mega && p.mega) q.mega = p.mega; if (p.color && (!q.color || (p.colorGame && !q.colorGame))) { q.color = p.color; if (p.colorGame) q.colorGame = true; } continue; }
    // exclusive to the other version: into the level it has there, or a level of its own
    const x: PackPuzzle = JSON.parse(JSON.stringify(p));
    delete (x as any).anim; // animation data belongs to the other version's files
    // Mega-only puzzles stored before Mega was read are new, not exclusive to a region
    if (!x.megaOnly && !x.colorOnly) x.exclusive = x.exclusive ?? region;
    let id = x.id;
    for (let n = 2; ids.has(id); n++) id = `${x.id}~${region.toLowerCase()}${n > 2 ? n : ''}`;
    x.id = id; ids.add(id);
    const mine = out.levels.find(v => v.id === l.id);
    if (mine) mine.puzzles.push(x);
    else {
      const lid = x.megaOnly || x.colorOnly ? l.id : l.id + "~" + region.toLowerCase();
      let lv = out.levels.find(v => v.id === lid);
      if (!lv) { lv = JSON.parse(JSON.stringify({ ...l, id: lid, puzzles: [] })) as PackLevel; out.levels.push(lv); }
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
    out.roles = newer.roles && JSON.parse(JSON.stringify(newer.roles));
  }
  return out;
}

/** every song of a theme: its song list, then the songs it plays */
export function songsOf(th: PackTheme | undefined): string[] {
  if (!th) return [];
  const m = th.music ?? {}, r = th.roles ?? {};
  return [...new Set([...(th.songs ?? []), m.title, m.menu, ...(r.title ?? []), ...(r.menu ?? []), ...(th.tracks ?? []), m.play, m.play2, m.clear, ...(r.clear ?? [])].filter((x): x is string => !!x))];
}

export type SongRole = 'title' | 'menu' | 'play' | 'clear';
/** the songs a game plays in a role (puzzle music: the playlist) */
export function roleSongs(th: PackTheme | undefined, role: SongRole): string[] {
  if (!th) return [];
  const m = th.music ?? {};
  if (role === 'play') return th.tracks?.length ? th.tracks : [...new Set([m.play, m.play2].filter((x): x is string => !!x))];
  return th.roles?.[role]?.length ? th.roles[role]! : m[role] ? [m[role]!] : [];
}
/** set the songs of a role (keeps `music` filled for older versions) */
export function setRoleSongs(th: PackTheme, role: SongRole, list: string[]) {
  const m = th.music = { ...(th.music ?? {}) };
  if (role === 'play') { th.tracks = list; m.play = list[0]; delete m.play2; if (!m.play) delete m.play; return; }
  th.roles = { ...(th.roles ?? {}), [role]: list };
  if (!list.length) delete th.roles[role];
  if (list[0]) m[role] = list[0]; else delete m[role];
  if (!Object.keys(th.roles).length) delete th.roles;
}

/** for pack and level titles: any language is better than nothing */
export function pickAny(t: Text | undefined, lang: Lang): string {
  return pickText(t, lang) || (t ? Object.values(t).find(Boolean) ?? '' : '');
}
