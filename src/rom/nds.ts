// Minimal Nintendo DS ROM reader: header, file system, ARM9 and overlays (with BLZ decompression).
// Works on the user's own ROM at runtime; no game data ships with MomoGram.
import { Sdat } from '../audio/sdat';
import type { PackAsset, PackTheme } from '../packs/format';

export interface Overlay {
  id: number;
  ramAddress: number;
  data: Uint8Array;
}

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/** Backwards LZ ("BLZ") used for ARM9 and overlays. */
export function blzDecompress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const footer = u32(src, n - 8);
  const extra = u32(src, n - 4);
  const headerLen = footer >>> 24;
  const compLen = footer & 0xffffff;
  if (extra > 32 * 1024 * 1024 || n + extra > 64 * 1024 * 1024) throw new Error('BLZ output is too large.');
  const out = new Uint8Array(n + extra);
  out.set(src);
  let inPos = n - headerLen;
  let outPos = n + extra;
  const end = n - compLen;
  while (inPos > end) {
    let flags = out[--inPos];
    for (let i = 0; i < 8 && inPos > end; i++, flags <<= 1) {
      if (flags & 0x80) {
        const b1 = out[--inPos];
        const b2 = out[--inPos];
        const len = (b1 >> 4) + 3;
        const disp = (((b1 & 0x0f) << 8) | b2) + 3;
        for (let j = 0; j < len; j++) {
          outPos--;
          out[outPos] = out[outPos + disp];
        }
      } else {
        out[--outPos] = out[--inPos];
      }
    }
  }
  return out;
}

export class NdsRom {
  readonly data: Uint8Array;
  readonly gameCode: string;
  readonly title: string;
  private fat: Array<[number, number]> = [];
  private names = new Map<string, number>();

  /** the 32×32 icon from the banner, as RGBA (colour 0 is transparent) */
  icon(): Uint8Array | null {
    const d = this.data, b = u32(d, 0x68);
    if (!b || b + 0x240 > d.length) return null;
    const pal: number[][] = [];
    for (let i = 0; i < 16; i++) { const v = d[b + 0x220 + i * 2] | (d[b + 0x221 + i * 2] << 8); pal.push([(v & 31) * 255 / 31, ((v >> 5) & 31) * 255 / 31, ((v >> 10) & 31) * 255 / 31]); }
    const out = new Uint8Array(32 * 32 * 4);
    for (let t = 0; t < 16; t++) for (let k = 0; k < 64; k++) {
      const byte = d[b + 0x20 + t * 32 + (k >> 1)], c = k & 1 ? byte >> 4 : byte & 15;
      const x = (t % 4) * 8 + (k & 7), y = (t >> 2) * 8 + (k >> 3), o = (y * 32 + x) * 4;
      out[o] = pal[c][0]; out[o + 1] = pal[c][1]; out[o + 2] = pal[c][2]; out[o + 3] = c ? 255 : 0;
    }
    return out;
  }

  constructor(data: Uint8Array) {
    this.data = data;
    const td = new TextDecoder('latin1');
    this.title = td.decode(data.subarray(0, 12)).replace(/\0+$/, '');
    this.gameCode = td.decode(data.subarray(12, 16));
    const fatOff = u32(data, 0x48), fatSize = u32(data, 0x4c);
    for (let i = 0; i < fatSize / 8; i++) this.fat.push([u32(data, fatOff + i * 8), u32(data, fatOff + i * 8 + 4)]);
    this.readFnt(u32(data, 0x40));
  }

  static looksLike(data: Uint8Array): boolean {
    if (data.length < 0x200) return false;
    // header CRC of logo area is stable for every licensed DS ROM
    return u16(data, 0x15c) === 0xcf56;
  }

  private readFnt(fnt: number) {
    const d = this.data;
    const walk = (dirId: number, path: string) => {
      const entry = fnt + (dirId & 0xfff) * 8;
      let p = fnt + u32(d, entry);
      let fileId = u16(d, entry + 4);
      for (;;) {
        const t = d[p++];
        if (t === 0) break;
        const len = t & 0x7f;
        const name = new TextDecoder('latin1').decode(d.subarray(p, p + len));
        p += len;
        if (t & 0x80) {
          const sub = u16(d, p);
          p += 2;
          walk(sub, path + name + '/');
        } else {
          this.names.set(path + name, fileId++);
        }
      }
    };
    walk(0xf000, '');
  }

  file(id: number): Uint8Array {
    const [s, e] = this.fat[id];
    return this.data.subarray(s, e);
  }

  fileByName(name: string): Uint8Array | null {
    const id = this.names.get(name);
    return id === undefined ? null : this.file(id);
  }

  fileNames(): string[] {
    return [...this.names.keys()];
  }

  arm9(): { ram: number; data: Uint8Array } {
    const d = this.data;
    const off = u32(d, 0x20), ram = u32(d, 0x28), size = u32(d, 0x2c);
    let code = d.slice(off, off + size);
    // module params end with 0xDEC00621, 0x2106C0DE (at +0x1c); compressed end at +0x14
    for (let i = 0; i + 0x20 < code.length; i += 4) {
      if (u32(code, i) === 0xdec00621 && u32(code, i + 4) === 0x2106c0de) {
        const p = i - 0x1c;
        const compEnd = u32(code, p + 0x14);
        if (compEnd) {
          const len = compEnd - ram;
          const dec = blzDecompress(code.subarray(0, len));
          const merged = new Uint8Array(dec.length + (code.length - len));
          merged.set(dec);
          merged.set(code.subarray(len), dec.length);
          code = merged as Uint8Array<ArrayBuffer>;
        }
        break;
      }
    }
    return { ram, data: code };
  }

  overlays(): Overlay[] {
    const d = this.data;
    const off = u32(d, 0x50), size = u32(d, 0x54);
    const out: Overlay[] = [];
    for (let i = 0; i < size / 32; i++) {
      const e = off + i * 32;
      const id = u32(d, e), ram = u32(d, e + 4), fileId = u32(d, e + 0x18), flags = u32(d, e + 0x1c);
      let data = this.file(fileId).slice();
      if ((flags >>> 24) & 1) data = blzDecompress(data) as Uint8Array<ArrayBuffer>;
      out.push({ id, ramAddress: ram, data });
    }
    return out;
  }
}

export { u16, u32 };

/** a DS colour (BGR555) as CSS hex */
export function bgr555Hex(v: number): string {
  const c = (x: number) => Math.round((x & 31) * 255 / 31).toString(16).padStart(2, '0');
  return '#' + c(v) + c(v >> 5) + c(v >> 10);
}

/**
 * A DS game's own music: its sound archive becomes the pack asset "sound.sdat", the roles and tracks name
 * sequences in it (missing names are left out, so a revision with other names still imports).
 */
export function ndsMusic(rom: NdsRom, file: string, roles: Partial<Record<'menu' | 'title' | 'play' | 'clear', string>>, tracks: string[]): { theme: PackTheme; assets: PackAsset[] } {
  const sdat = rom.fileByName(file);
  if (!sdat) return { theme: {}, assets: [] };
  const music: PackTheme['music'] = {};
  for (const [k, v] of Object.entries(roles)) if (v) music[k as keyof typeof roles] = 'sound.sdat#' + v;
  return { theme: { music, tracks: tracks.map(s => 'sound.sdat#' + s), songs: sdatSongs(sdat) }, assets: [{ name: 'sound.sdat', data: sdat.slice() }] };
}

/** every sequence of a sound archive that is music (not a sound effect), as track refs */
export function sdatSongs(sdat: Uint8Array): string[] {
  try {
    return new Sdat(sdat).seqs.filter(s => s.fileId >= 0 && s.name && !/(^|_)(se|voice)(_|\d|$)|^SEQ_\d+$/i.test(s.name)).map(s => 'sound.sdat#' + s.name);
  } catch { return []; }
}
