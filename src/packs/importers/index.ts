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
