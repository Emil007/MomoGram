// .zip / .7z / .rar reading in the browser via libarchive.js (WebAssembly, runs in a worker).
import { Archive } from 'libarchive.js';
import { unzipAll } from './files';

let inited = false;
export async function extractAll(file: File): Promise<Array<{ name: string; data: Uint8Array }>> {
  if (/\.zip$/i.test(file.name)) {
    try { return unzipAll(new Uint8Array(await file.arrayBuffer())); } catch { /* fall back to libarchive */ }
  }
  if (!inited) { Archive.init({ workerUrl: 'worker-bundle.js' }); inited = true; }
  const arc = await Archive.open(file);
  // extract everything in one pass: solid 7z archives (several games compressed together) can't be read
  // entry by entry ("Truncated 7-Zip file body")
  const tree: any = await arc.extractFiles();
  const out: Array<{ name: string; data: Uint8Array }> = [];
  const walk = async (o: any, path: string) => {
    for (const [k, v] of Object.entries<any>(o)) {
      if (v && typeof v.arrayBuffer === 'function') out.push({ name: path + k, data: new Uint8Array(await v.arrayBuffer()) });
      else if (v && typeof v === 'object') await walk(v, path + k + '/');
    }
  };
  await walk(tree, '');
  await arc.close?.();
  return out;
}
export const isArchive = (n: string) => /\.(zip|7z|rar)$/i.test(n);
