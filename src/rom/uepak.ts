// Unreal pak containers.
// Version 8 (Piczle Cross Adventure) is zlib. Version 11 (Piczle Cross: Story of Seasons) is Oodle.
// Unreal Engine 4 pak (version 8, zlib), the container Piczle Cross Adventure ships in.
// The index sits at the end of the file: magic 0x5A6F12E1, version, index offset and size, a
// 20-byte hash, then the compression-method name ("Zlib"). Each directory entry is a length-prefixed
// path, three u64s (offset, compressed size, uncompressed size), flags, a SHA1, and for a compressed
// entry the method plus block bounds. Method 1 is one zlib stream per block (64 KiB chunks).
import { unzlibSync } from 'fflate';
import { oodle } from './oodle';

const MAGIC = 0x5a6f12e1;

function u32(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
}
function i32(d: Uint8Array, o: number): number {
  return u32(d, o) | 0;
}
function u64(d: Uint8Array, o: number): number {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return Number(dv.getBigUint64(o, true));
}

/** a length-prefixed pak path (ASCII or UTF-16), and the offset just past it. */
function readName(d: Uint8Array, p: number): { s: string; next: number } | null {
  if (p + 4 > d.length) return null;
  const n = i32(d, p);
  if (n === 0) return { s: '', next: p + 4 };
  const wide = n < 0;
  const bytes = wide ? -n * 2 : n;
  if (bytes < 2 || bytes > 600 || p + 4 + bytes > d.length) return null;
  const raw = d.subarray(p + 4, p + 4 + bytes);
  if (raw[raw.length - (wide ? 2 : 1)] !== 0) return null;
  let slash = false;
  if (!wide) {
    for (let i = 0; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === 0x2f) slash = true;
      if (c < 0x20 || c > 0x7e) return null;
    }
  }
  if (!wide && !slash) return null;
  const s = wide ? new TextDecoder('utf-16le').decode(raw).replace(/\0+$/, '') : new TextDecoder().decode(raw.subarray(0, raw.length - 1));
  return { s, next: p + 4 + bytes };
}

function nameAt(d: Uint8Array, p: number): boolean {
  const nm = readName(d, p);
  if (!nm) return false;
  const s = nm.s.replace(/^(\.\.\/)+/, '');
  return s.startsWith('Engine/') || s.startsWith('PiczleCross');
}

interface Entry { name: string; off: number; comp: number; raw: number; flags: number; method: number; blocks: Array<[number, number]> }

function index(pak: Uint8Array): Entry[] {
  let mp = -1;
  for (let o = pak.length - 4; o >= Math.max(0, pak.length - 1024); o--) if (u32(pak, o) === MAGIC) { mp = o; break; }
  if (mp < 0) throw new Error('Not a pak file.');
  const idxOff = u64(pak, mp + 8), idxSize = u64(pak, mp + 16);
  if (idxOff <= 0 || idxSize <= 0 || idxOff + idxSize > pak.length) throw new Error('Pak index is not readable.');
  const idx = pak.subarray(idxOff, idxOff + idxSize);
  const mount = readName(idx, 0);
  if (!mount) throw new Error('Pak index is not readable.');
  let p = mount.next;
  const count = u32(idx, p); p += 4;
  const out: Entry[] = [];
  for (let i = 0; i < count && p + 8 < idx.length; i++) {
    if (!nameAt(idx, p)) {
      let found = -1;
      for (let c = p + 1; c < Math.min(idx.length - 4, p + 8192); c++) if (nameAt(idx, c)) { found = c; break; }
      if (found < 0) break;
      p = found;
    }
    const nm = readName(idx, p);
    if (!nm) break;
    let q = nm.next;
    if (q + 24 + 4 + 20 > idx.length) break;
    const off = u64(idx, q), comp = u64(idx, q + 8), raw = u64(idx, q + 16); q += 24;
    const flags = u32(idx, q); q += 4;
    q += 20;
    let method = -1;
    const blocks: Array<[number, number]> = [];
    if (flags & 1) {
      if (q + 4 > idx.length) break;
      method = u32(idx, q); q += 4;
      let total = 0;
      while (q + 16 <= idx.length && !nameAt(idx, q + 16)) {
        const s = u64(idx, q), e = u64(idx, q + 8);
        blocks.push([s, e]); total += e - s; q += 16;
        if (comp > 0 && total >= comp) break;
      }
    }
    out.push({ name: nm.s.replace(/^(\.\.\/)+/, ''), off, comp, raw, flags, method, blocks });
    p = q;
  }
  return out;
}

function inflate(chunk: Uint8Array): Uint8Array | null {
  try { return unzlibSync(chunk); } catch { return null; }
}

interface NamedFiles { names: string[]; get(name: string): Promise<Uint8Array | undefined> }

/** loose puzzle files when the folder already has them, otherwise the puzzle uexps inside the pak. */
export async function withPakPuzzles(files: NamedFiles, root: string): Promise<{ files: NamedFiles; root: string }> {
  const pre = root === '.' ? '' : root;
  if (files.names.some(n => n.startsWith(pre) && /\/puzzledata\.uexp$/i.test(n))) return { files, root };
  const pakName = files.names.find(n => n.startsWith(pre) && /PiczleCrossAdvntr[^/]*\.pak$/i.test(n));
  if (!pakName) return { files, root };
  const pak = await files.get(pakName);
  if (!pak) return { files, root };
  const map = readUe4Pak(pak, n => /\/puzzles\/.+\.uexp$/i.test(n));
  return { files: { names: [...map.keys()], get: async n => map.get(n) }, root: '' };
}

/** files whose pak path matches `want`, decompressed. Names keep the path inside the pak. */
export function readUe4Pak(pak: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of index(pak)) {
    if (!want(e.name)) continue;
    let data: Uint8Array | null = null;
    if (!(e.flags & 1) || !e.blocks.length) {
      data = pak.subarray(e.off, e.off + e.raw);
    } else {
      const parts: Uint8Array[] = [];
      for (const [s, t] of e.blocks) {
        const chunk = pak.subarray(e.off + s, e.off + t);
        const one = e.method === 1 || chunk[0] === 0x78 ? inflate(chunk) : null;
        if (!one) { parts.length = 0; break; }
        parts.push(one);
      }
      if (parts.length) {
        const n = parts.reduce((a, b) => a + b.length, 0);
        data = new Uint8Array(n);
        let w = 0;
        for (const part of parts) { data.set(part, w); w += part.length; }
        if (e.raw && data.length !== e.raw) data = null;
      }
    }
    if (data) out.set(e.name, data);
  }
  return out;
}

function fstr(d: Uint8Array, p: number): { s: string; next: number } | null {
  if (p + 4 > d.length) return null;
  const n = i32(d, p);
  if (n === 0) return { s: '', next: p + 4 };
  const wide = n < 0, bytes = wide ? -n * 2 : n;
  if (bytes < 0 || bytes > d.length || p + 4 + bytes > d.length) return null;
  const raw = d.subarray(p + 4, p + 4 + bytes);
  const s = (wide ? new TextDecoder('utf-16le').decode(raw) : new TextDecoder().decode(raw)).replace(/\0+$/, '');
  return { s, next: p + 4 + bytes };
}

/** one file from a UE5 v11 pak (Oodle). `want` sees the path inside the pak. */
export async function readUe5File(pak: Uint8Array, want: (name: string) => boolean): Promise<Uint8Array | null> {
  const start = pak.length - 221;
  if (start < 0) return null;
  const idxOff = u64(pak, start + 25), idxSize = u64(pak, start + 33);
  if (idxOff <= 0 || idxOff + idxSize > pak.length) return null;
  const methods: string[] = [];
  for (let i = 0; i < 5; i++) {
    const raw = pak.subarray(start + 61 + i * 32, start + 61 + (i + 1) * 32);
    const z = raw.indexOf(0);
    methods.push(new TextDecoder().decode(z < 0 ? raw : raw.subarray(0, z)));
  }
  const idx = pak.subarray(idxOff, idxOff + idxSize);
  let o = 0;
  const mount = fstr(idx, o); if (!mount) return null; o = mount.next;
  o += 4; // path hash size
  o += 8; // seed
  o += 4; const phOff = u64(idx, o); o += 8; const phSize = u64(idx, o); o += 8; o += 20;
  void phOff; void phSize;
  o += 4; const fdOff = u64(idx, o); o += 8; const fdSize = u64(idx, o); o += 8; o += 20;
  const encSize = u32(idx, o); o += 4;
  const encoded = idx.subarray(o, o + encSize);
  if (fdOff + fdSize > pak.length) return null;
  const fdi = pak.subarray(fdOff, fdOff + fdSize);
  let p = 4; // skip directory count; walk it
  const dirCount = u32(fdi, 0);
  const paths = new Map<string, number>();
  for (let d = 0; d < dirCount; d++) {
    const dir = fstr(fdi, p); if (!dir) return null; p = dir.next;
    const files = u32(fdi, p); p += 4;
    for (let f = 0; f < files; f++) {
      const name = fstr(fdi, p); if (!name) return null; p = name.next;
      const eo = i32(fdi, p); p += 4;
      if (eo !== -2147483648) paths.set(dir.s + name.s, eo);
    }
  }
  const hit = [...paths.keys()].find(want);
  if (!hit) return null;
  const eoff = paths.get(hit)!;
  const bits = u32(encoded, eoff);
  let q = eoff + 4;
  const compField = (bits >> 23) & 0x3f;
  const comp = compField === 0 ? -1 : compField - 1;
  const encr = (bits >> 22) & 1;
  let blocks = (bits >> 6) & 0xffff;
  let bsize = bits & 0x3f;
  if (bsize === 0x3f) { bsize = u32(encoded, q); q += 4; } else bsize <<= 11;
  const vi = (bit: number) => {
    const wide = (bits >> bit) & 1;
    const v = wide ? u32(encoded, q) : u64(encoded, q);
    q += wide ? 4 : 8;
    return v;
  };
  const off = vi(31), unc = vi(30);
  if (comp < 0) return pak.subarray(off, off + unc);
  vi(29);
  const sizes: number[] = [];
  for (let i = 0; i < blocks; i++) { sizes.push(u32(encoded, q)); q += 4; }
  let rel = 48 + 4 + 16 * blocks + 1 + 4;
  const chunks: Uint8Array[] = [];
  for (const sz of sizes) {
    const end = encr ? (rel + sz + 15) & ~15 : rel + sz;
    chunks.push(pak.subarray(off + rel, off + end));
    rel = end;
  }
  if (methods[comp] !== 'Oodle') throw new Error('Unsupported pak compression.');
  const out = new Uint8Array(unc);
  let w = 0;
  for (const chunk of chunks) {
    const wantN = Math.min(bsize || unc, unc - w);
    out.set(await oodle(chunk, wantN), w);
    w += wantN;
  }
  return out;
}
