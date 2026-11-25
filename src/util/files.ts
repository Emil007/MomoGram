// File helpers: zip in/out (fflate), downloads, hashing.
import { unzipSync, zipSync, strToU8 } from 'fflate';

/**
 * Zip safety for local import / .momopack. One member at a time:
 * skip path traversal, and skip a single absurd member (over 2 GiB).
 * No total-size or file-count cap: a zip of every game must still open.
 */
const UNZIP_MAX_ONE = 2 * 1024 * 1024 * 1024;

function unzipMemberOk(f: { name: string; originalSize: number }): boolean {
  if (f.name.endsWith('/')) return false;
  if (f.name.includes('..') || f.name.startsWith('/') || f.name.includes('\\') || /^[a-zA-Z]:/.test(f.name)) return false;
  // Compare the real size. `>>> 0` would wrap a 4 GiB+ bomb back under 2 GiB.
  if (!Number.isFinite(f.originalSize) || f.originalSize < 0 || f.originalSize > UNZIP_MAX_ONE) return false;
  return true;
}

export async function unzipFirst(data: Uint8Array, name: RegExp): Promise<Uint8Array | null> {
  const files = unzipSync(data, { filter: f => unzipMemberOk(f) && name.test(f.name) });
  const k = Object.keys(files)[0];
  return k ? files[k] : null;
}

export function unzipAll(data: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const files = unzipSync(data, { filter: unzipMemberOk });
  return Object.entries(files).map(([name, d]) => ({ name, data: d }));
}

/** zip entry name with `..` and absolute bits removed, so an export cannot leave the archive */
function zipMemberName(name: string): string | null {
  if (name.includes('\0')) return null;
  const out: string[] = [];
  for (const p of name.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.' || p === '..') { if (p === '..') out.pop(); continue; }
    out.push(p);
  }
  return out.length ? out.join('/') : null;
}

/** files that are compressed already (deflating them again only costs time): stored as they are */
const PACKED = /\.(ogg|opus|mp3|m4a|png|jpe?g|webp|gif|zip|7z|rar|gz|momopack|spcsnap)$/i;

export function makeZip(entries: Array<{ name: string; text?: string; data?: Uint8Array }>): Uint8Array {
  const o: Record<string, [Uint8Array, { level: 0 | 6 | 9 }]> = {};
  for (const e of entries) {
    const name = zipMemberName(e.name);
    if (!name) continue;
    const d = e.data ?? strToU8(e.text ?? '');
    // text and small files: the best compression; big binaries (DS sound data, ADPCM streams): a faster level
    o[name] = [d, { level: PACKED.test(name) ? 0 : d.length < 1 << 20 ? 9 : 6 }];
  }
  return zipSync(o);
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

// ---- save files (.momosave): gzip-compressed JSON ----
import { gzipSync, gunzipSync, strFromU8 } from 'fflate';
export function packSave(obj: unknown): Uint8Array { return gzipSync(strToU8(JSON.stringify(obj)), { level: 9 }); }
export function unpackSave(d: Uint8Array): any {
  const raw = d[0] === 0x1f && d[1] === 0x8b ? gunzipSync(d) : d; // also accepts plain JSON
  return JSON.parse(strFromU8(raw));
}
