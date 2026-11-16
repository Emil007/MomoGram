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
  const list: any[] = await arc.getFilesArray();
  const out: Array<{ name: string; data: Uint8Array }> = [];
  for (const e of list) {
    const f: File = await e.file.extract();
    out.push({ name: (e.path ?? '') + f.name, data: new Uint8Array(await f.arrayBuffer()) });
  }
  await arc.close?.();
  return out;
}
export const isArchive = (n: string) => /\.(zip|7z|rar)$/i.test(n);
