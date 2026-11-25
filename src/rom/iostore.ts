// Unreal Engine 5 IoStore (.utoc + .ucas), the container Piczle Cross: Rune Factory ships in.
// The toc lists chunk ids, 10-byte offset/length records (big-endian), compression blocks and a
// directory of file names. Chunk bytes live in the ucas, one 64 KiB block at a time, Oodle or raw.
import { oodle } from './oodle';

function u32(d: Uint8Array, o: number): number {
  return (d[o] + d[o + 1] * 256 + d[o + 2] * 65536 + d[o + 3] * 16777216) >>> 0;
}
function i32(d: Uint8Array, o: number): number {
  return u32(d, o) | 0;
}
function be5(d: Uint8Array, o: number): number {
  return d[o] * 4294967296 + d[o + 1] * 16777216 + d[o + 2] * 65536 + d[o + 3] * 256 + d[o + 4];
}
function le5(d: Uint8Array, o: number): number {
  return d[o] + d[o + 1] * 256 + d[o + 2] * 65536 + d[o + 3] * 16777216 + d[o + 4] * 4294967296;
}

function fstr(d: Uint8Array, p: number): { s: string; next: number } {
  const n = i32(d, p);
  if (n === 0) return { s: '', next: p + 4 };
  const wide = n < 0, bytes = Math.abs(n) * (wide ? 2 : 1);
  const raw = d.subarray(p + 4, p + 4 + bytes);
  const s = (wide ? new TextDecoder('utf-16le').decode(raw) : new TextDecoder().decode(raw)).replace(/\0+$/, '');
  return { s, next: p + 4 + bytes };
}

interface Toc {
  blockSize: number;
  records: Uint8Array;
  blocks: Uint8Array;
  paths: Array<{ name: string; chunk: number }>;
}

function tocOf(utoc: Uint8Array): Toc {
  const header = u32(utoc, 20);
  const entries = u32(utoc, 24);
  const blockCount = u32(utoc, 28);
  const blockSize = u32(utoc, 44);
  const seeds = u32(utoc, 84);
  let o = header;
  o += entries * 12;
  const records = utoc.subarray(o, o + entries * 10); o += entries * 10;
  o += seeds * 4;
  const blocks = utoc.subarray(o, o + blockCount * 12); o += blockCount * 12;
  o += u32(utoc, 36) * u32(utoc, 40); // compression method names
  const dirEnd = o + u32(utoc, 48);
  const mount = fstr(utoc, o); o = mount.next;
  const dirs: Array<[number, number, number, number]> = [];
  for (let i = 0, n = u32(utoc, o), p = o + 4; i < n; i++, p += 16) {
    dirs.push([u32(utoc, p), u32(utoc, p + 4), u32(utoc, p + 8), u32(utoc, p + 12)]);
    o = p + 16;
  }
  const files: Array<[number, number, number]> = [];
  for (let i = 0, n = u32(utoc, o), p = o + 4; i < n; i++, p += 12) {
    files.push([u32(utoc, p), u32(utoc, p + 4), u32(utoc, p + 8)]);
    o = p + 12;
  }
  const strings: string[] = [];
  o += 4; // string-table byte size; the strings themselves follow as FStrings and fill the directory
  while (o < dirEnd) {
    const s = fstr(utoc, o);
    strings.push(s.s);
    o = s.next;
  }
  const paths: Array<{ name: string; chunk: number }> = [];
  const walk = (di: number, acc: string, depth: number) => {
    if (depth > 40 || di < 0 || di >= dirs.length) return;
    const [name, child, sib, first] = dirs[di];
    const nm = name === 0xffffffff ? '' : strings[name] ?? '';
    const here = nm ? acc + '/' + nm : acc;
    for (let i = first, g = 0; i !== 0xffffffff && g < 200000; g++) {
      const [fn, next, user] = files[i];
      paths.push({ name: here + '/' + (strings[fn] ?? ''), chunk: user });
      i = next;
    }
    walk(child, here, depth + 1);
    walk(sib, acc, depth + 1);
  };
  walk(0, mount.s.replace(/^(\.\.\/)+/, '').replace(/\/$/, ''), 0);
  return { blockSize, records, blocks, paths };
}

const MAX_CHUNK = 32 * 1024 * 1024;

async function chunk(toc: Toc, ucas: Uint8Array, index: number): Promise<Uint8Array> {
  const rec = index * 10;
  if (rec + 10 > toc.records.length) throw new Error('IoStore chunk is not in the table.');
  const off = be5(toc.records, rec), len = be5(toc.records, rec + 5);
  if (!toc.blockSize || !Number.isFinite(len) || len <= 0 || len > MAX_CHUNK) throw new Error('IoStore chunk is not readable.');
  const out = new Uint8Array(len);
  let pos = off, w = 0, guard = 0;
  while (w < len) {
    if (++guard > 1_000_000) throw new Error('IoStore chunk did not finish.');
    const bi = Math.floor(pos / toc.blockSize);
    const b = bi * 12;
    if (b < 0 || b + 12 > toc.blocks.length) throw new Error('IoStore block is not in the table.');
    const rawOff = le5(toc.blocks, b);
    const csz = toc.blocks[b + 5] | (toc.blocks[b + 6] << 8) | (toc.blocks[b + 7] << 16);
    const usz = toc.blocks[b + 8] | (toc.blocks[b + 9] << 8) | (toc.blocks[b + 10] << 16);
    const method = toc.blocks[b + 11];
    if (rawOff < 0 || csz <= 0 || rawOff + csz > ucas.length) throw new Error('IoStore block is not readable.');
    if (method !== 0 && (usz <= 0 || usz > MAX_CHUNK)) throw new Error('IoStore block is not readable.');
    const src = ucas.subarray(rawOff, rawOff + csz);
    const plain = method === 0 ? src : await oodle(src, usz);
    const skip = pos % toc.blockSize;
    const take = Math.min(plain.length - skip, len - w);
    if (!(take > 0)) throw new Error('IoStore block made no progress.');
    out.set(plain.subarray(skip, skip + take), w);
    w += take;
    pos += take;
  }
  return out;
}

/** files under Puzzles/ whose name is the puzzle table (not the solution pictures or collages). */
export async function readPiczleIoStore(utoc: Uint8Array, ucas: Uint8Array): Promise<Uint8Array[]> {
  const toc = tocOf(utoc);
  const hits = toc.paths.filter(p => /\/Puzzles\/(?:puzzles|puzzle_grid)/i.test(p.name) && /\.uasset$/i.test(p.name) && !/collage|solution/i.test(p.name));
  const out: Uint8Array[] = [];
  for (const h of hits) out.push(await chunk(toc, ucas, h.chunk));
  return out;
}
