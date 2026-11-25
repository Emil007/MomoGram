// Pack creation: identify a game file the user owns and read its puzzles into a MomoGram pack.
// Every other file in this folder is one import method and registers itself; all.ts (written by build.mjs)
// loads them. To support a new game, add its details to the file of the method it uses, or add a new file.
import { Pack, scansOf } from '../format';

export interface ImportResult { file: string; ok: boolean; packs: Pack[]; message: string }

export interface Importer {
  name: string;
  /** raised whenever the importer reads more or differently: packs made by an older version can be updated */
  version?: number;
  /** cheap check on the bytes */
  detect(data: Uint8Array, fileName: string): boolean;
  read(data: Uint8Array, fileName: string): Pack[] | Promise<Pack[]>;
  /** brings a pack stored by an older MomoGram up to date (without the game file); true when it changed it */
  upgrade?(pack: Pack): boolean;
}

const importers: Importer[] = [];
export function registerImporter(i: Importer) { importers.push(i); }

/** a question an importer asks the player while reading (the file is another version of the game than it knows) */
export interface ImportQuestion { kind: 'version'; game: string; have: string; want: string }
let ask: (q: ImportQuestion) => Promise<boolean> = async () => true;
/** how the app asks (without one, every question is answered yes: the command-line tools) */
export function setImportAsk(fn: (q: ImportQuestion) => Promise<boolean>) { ask = fn; }
/** asks the player; an importer that gets "no" throws ImportCancelled */
export function importAsk(q: ImportQuestion): Promise<boolean> { return ask(q); }
export class ImportCancelled extends Error { constructor() { super('cancelled'); } }
/** every importer's upgrade for a stored pack (see Importer.upgrade); true when the pack changed */
export function upgradeStoredPack(p: Pack): boolean {
  let changed = false;
  for (const i of importers) if (i.upgrade?.(p)) changed = true;
  return changed;
}

/** the files of a game that is a folder rather than one file (Switch RomFS), from a picked folder or an archive */
export interface GameFiles {
  /** paths relative to what the player picked, with "/" */
  names: string[];
  get(name: string): Promise<Uint8Array | undefined>;
  /** byte length when the caller already knows it, so a folder reimport can see a replaced file */
  size?(name: string): number | undefined;
}
export interface SetImporter {
  name: string;
  version?: number;
  /** the games among the paths: a root folder each (every file under it is the game's) */
  find(names: string[]): string[];
  read(files: GameFiles, root: string): Promise<Pack[]>;
}
const setImporters: SetImporter[] = [];
export function registerSetImporter(i: SetImporter) { setImporters.push(i); }

/** the current version of an importer (by name) */
export function importerVersion(name: string): number { return ([...importers, ...setImporters].find(i => i.name === name)?.version ?? 1); }

/** which importer (and version) read a pack, from which file: lets a later import of the same file be skipped */
function stamp(packs: Pack[], imp: { name: string; version?: number }, file: string, size: number) {
  const id = file.replace(/\\/g, '/');
  for (const p of packs) { delete p.source.scan; p.source.scans = [{ by: imp.name, v: imp.version ?? 1, file: id, size }]; }
}

/** a file read before by the same version of its importer: nothing new can come out of it.
 *  A newer stamp is not final — the importer in this build is what gets to read the file. */
export function alreadyRead(packs: Pack[], file: string, size: number): Pack | null {
  const id = file.replace(/\\/g, '/').replace(/\/$/, '');
  const base = id.split('/').pop() ?? id;
  return packs.find(p => scansOf(p).some(s => (s.file === id || s.file === base) && s.size === size && s.v === importerVersion(s.by))) ?? null;
}

/** '' / '.' is a game sitting at the top of the pick, not a prefix of every path in the folder */
const blankRoot = (r: string) => r === '' || r === '.' || r === '/';
function topLevelGame(path: string): boolean {
  return path === 'resources.assets' || path === 'puzzledata' || path === 'puzzledata.unity3d'
    || path.startsWith('StreamingAssets/') || path.startsWith('Data/');
}
function underRoot(root: string, path: string): boolean {
  if (blankRoot(root)) return topLevelGame(path);
  return path.startsWith(root);
}

/** identity of a folder import: the full root, plus a hash of each file's path and byte length.
 *  Null when lengths are unknown — a same file-count patch must be read again, not skipped. */
function folderStamp(root: string, files: GameFiles, impName: string): { file: string; size: number } | null {
  if (!files.size) return null;
  const mine = files.names.filter(n => underRoot(root, n)).sort();
  let h = 2166136261;
  for (const n of mine) {
    const sz = files.size(n);
    if (sz == null || !Number.isFinite(sz) || sz < 0) return null;
    const token = n + '\0' + sz;
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  }
  return { file: root.replace(/\/$/, '') || impName, size: (h >>> 0) || 1 };
}

/** read the folder games among the files; returns the results and which files they took */
export async function importFileSet(files: GameFiles, each?: (r: ImportResult) => Promise<void>, known: Pack[] = []): Promise<{ results: ImportResult[]; used: (name: string) => boolean }> {
  const results: ImportResult[] = [], roots: string[] = [];
  // with `each`, every game is handed over as soon as it is read (and its packs are dropped from the result), so a
  // folder with many games never holds all of them in memory
  const push = async (r: ImportResult) => { if (each) { await each(r); r = { ...r, packs: [] }; } results.push(r); };
  for (const imp of setImporters) {
    for (const root of imp.find(files.names)) {
      // a blank root must not hide every later game, and must not be treated as already covered by "" 
      if (!blankRoot(root) && roots.some(r => !blankRoot(r) && root.startsWith(r))) continue;
      roots.push(root);
      const label = root.replace(/\/$/, '') || imp.name;
      const token = folderStamp(root, files, imp.name);
      if (token && known.some(p => scansOf(p).some(s => s.file === token.file && s.size === token.size && s.v === importerVersion(s.by)))) {
        await push({ file: label, ok: false, packs: [], message: 'uptodate' }); continue;
      }
      try {
        const packs = await imp.read(files, root);
        stamp(packs, imp, token?.file ?? label, token?.size ?? 0);
        await push({ file: label, ok: packs.length > 0, packs, message: packs.length ? imp.name : 'unsupported' });
      } catch (e: any) {
        await push({ file: label, ok: false, packs: [], message: `${imp.name}: ${e.message || e}` });
      }
    }
  }
  return { results, used: n => roots.some(r => underRoot(r, n)) };
}

export function is3dsEncrypted(d: Uint8Array): boolean | null {
  // look for an NCCH header and test the NoCrypto flag
  for (let i = 0; i < Math.min(d.length - 0x200, 0x40000); i += 0x40) {
    if (d[i + 0x100] === 0x4e && d[i + 0x101] === 0x43 && d[i + 0x102] === 0x43 && d[i + 0x103] === 0x48) {
      return (d[i + 0x18f] & 4) === 0;
    }
  }
  return null;
}

export async function importGameFile(name: string, data: Uint8Array): Promise<ImportResult> {
  for (const imp of importers) {
    let ok = false;
    try { ok = imp.detect(data, name); } catch { ok = false; }
    if (!ok) continue;
    try {
      const packs = await imp.read(data, name);
      stamp(packs, imp, name, data.length);
      if (packs.length) return { file: name, ok: true, packs, message: imp.name };
    } catch (e: any) {
      if (e instanceof ImportCancelled) return { file: name, ok: false, packs: [], message: 'cancelled' };
      return { file: name, ok: false, packs: [], message: `${imp.name}: ${e.message || e}` };
    }
  }
  if (/\.(cia|3ds|cci|cxi)$/i.test(name) && is3dsEncrypted(data)) return { file: name, ok: false, packs: [], message: 'encrypted' };
  return { file: name, ok: false, packs: [], message: 'unsupported' };
}
