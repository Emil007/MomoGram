// Android games: what every android-*.ts importer shares. A game comes as an .apk or in a wrapper (.xapk, .apkm,
// .apks; see rom/apk.ts): whichever the player has, the package inside decides. A game names its package and the
// versions its reader was written for; another version is read only when the player wants to try it. The pack's
// icon comes from the package (the launcher icon), its accent colour from the icon, unless the game gives its own.
import { registerImporter, importAsk, ImportCancelled } from './index';
import { Pack, PackLevel, PackPuzzle, PackIcon, Text } from '../format';
import { Apk, openApk, apkIcon, apkLabel } from '../../rom/apk';

export interface AndroidGame {
  name: string;
  version?: number;
  /** the package name (applicationId) */
  pkg: string;
  /** the versionNames the reader was written for */
  versions: string[];
  read(apk: Apk): Pack[] | Promise<Pack[]>;
}

const isZip = (d: Uint8Array) => d.length > 30 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 3 && d[3] === 4;

export function registerAndroidGame(g: AndroidGame) {
  registerImporter({
    name: g.name,
    version: g.version,
    detect: d => isZip(d) && openApk(d)?.pkg === g.pkg,
    async read(d) {
      const apk = openApk(d)!;
      if (!g.versions.includes(apk.versionName) &&
        !(await importAsk({ kind: 'version', game: g.name, have: apk.versionName || '?', want: g.versions.join(', ') }))) throw new ImportCancelled();
      const packs = await g.read(apk);
      const icon = await apkIcon(apk), label = apkLabel(apk);
      for (const p of packs) {
        p.source.platform = 'Android';
        if (!Object.keys(p.title).length) p.title = label;
        if (icon && !p.icon) p.icon = icon;
        // the game's look: what the importer set, filled in from the launcher icon where a colour is missing
        if (icon) p.theme = { ...p.theme, palette: { style: 'default', ...paletteOf(icon), ...p.theme?.palette } };
      }
      return packs;
    },
  });
}

/** average of opaque pixels that pass a test, as #rrggbb */
function avg(icon: PackIcon, keep: (r: number, g: number, b: number) => boolean, fallback: string): string {
  const px = Uint8Array.from(atob(icon.rgba), c => c.charCodeAt(0));
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 200 || !keep(px[i], px[i + 1], px[i + 2])) continue;
    n++; r += px[i]; g += px[i + 1]; b += px[i + 2];
  }
  if (!n) return fallback;
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

/** board colours taken from the launcher icon: a strong accent, a dark fill, a light background */
export function paletteOf(icon: PackIcon): NonNullable<NonNullable<Pack['theme']>['palette']> {
  const accent = avg(icon, (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx - mn >= 40 && mx >= 80; }, '#404040');
  const fill = avg(icon, (r, g, b) => Math.max(r, g, b) < 90, '#2a2a2a');
  const bg = avg(icon, (r, g, b) => Math.min(r, g, b) > 180, '#f4f0e8');
  return { accent, fill, bg, cursor: accent, grid: accent };
}

/** the icon's most common strong colour (by hue); kept for callers that only need one accent */
export function accentOf(icon: PackIcon): string { return paletteOf(icon).accent!; }

/**
 * Levels of at most `per` puzzles: a long list (thousands of puzzles in one mode) split into numbered levels,
 * "1–100", "101–200", … — the puzzle screen shows every level of a group as a tab, so a group should not hold too
 * many of them either: every `perGroup` levels start a new group.
 */
export function numberedLevels(puzzles: PackPuzzle[], o: {
  id: string; per?: number; perGroup?: number; group: string; groupTitle: Text; title?: (from: number, to: number) => Text;
}): PackLevel[] {
  const per = o.per ?? 100, perGroup = o.perGroup ?? 20, levels: PackLevel[] = [];
  const range = (a: number, b: number) => `${a}–${b}`;
  const groups = Math.ceil(puzzles.length / (per * perGroup));
  for (let i = 0, k = 0; i < puzzles.length; i += per, k++) {
    const g = Math.floor(k / perGroup), from = i + 1, to = Math.min(i + per, puzzles.length);
    const gFrom = g * per * perGroup + 1, gTo = Math.min((g + 1) * per * perGroup, puzzles.length);
    const gt: Text = groups < 2 ? o.groupTitle : Object.fromEntries(Object.entries(o.groupTitle).map(([l, s]) => [l, `${s} ${range(gFrom, gTo)}`]));
    levels.push({
      id: `${o.id}-${from}`, title: o.title?.(from, to) ?? { en: range(from, to) },
      group: groups < 2 ? o.group : `${o.group}-${g + 1}`, groupTitle: gt,
      rules: 'normal', puzzles: puzzles.slice(i, i + per),
    });
  }
  return levels;
}

/**
 * The game's music as the pack's songs (the files as they are: MP3 or Ogg). Roles name files by their asset name;
 * `play` are the in-game tracks (the first is the main one); a missing file is left out.
 */
export function addMusic(p: Pack, files: Array<{ name: string; data: Uint8Array | undefined | null }>, roles: { title?: string; menu?: string; play?: string[]; clear?: string }) {
  const have = files.filter((f): f is { name: string; data: Uint8Array } => !!f.data && f.data.length > 0);
  if (!have.length) return;
  const ok = (n?: string) => (n && have.some(f => f.name === n) ? n : undefined);
  const play = (roles.play ?? []).filter(n => ok(n));
  const music: NonNullable<NonNullable<Pack['theme']>['music']> = {};
  if (ok(roles.title)) music.title = roles.title;
  if (ok(roles.menu)) music.menu = roles.menu;
  if (play[0]) music.play = play[0];
  if (play[1]) music.play2 = play[1];
  if (ok(roles.clear)) music.clear = roles.clear;
  p.assets = [...(p.assets ?? []), ...have];
  p.theme = { ...p.theme, music, songs: have.map(f => f.name), ...(play.length ? { tracks: play } : {}) };
}

/** a picture with at least one filled and one empty cell (anything else is no puzzle) */
export const isPuzzle = (rows: string[]) => rows.some(r => r.includes('#')) && rows.some(r => r.includes('.'));
