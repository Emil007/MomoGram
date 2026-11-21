// Pack creation: identify a game file the user owns and read its puzzles into a MomoGram pack.
// Every other file in this folder is one import method and registers itself; all.ts (written by build.mjs)
// loads them. To support a new game, add its details to the file of the method it uses, or add a new file.
import { Pack } from '../format';

export interface ImportResult { file: string; ok: boolean; packs: Pack[]; message: string }

export interface Importer {
  name: string;
  /** cheap check on the bytes */
  detect(data: Uint8Array, fileName: string): boolean;
  read(data: Uint8Array, fileName: string): Pack[] | Promise<Pack[]>;
}

const importers: Importer[] = [];
export function registerImporter(i: Importer) { importers.push(i); }

/** the files of a game that is a folder rather than one file (Switch RomFS), from a picked folder or an archive */
export interface GameFiles {
  /** paths relative to what the player picked, with "/" */
  names: string[];
  get(name: string): Promise<Uint8Array | undefined>;
}
export interface SetImporter {
  name: string;
  /** the games among the paths: a root folder each (every file under it is the game's) */
  find(names: string[]): string[];
  read(files: GameFiles, root: string): Promise<Pack[]>;
}
const setImporters: SetImporter[] = [];
export function registerSetImporter(i: SetImporter) { setImporters.push(i); }

/** read the folder games among the files; returns the results and which files they took */
export async function importFileSet(files: GameFiles, each?: (r: ImportResult) => Promise<void>): Promise<{ results: ImportResult[]; used: (name: string) => boolean }> {
  const results: ImportResult[] = [], roots: string[] = [];
  // with `each`, every game is handed over as soon as it is read (and its packs are dropped from the result), so a
  // folder with many games never holds all of them in memory
  const push = async (r: ImportResult) => { if (each) { await each(r); r = { ...r, packs: [] }; } results.push(r); };
  for (const imp of setImporters) {
    for (const root of imp.find(files.names)) {
      if (roots.some(r => root.startsWith(r))) continue;
      roots.push(root);
      try {
        const packs = await imp.read(files, root);
        await push({ file: root.replace(/\/$/, '') || imp.name, ok: packs.length > 0, packs, message: packs.length ? imp.name : 'unsupported' });
      } catch (e: any) {
        await push({ file: root.replace(/\/$/, '') || imp.name, ok: false, packs: [], message: `${imp.name}: ${e.message || e}` });
      }
    }
  }
  return { results, used: n => roots.some(r => n.startsWith(r)) };
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
      if (packs.length) return { file: name, ok: true, packs, message: imp.name };
    } catch (e: any) {
      return { file: name, ok: false, packs: [], message: `${imp.name}: ${e.message || e}` };
    }
  }
  if (/\.(cia|3ds|cci|cxi)$/i.test(name) && is3dsEncrypted(data)) return { file: name, ok: false, packs: [], message: 'encrypted' };
  return { file: name, ok: false, packs: [], message: 'unsupported' };
}
