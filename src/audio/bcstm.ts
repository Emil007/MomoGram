// BCSTM (3DS stream) decoder: DSP-ADPCM or PCM16, interleaved in blocks. Used for music from the user's own 3DS games.

export interface DecodedStream {
  sampleRate: number;
  channels: Float32Array[];
  loop: boolean;
  loopStart: number; // in samples
  loopEnd: number;
}

const u8 = (d: DataView, o: number) => d.getUint8(o);
const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);
const s16 = (d: DataView, o: number) => d.getInt16(o, true);

export function isBcstm(data: Uint8Array): boolean {
  return data.length > 0x40 && data[0] === 0x43 && data[1] === 0x53 && data[2] === 0x54 && data[3] === 0x4d; // "CSTM"
}

export function decodeBcstm(data: Uint8Array): DecodedStream {
  if (!isBcstm(data)) throw new Error('not a BCSTM file');
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // block table
  const nBlocks = u16(d, 0x10);
  let info = -1, dataBlk = -1;
  for (let i = 0; i < nBlocks; i++) {
    const type = u16(d, 0x14 + i * 12), off = u32(d, 0x14 + i * 12 + 4);
    if (type === 0x4000) info = off;
    if (type === 0x4002) dataBlk = off;
  }
  if (info < 0 || dataBlk < 0) throw new Error('BCSTM: missing INFO/DATA');
  const ib = info + 8; // INFO body; references are relative to it
  const si = ib + u32(d, ib + 4);
  const codec = u8(d, si), loop = u8(d, si + 1) !== 0, chCount = u8(d, si + 2);
  const sampleRate = u32(d, si + 4), loopStart = u32(d, si + 8), sampleCount = u32(d, si + 12);
  const blockCount = u32(d, si + 16), blockSize = u32(d, si + 20), blockSamples = u32(d, si + 24);
  const lastBlockSamples = u32(d, si + 32), lastBlockPadded = u32(d, si + 36);
  const dataOffset = u32(d, si + 0x34);
  if (codec !== 1 && codec !== 2) throw new Error('BCSTM: unsupported codec ' + codec);
  if (chCount < 1 || chCount > 8) throw new Error('BCSTM: bad channel count');

  // channel info table → DSP-ADPCM coefficients
  const ct = ib + u32(d, ib + 20);
  const coefs: Int16Array[] = [];
  for (let c = 0; c < chCount; c++) {
    const ci = ct + u32(d, ct + 4 + c * 8 + 4);
    const ai = ci + u32(d, ci + 4);
    const k = new Int16Array(16);
    if (codec === 2) for (let j = 0; j < 16; j++) k[j] = s16(d, ai + j * 2);
    coefs.push(k);
  }

  const out = Array.from({ length: chCount }, () => new Float32Array(sampleCount));
  const hist = Array.from({ length: chCount }, () => [0, 0]);
  let base = dataBlk + 8 + dataOffset;
  let pos = 0;
  for (let b = 0; b < blockCount; b++) {
    const last = b === blockCount - 1;
    const size = last ? lastBlockPadded : blockSize;
    const samples = last ? lastBlockSamples : blockSamples;
    for (let c = 0; c < chCount; c++) {
      const start = base + c * size;
      if (codec === 2) decodeDsp(data, start, samples, coefs[c], hist[c], out[c], pos);
      else for (let i = 0; i < samples && pos + i < sampleCount; i++) out[c][pos + i] = s16(d, start + i * 2) / 32768;
    }
    base += size * chCount;
    pos += samples;
  }
  return { sampleRate, channels: out, loop, loopStart: loop ? loopStart : 0, loopEnd: sampleCount };
}

function decodeDsp(src: Uint8Array, off: number, samples: number, k: Int16Array, h: number[], out: Float32Array, pos: number) {
  let h1 = h[0], h2 = h[1];
  for (let i = 0; i < samples; i += 14) {
    const ps = src[off++];
    const scale = 1 << (ps & 15), ci = (ps >> 4) & 7;
    const c1 = k[ci * 2], c2 = k[ci * 2 + 1];
    const n = Math.min(14, samples - i);
    for (let j = 0; j < n; j++) {
      const byte = src[off + (j >> 1)];
      let nib = j & 1 ? byte & 15 : byte >> 4;
      if (nib >= 8) nib -= 16;
      let s = ((nib * scale) << 11) + 1024 + c1 * h1 + c2 * h2;
      s >>= 11;
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      h2 = h1; h1 = s;
      const p = pos + i + j;
      if (p < out.length) out[p] = s / 32768;
    }
    off += 7;
  }
  h[0] = h1; h[1] = h2;
}

/** length of a stream without decoding it: seconds, and the loop (start, end) when it loops */
export function bcstmLength(data: Uint8Array): { sec: number; loop?: [number, number] } | null {
  try {
    if (!isBcstm(data)) return null;
    const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const nBlocks = d.getUint16(0x10, true);
    let info = -1;
    for (let i = 0; i < nBlocks; i++) if (d.getUint16(0x14 + i * 12, true) === 0x4000) info = d.getUint32(0x14 + i * 12 + 4, true);
    if (info < 0) return null;
    const ib = info + 8, si = ib + d.getUint32(ib + 4, true);
    const loop = d.getUint8(si + 1) !== 0, rate = d.getUint32(si + 4, true), start = d.getUint32(si + 8, true), count = d.getUint32(si + 12, true);
    return rate ? { sec: count / rate, loop: loop ? [start / rate, count / rate] : undefined } : null;
  } catch { return null; }
}
