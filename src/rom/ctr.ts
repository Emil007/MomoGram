// Decrypted Nintendo 3DS titles (.3ds/.cci NCSD, .cxi NCCH, decrypted .cia): RomFS, ExeFS icon, LZ11.
// Encrypted titles are detected and rejected; MomoGram does not decrypt anything.

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const ascii = (d: Uint8Array, o: number, n: number) => String.fromCharCode(...d.subarray(o, o + n)).replace(/\0+$/, '');

export interface CtrFile { path: string; data: Uint8Array }
export interface CtrTitle { productCode: string; titleId: string; names: string[]; files: CtrFile[] }

function findNcch(d: Uint8Array): number {
  const magic = (o: number) => d[o] === 0x4e && d[o + 1] === 0x43 && d[o + 2] === 0x43;
  if (d[0x100] === 0x4e && d[0x101] === 0x43 && d[0x102] === 0x53 && d[0x103] === 0x44) return u32(d, 0x120) * 0x200; // NCSD: partition 0
  if (magic(0x100) && d[0x103] === 0x48) return 0;
  // CIA: content starts after aligned header/cert/ticket/tmd; just search for the first NCCH header
  for (let o = 0; o + 0x200 < Math.min(d.length, 0x100000); o += 0x40) if (magic(o + 0x100) && d[o + 0x103] === 0x48) return o;
  return -1;
}

/** true if the RomFS can't be read as plain data (the NoCrypto flag alone is not reliable) */
export function ctrEncrypted(d: Uint8Array): boolean | null {
  const b = findNcch(d);
  if (b < 0) return null;
  const r = b + u32(d, b + 0x1b0) * 0x200;
  return ascii(d, r, 4) !== 'IVFC';
}

export function readCtr(d: Uint8Array): CtrTitle {
  const b = findNcch(d);
  if (b < 0) throw new Error('No 3DS title found in this file.');
  if (ctrEncrypted(d)) throw new Error('encrypted');
  const productCode = ascii(d, b + 0x150, 16);
  const titleId = [...d.subarray(b + 0x118, b + 0x120)].reverse().map(x => x.toString(16).padStart(2, '0')).join('');
  const mu = 0x200;
  // ExeFS icon (SMDH) for the game's own title in each language
  const names: string[] = [];
  const exefs = b + u32(d, b + 0x1a0) * mu;
  for (let i = 0; i < 10; i++) {
    const e = exefs + i * 16;
    if (ascii(d, e, 8) === 'icon') {
      const smdh = exefs + 0x200 + u32(d, e + 8);
      if (ascii(d, smdh, 4) === 'SMDH') for (let l = 0; l < 12; l++) {
        const o = smdh + 8 + l * 0x200 + 0x80;
        let s = '';
        for (let k = 0; k < 0x80; k += 2) { const c = u16(d, o + k); if (!c) break; s += String.fromCharCode(c); }
        names.push(s.replace(/\n/g, ' ').trim());
      }
    }
  }
  const rOff = b + u32(d, b + 0x1b0) * mu;
  const r = d.subarray(rOff, rOff + u32(d, b + 0x1b4) * mu);
  if (ascii(r, 0, 4) !== 'IVFC') throw new Error('RomFS not readable (encrypted?)');
  const bs = 1 << u32(r, 0x4c);
  const l3 = Math.ceil((0x60 + u32(r, 8)) / bs) * bs;
  const f = r.subarray(l3);
  const dmo = u32(f, 0x0c), fmo = u32(f, 0x1c), fdo = u32(f, 0x24);
  const files: CtrFile[] = [];
  const name = (o: number, len: number) => { let s = ''; for (let k = 0; k < len; k += 2) s += String.fromCharCode(u16(f, o + k)); return s; };
  const dir = (o: number, path: string) => {
    const child = u32(f, dmo + o + 8), first = u32(f, dmo + o + 12), nl = u32(f, dmo + o + 0x14);
    const p = o ? path + name(dmo + o + 0x18, nl) + '/' : '/';
    for (let fo = first; fo !== 0xffffffff; fo = u32(f, fmo + fo + 4)) {
      const off = fdo + u32(f, fmo + fo + 8), size = u32(f, fmo + fo + 0x10);
      files.push({ path: p + name(fmo + fo + 0x20, u32(f, fmo + fo + 0x1c)), data: f.subarray(off, off + size) });
    }
    for (let c = child; c !== 0xffffffff; c = u32(f, dmo + c + 4)) dir(c, p);
  };
  dir(0, '');
  return { productCode, titleId, names, files };
}

export function lz11(d: Uint8Array): Uint8Array {
  if (d[0] !== 0x11 && d[0] !== 0x10) return d;
  let n = d[1] | (d[2] << 8) | (d[3] << 16), p = 4;
  if (!n) { n = u32(d, 4); p = 8; }
  const out = new Uint8Array(n);
  let o = 0;
  const lz10 = d[0] === 0x10;
  while (o < n && p < d.length) {
    const flags = d[p++];
    for (let b = 0; b < 8 && o < n; b++) {
      if (flags & (0x80 >> b)) {
        let len: number, disp: number;
        const a = d[p];
        if (lz10) { len = (a >> 4) + 3; disp = (((a & 15) << 8) | d[p + 1]) + 1; p += 2; }
        else if (a >> 4 === 0) { len = (((a & 15) << 4) | (d[p + 1] >> 4)) + 0x11; disp = (((d[p + 1] & 15) << 8) | d[p + 2]) + 1; p += 3; }
        else if (a >> 4 === 1) { len = (((a & 15) << 12) | (d[p + 1] << 4) | (d[p + 2] >> 4)) + 0x111; disp = (((d[p + 2] & 15) << 8) | d[p + 3]) + 1; p += 4; }
        else { len = (a >> 4) + 1; disp = (((a & 15) << 8) | d[p + 1]) + 1; p += 2; }
        for (let k = 0; k < len && o < n; k++, o++) out[o] = out[o - disp];
      } else out[o++] = d[p++];
    }
  }
  return out;
}

export const SMDH_LANGS = ['ja', 'en', 'fr', 'de', 'it', 'es', 'zh', 'ko', 'nl', 'pt', 'ru', 'tw'];
export { u16, u32 };
