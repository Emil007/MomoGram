// Reading and writing packs: the .momopack file (one zip with the pack and all its files) and the user's game
// files, from loose files or archives.
import { Pack, PackAsset, validatePack, pickAny, Lang } from './format';
import { importGameFile, importFileSet } from './importers/index';
import './importers/all';
import { storage } from '../store';
import { makeZip, unzipAll } from '../util/files';

/**
 * A .momopack is a zip:
 *   pack.json        the pack, with "rev": when this version of it was made (ms since 1970)
 *   assets/<name>    its music, pictures and other files
 * Packs without "rev" (older pack files, packs stored before revisions) count as revision 1.
 */
export const packRev = (p: Pack) => p.rev ?? 1;
export const momopackName = (p: Pack) => p.id.replace(/[^a-z0-9._-]+/gi, '_') + '.momopack';

/** a new revision: newer than every earlier one made on any device (and never 1, which means "old format") */
export const newRev = () => Date.now();

/** the stored pack with all its files, as one .momopack */
export async function momopackOf(p: Pack): Promise<Uint8Array> {
  const { assets: _, ...rest } = p;
  const entries: Array<{ name: string; text?: string; data?: Uint8Array }> = [{ name: 'pack.json', text: JSON.stringify(rest) }];
  for (const a of await storage.assetNames(p.id).catch(() => [] as string[])) {
    const data = await storage.loadAsset(p.id, a);
    if (data) entries.push({ name: 'assets/' + a, data });
  }
  return makeZip(entries);
}

export interface ReadResult { made: Pack[]; msgs: string[]; fromPackFiles: number }

/**
 * What's in a set of files (already taken out of an archive): MomoGram packs (pack.json + assets/), with their
 * files, and games. .momopack files inside are opened too (an "export all" zip holds one per pack).
 */
export async function readEntries(entries: Array<{ name: string; data: Uint8Array }>, lang: Lang, t: (k: string) => string): Promise<ReadResult> {
  const out: ReadResult = { made: [], msgs: [], fromPackFiles: 0 };
  const count = (p: Pack) => p.levels.reduce((a, l) => a + l.puzzles.length, 0);
  entries = entries.filter(e => !/\.(url|txt|nfo|jpg|png|md)$/i.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name));
  for (const e of entries.filter(e => /\.momopack$/i.test(e.name))) {
    let inner: Array<{ name: string; data: Uint8Array }>;
    try { inner = unzipAll(e.data); } catch { out.msgs.push(`✕ ${e.name}`); continue; }
    const r = await readEntries(inner, lang, t);
    out.made.push(...r.made); out.msgs.push(...r.msgs); out.fromPackFiles += r.fromPackFiles;
  }
  const used = new Set<string>();
  for (const e of entries) {
    if (!/(^|\/)pack\.json$/i.test(e.name)) continue;
    let p: any;
    try { p = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
    if (!validatePack(p)) continue;
    used.add(e.name);
    const base = e.name.replace(/[^/]*$/, '');
    const dir = base + 'assets/';
    const assets: PackAsset[] = entries.filter(x => x.name.startsWith(dir)).map(x => { used.add(x.name); return { name: x.name.slice(dir.length), data: x.data }; });
    if (assets.length) p.assets = assets;
    out.made.push(p); out.fromPackFiles++;
    out.msgs.push(`✓ ${pickAny(p.title, lang)} (${count(p)})`);
  }
  // games that are folders (Switch): handed over as a whole
  const byName = new Map(entries.map(e => [e.name, e]));
  const sets = await importFileSet({ names: entries.map(e => e.name), get: async n => byName.get(n)?.data });
  for (const r of sets.results) {
    if (r.ok) {
      const rev = newRev();
      for (const p of r.packs) { p.source.file = r.file; p.rev = rev; out.made.push(p); }
      out.msgs.push(`✓ ${r.packs.map(p => `${pickAny(p.title, lang)} (${count(p)})`).join(', ')}`);
    } else out.msgs.push(`✕ ${r.file}: ${r.message === 'unsupported' ? t('unsupported') : r.message}`);
  }
  for (const e of entries) if (sets.used(e.name)) used.add(e.name);
  // everything else is read as a game
  for (const e of entries) {
    if (used.has(e.name) || /\.(json|momopack)$/i.test(e.name)) continue;
    const r = await importGameFile(e.name, e.data);
    if (r.ok) {
      // read from the game just now: a new revision of this pack
      const rev = newRev();
      for (const p of r.packs) { p.source.file = e.name; p.rev = rev; out.made.push(p); }
      out.msgs.push(`✓ ${r.packs.map(p => `${pickAny(p.title, lang)} (${count(p)})`).join(', ')}`);
    } else {
      out.msgs.push(`✕ ${e.name}: ${r.message === 'encrypted' ? t('encrypted') : r.message === 'unsupported' ? t('unsupported') : r.message}`);
    }
  }
  return out;
}
