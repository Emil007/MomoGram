// Zip files read lazily: only the central directory is parsed, an entry is unpacked when it is asked for. Android
// packages (.apk, and the .xapk / .apkm / .apks wrappers around them) are zips of up to several hundred MB with tens
// of thousands of files, of which an importer needs a handful; unpacking all of them (fflate's unzipSync) would
// cost seconds and gigabytes. Stored entries (how the wrappers keep their inner .apk files) come back as views
// into the file, without a copy. Zip64 is read as far as a file in memory can need it.
import { inflateSync } from 'fflate';

export interface ZipEntry { name: string; method: number; csize: number; usize: number; local: number }

export class Zip {
  readonly entries = new Map<string, ZipEntry>();
  constructor(readonly data: Uint8Array) {}
  get names(): string[] { return [...this.entries.keys()]; }
  has(name: string): boolean { return this.entries.has(name); }
  size(name: string): number { return this.entries.get(name)?.usize ?? 0; }
  /** the entry's bytes; undefined when it is missing or can't be unpacked */
  get(name: string): Uint8Array | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const d = this.data, o = e.local;
    if (o + 30 > d.length || d[o] !== 0x50 || d[o + 1] !== 0x4b || d[o + 2] !== 3 || d[o + 3] !== 4) return undefined;
    const at = o + 30 + (d[o + 26] | d[o + 27] << 8) + (d[o + 28] | d[o + 29] << 8);
    const raw = d.subarray(at, at + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) return undefined;
    // refuse absurd sizes (zip bombs): real APK entries stay well under this; a crafted usize would OOM the tab
    if (e.usize <= 0 || e.usize > 512 * 1024 * 1024) return undefined;
    try { return inflateSync(raw, { out: new Uint8Array(e.usize) }); } catch { return undefined; }
  }
}

/** the zip's directory, or null when the bytes are no zip */
export function openZip(d: Uint8Array): Zip | null {
  if (d.length < 22 || d[0] !== 0x50 || d[1] !== 0x4b) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let eocd = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true), cd = dv.getUint32(eocd + 16, true);
  // zip64: the end record's locator sits right before it
  if ((count === 0xffff || cd === 0xffffffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
    const e64 = Number(dv.getBigUint64(eocd - 12, true));
    if (e64 + 56 <= d.length && dv.getUint32(e64, true) === 0x06064b50) {
      count = Number(dv.getBigUint64(e64 + 32, true));
      cd = Number(dv.getBigUint64(e64 + 48, true));
    }
  }
  const z = new Zip(d);
  const dec = new TextDecoder();
  let p = cd;
  for (let i = 0; i < count && p + 46 <= d.length && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = dec.decode(d.subarray(p + 46, p + 46 + nl));
    // zip64 extra field: the 64-bit values, in this order, for those set to 0xffffffff
    for (let x = p + 46 + nl, end = x + xl; x + 4 <= end;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) local = Number(dv.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) z.entries.set(name, { name, method, csize, usize, local });
    p += 46 + nl + xl + cl;
  }
  return z.entries.size ? z : null;
}
