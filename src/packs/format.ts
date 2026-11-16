// MomoGram pack format. A pack is plain JSON (pack.json), optionally zipped together with
// other packs. Packs are generated locally by the user from games they own; none ship with MomoGram.

export type Lang = 'en' | 'de' | 'fr' | 'it' | 'es' | 'ja' | 'ko';
export type Text = Partial<Record<Lang, string>>;
export type Rules = 'normal' | 'free';

export interface PackPuzzle {
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
  palette?: { accent: string; fill?: string; bg?: string; cell?: string; grid?: string; clue?: string; style?: 'dmg' | 'default' };
  /** asset names per role; an SDAT asset also names the sequence ("sound.sdat#SEQ_NAME") */
  music?: Partial<Record<'menu' | 'play' | 'play2' | 'clear' | 'title', string>>;
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
  /** only while importing: assets the importer extracted (stored separately, stripped before saving) */
  assets?: PackAsset[];
}

export function assetDir(p: Pack): string { return packFileName(p).replace(/\.momopack\.json$/, '') + '.assets/'; }

export function packFileName(p: Pack): string {
  return p.id.replace(/[^a-z0-9._-]+/gi, '_') + '.momopack.json';
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
  // keep the theme (and its music) of whichever version has one
  if (!out.theme && b.theme) out.theme = JSON.parse(JSON.stringify(b.theme));
  const assets = aa?.length ? aa : b.assets;
  if (assets?.length) out.assets = assets;
  out.title = { ...b.title, ...a.title };
  const regions = new Set([a.source.region, b.source.region].flatMap(r => (r ?? '').split('/')).filter(Boolean));
  out.source.region = [...regions].join('/');
  const byId = new Map(out.levels.flatMap(l => l.puzzles).map(p => [p.id, p]));
  for (const l of b.levels) for (const p of l.puzzles) {
    const q = byId.get(p.id);
    if (q && q.rows.join() === p.rows.join()) q.name = { ...p.name, ...q.name };
  }
  // puzzles only the second file has (e.g. another Satellaview broadcast): add them, by level id
  for (const l of b.levels) {
    const extra = l.puzzles.filter(p => !byId.has(p.id));
    if (!extra.length) continue;
    const mine = out.levels.find(x => x.id === l.id);
    if (mine) mine.puzzles = [...mine.puzzles, ...JSON.parse(JSON.stringify(extra))].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    else out.levels.push(JSON.parse(JSON.stringify({ ...l, puzzles: extra })));
  }
  return out;
}

/** for pack and level titles: any language is better than nothing */
export function pickAny(t: Text | undefined, lang: Lang): string {
  return pickText(t, lang) || (t ? Object.values(t).find(Boolean) ?? '' : '');
}
