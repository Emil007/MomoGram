// File helpers: zip in/out (fflate), downloads, hashing.
import { unzipSync, zipSync, strToU8 } from 'fflate';

export async function unzipFirst(data: Uint8Array, name: RegExp): Promise<Uint8Array | null> {
  const files = unzipSync(data, { filter: f => name.test(f.name) });
  const k = Object.keys(files)[0];
  return k ? files[k] : null;
}

export function unzipAll(data: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d }));
}

export function makeZip(entries: Array<{ name: string; text?: string; data?: Uint8Array }>): Uint8Array {
  const o: Record<string, Uint8Array> = {};
  for (const e of entries) o[e.name] = e.data ?? strToU8(e.text ?? '');
  return zipSync(o, { level: 6 });
}

export function download(name: string, data: Uint8Array | string, type = 'application/octet-stream') {
  const blob = new Blob([typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function sha1(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-1', data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- stored-asset compression: "MGZ1" + raw deflate, only where it actually saves space ----
import { deflate, inflateSync } from 'fflate';

const MGZ = [0x4d, 0x47, 0x5a, 0x31];
export function isCompressedAsset(d: Uint8Array): boolean { return d.length > 4 && MGZ.every((b, i) => d[i] === b); }

/** compress off the main thread (fflate worker); keeps the original when compression saves < 10 % */
export function compressAsset(d: Uint8Array): Promise<Uint8Array> {
  if (isCompressedAsset(d)) return Promise.resolve(d);
  return new Promise(res => {
    deflate(d, { level: 9, mem: 8 }, (err, z) => {
      if (err || z.length > d.length * 0.9) return res(d);
      const out = new Uint8Array(4 + z.length);
      out.set(MGZ); out.set(z, 4);
      res(out);
    });
  });
}
export function decompressAsset(d: Uint8Array): Uint8Array {
  return isCompressedAsset(d) ? inflateSync(d.subarray(4)) : d;
}
