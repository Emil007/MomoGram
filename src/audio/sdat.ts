// Nintendo DS sound archive (SDAT) reader: sequences, banks and wave archives.

const u8 = (d: Uint8Array, o: number) => d[o];
const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export interface SeqInfo { name: string; fileId: number; bank: number; volume: number }
export interface Wave { rate: number; loop: boolean; loopStart: number; data: Float32Array }
export interface NoteDef {
  kind: 'pcm' | 'psg' | 'noise';
  swav: number; swar: number; duty: number;
  baseNote: number; attack: number; decay: number; sustain: number; release: number; pan: number;
}
export interface Instrument { regions: Array<{ lo: number; hi: number; def: NoteDef }> }
export interface Bank { instruments: (Instrument | null)[]; waveArcs: number[] }

export class Sdat {
  private d: Uint8Array;
  private fat: Array<[number, number]> = [];
  seqs: SeqInfo[] = [];
  private bankInfo: Array<{ fileId: number; arcs: number[] }> = [];
  private warInfo: Array<{ fileId: number }> = [];
  private bankCache = new Map<number, Bank>();
  private warCache = new Map<number, Wave[]>();

  constructor(d: Uint8Array) {
    if (String.fromCharCode(...d.subarray(0, 4)) !== 'SDAT') throw new Error('not an SDAT');
    this.d = d;
    const symbOff = u32(d, 0x10), infoOff = u32(d, 0x18), fatOff = u32(d, 0x20);
    const fatN = u32(d, fatOff + 8);
    for (let i = 0; i < fatN; i++) this.fat.push([u32(d, fatOff + 12 + i * 16), u32(d, fatOff + 16 + i * 16)]);
    const record = (k: number) => {
      const r = infoOff + u32(d, infoOff + 8 + k * 4);
      const n = u32(d, r);
      return [...Array(n)].map((_, i) => u32(d, r + 4 + i * 4)).map(o => (o ? infoOff + o : 0));
    };
    const names = (k: number): string[] => {
      if (!symbOff) return [];
      const r = symbOff + u32(d, symbOff + 8 + k * 4);
      const n = u32(d, r);
      return [...Array(n)].map((_, i) => {
        const o = u32(d, r + 4 + i * 4);
        if (!o) return '';
        let e = symbOff + o, s = '';
        while (d[e]) s += String.fromCharCode(d[e++]);
        return s;
      });
    };
    const seqNames = names(0);
    record(0).forEach((o, i) => { if (o) this.seqs.push({ name: seqNames[i] ?? `SEQ_${i}`, fileId: u16(d, o), bank: u16(d, o + 4), volume: u8(d, o + 6) }); else this.seqs.push({ name: '', fileId: -1, bank: 0, volume: 0 }); });
    record(2).forEach(o => this.bankInfo.push(o ? { fileId: u16(d, o), arcs: [0, 1, 2, 3].map(k => u16(d, o + 4 + k * 2)) } : { fileId: -1, arcs: [] }));
    record(3).forEach(o => this.warInfo.push({ fileId: o ? u32(d, o) & 0xffffff : -1 }));
  }

  file(id: number): Uint8Array {
    const [o, s] = this.fat[id];
    return this.d.subarray(o, o + s);
  }

  seqByName(name: string): SeqInfo | undefined { return this.seqs.find(s => s.name === name); }

  /** returns the sequence event data (starting at the DATA block) */
  seqData(s: SeqInfo): { data: Uint8Array } {
    const f = this.file(s.fileId);
    const dataOff = u32(f, 0x18);
    return { data: f.subarray(dataOff) };
  }

  bank(i: number): Bank {
    const c = this.bankCache.get(i);
    if (c) return c;
    const info = this.bankInfo[i];
    const f = this.file(info.fileId);
    const n = u32(f, 0x38);
    const instruments: (Instrument | null)[] = [];
    const readDef = (o: number, type: number): NoteDef => ({
      kind: type === 2 ? 'psg' : type === 3 ? 'noise' : 'pcm',
      swav: u16(f, o), swar: u16(f, o + 2), duty: u16(f, o),
      baseNote: u8(f, o + 4), attack: u8(f, o + 5), decay: u8(f, o + 6), sustain: u8(f, o + 7), release: u8(f, o + 8), pan: u8(f, o + 9),
    });
    for (let k = 0; k < n; k++) {
      const rec = 0x3c + k * 4;
      const type = u8(f, rec), off = u16(f, rec + 1);
      if (type === 0) { instruments.push(null); continue; }
      if (type < 16) { instruments.push({ regions: [{ lo: 0, hi: 127, def: readDef(off, type) }] }); continue; }
      if (type === 16) {
        const lo = u8(f, off), hi = u8(f, off + 1);
        const regions = [];
        for (let key = lo; key <= hi; key++) {
          const o = off + 2 + (key - lo) * 12;
          regions.push({ lo: key, hi: key, def: readDef(o + 2, u16(f, o)) });
        }
        instruments.push({ regions });
        continue;
      }
      if (type === 17) {
        const regions = [];
        let lo = 0;
        for (let r = 0; r < 8; r++) {
          const hi = u8(f, off + r);
          if (!hi && r) break;
          const o = off + 8 + r * 12;
          regions.push({ lo, hi, def: readDef(o + 2, u16(f, o)) });
          lo = hi + 1;
        }
        instruments.push({ regions });
        continue;
      }
      instruments.push(null);
    }
    const b: Bank = { instruments, waveArcs: info.arcs };
    this.bankCache.set(i, b);
    return b;
  }

  waves(arc: number): Wave[] {
    const c = this.warCache.get(arc);
    if (c) return c;
    const info = this.warInfo[arc];
    const out: Wave[] = [];
    if (!info || info.fileId < 0) return out;
    const f = this.file(info.fileId);
    const n = u32(f, 0x38);
    for (let i = 0; i < n; i++) out.push(decodeSwav(f, u32(f, 0x3c + i * 4)));
    this.warCache.set(arc, out);
    return out;
  }
}

const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

function decodeSwav(f: Uint8Array, o: number): Wave {
  const type = f[o], loop = !!f[o + 1], rate = u16(f, o + 2);
  const loopWords = u16(f, o + 6), lenWords = u32(f, o + 8);
  const start = o + 12;
  const bytes = (loopWords + lenWords) * 4;
  let data: Float32Array, loopStart: number;
  if (type === 0) {
    data = new Float32Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = ((f[start + i] << 24) >> 24) / 128;
    loopStart = loopWords * 4;
  } else if (type === 1) {
    data = new Float32Array(bytes / 2);
    for (let i = 0; i < data.length; i++) data[i] = ((u16(f, start + i * 2) << 16) >> 16) / 32768;
    loopStart = loopWords * 2;
  } else {
    // IMA-ADPCM with a 4-byte header
    let pred = (u16(f, start) << 16) >> 16, idx = Math.min(88, f[start + 2]);
    const nb = bytes - 4;
    data = new Float32Array(nb * 2);
    for (let i = 0; i < nb; i++) {
      const b = f[start + 4 + i];
      for (let h = 0; h < 2; h++) {
        const nib = h ? b >> 4 : b & 15;
        const step = IMA_STEP[idx];
        let diff = step >> 3;
        if (nib & 1) diff += step >> 2;
        if (nib & 2) diff += step >> 1;
        if (nib & 4) diff += step;
        pred = nib & 8 ? Math.max(-32768, pred - diff) : Math.min(32767, pred + diff);
        idx = Math.max(0, Math.min(88, idx + IMA_IDX[nib & 7]));
        data[i * 2 + h] = pred / 32768;
      }
    }
    loopStart = Math.max(0, (loopWords * 4 - 4) * 2);
  }
  return { rate: rate || 32768, loop, loopStart, data };
}

export { u8, u16, u32 };
