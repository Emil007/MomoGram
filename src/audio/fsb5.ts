// FMOD sound banks (FSB5) as Unity stores AudioClips on the Switch, and their Vorbis streams rebuilt as Ogg
// Vorbis files, which every browser plays. FSB5 keeps the Vorbis audio packets but leaves out the three Vorbis
// headers: the identification header is rebuilt from the sample's format, the setup header comes from a table
// keyed by the CRC32 the bank stores (vorbis-setups.ts), and the loop points go into the comment header.
import { VORBIS_SETUPS } from './vorbis-setups';

export interface FsbSample { name: string; rate: number; channels: number; samples: number; loop?: [number, number]; crc?: number; data: Uint8Array }

const RATES = [0, 8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

export const isFsb5 = (d: Uint8Array, o = 0) => d[o] === 0x46 && d[o + 1] === 0x53 && d[o + 2] === 0x42 && d[o + 3] === 0x35;

/** the samples of an FSB5 bank; mode 15 = Vorbis */
export function readFsb5(d: Uint8Array): { mode: number; samples: FsbSample[] } {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  if (!isFsb5(d)) throw new Error('not FSB5');
  const version = u32(4), n = u32(8), shs = u32(12), nts = u32(16), mode = u32(24);
  const head = version === 0 ? 0x40 : 0x3c;
  let p = head;
  const raw: Array<Omit<FsbSample, 'data' | 'name'> & { off: number }> = [];
  for (let i = 0; i < n; i++) {
    const lo = u32(p), hi = u32(p + 4); p += 8;
    let next = lo & 1;
    const s: any = { rate: RATES[(lo >>> 1) & 15] ?? 44100, channels: ((lo >>> 5) & 1) + 1, off: ((lo >>> 6) | ((hi & 0x3) << 26)) * 16, samples: hi >>> 2 };
    while (next) {
      const c = u32(p); p += 4;
      next = c & 1;
      const size = (c >>> 1) & 0xffffff, type = (c >>> 25) & 0x7f;
      if (type === 1) s.channels = d[p];
      else if (type === 2) s.rate = u32(p);
      else if (type === 3) s.loop = [u32(p), u32(p + 4)];
      else if (type === 11) s.crc = u32(p);
      p += size;
    }
    raw.push(s);
  }
  // names: u32 offsets into the name table
  const names: string[] = [];
  const nt = head + shs;
  for (let i = 0; i < n && nts; i++) { const o = nt + u32(nt + i * 4); names.push(new TextDecoder().decode(d.subarray(o, d.indexOf(0, o)))); }
  const data = head + shs + nts;
  const samples = raw.map((s, i) => {
    const end = i + 1 < raw.length ? raw[i + 1].off : d.length - data;
    const { off, ...rest } = s;
    return { ...rest, name: names[i] ?? String(i), data: d.subarray(data + off, data + end) };
  });
  return { mode, samples };
}

// ---- Ogg ----

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
function oggCrc(b: Uint8Array): number { let c = 0; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 255]) >>> 0; return c; }

class OggWriter {
  parts: Uint8Array[] = [];
  seq = 0;
  constructor(private serial = 0x4d6f6d6f) {}
  /** one page holding whole packets; granule = the position after its last packet */
  page(packets: Uint8Array[], granule: number, flags: number) {
    const lacing: number[] = [];
    for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
    const body = packets.reduce((a, p) => a + p.length, 0);
    const pg = new Uint8Array(27 + lacing.length + body);
    const dv = new DataView(pg.buffer);
    pg.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
    dv.setUint32(6, granule >>> 0, true); dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
    dv.setUint32(14, this.serial, true); dv.setUint32(18, this.seq++, true);
    pg[26] = lacing.length; pg.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packets) { pg.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc(pg), true);
    this.parts.push(pg);
  }
  bytes() { const n = this.parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** a Vorbis FSB5 sample as an Ogg Vorbis file; null when its encoder setting is not in the table */
export function fsbVorbisToOgg(s: FsbSample): Uint8Array | null {
  const setupInfo = s.crc !== undefined ? VORBIS_SETUPS[s.crc] : undefined;
  if (!setupInfo) return null;
  const [bs0, bs1, setupB64] = setupInfo;
  const enc = new TextEncoder();
  const id = new Uint8Array(30);
  const idv = new DataView(id.buffer);
  id.set([1, ...enc.encode('vorbis')]);
  idv.setUint32(7, 0, true); id[11] = s.channels; idv.setUint32(12, s.rate, true);
  id[28] = (Math.log2(bs1) << 4) | Math.log2(bs0); id[29] = 1;
  const vendor = enc.encode('MomoGram'), comments = s.loop ? [`LOOPSTART=${s.loop[0]}`, `LOOPEND=${s.loop[1]}`].map(c => enc.encode(c)) : [];
  const cm = new Uint8Array(7 + 4 + vendor.length + 4 + comments.reduce((a, c) => a + 4 + c.length, 0) + 1);
  const cv = new DataView(cm.buffer);
  cm.set([3, ...enc.encode('vorbis')]);
  let o = 7; cv.setUint32(o, vendor.length, true); o += 4; cm.set(vendor, o); o += vendor.length;
  cv.setUint32(o, comments.length, true); o += 4;
  for (const c of comments) { cv.setUint32(o, c.length, true); o += 4; cm.set(c, o); o += c.length; }
  cm[o] = 1;
  const w = new OggWriter();
  w.page([id], 0, 2);
  w.page([cm, b64(setupB64)], 0, 0);
  // audio: u16 length + packet, one after another; the encoder's two modes are short and long blocks
  const d = s.data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 0, granule = 0, prev = 0, page: Uint8Array[] = [], segs = 0, size = 0;
  const flush = (last: boolean) => { if (page.length) w.page(page, last ? Math.max(granule, 0) : granule, last ? 4 : 0); page = []; segs = 0; size = 0; };
  while (p + 2 <= d.length) {
    const n = dv.getUint16(p, true); p += 2;
    if (!n || p + n > d.length) break;
    const pk = d.subarray(p, p + n); p += n;
    const bs = (pk[0] >> 1) & 1 ? bs1 : bs0;
    if (prev) granule += (prev + bs) / 4;
    prev = bs;
    const nsegs = Math.floor(n / 255) + 1;
    if (segs + nsegs > 255 || size > 8192) flush(false);
    page.push(pk); segs += nsegs; size += n;
  }
  // the last page ends exactly at the sample count
  granule = s.samples || granule;
  flush(true);
  return w.bytes();
}

/** loop points written by fsbVorbisToOgg, and the sample rate of an Ogg Vorbis file */
export function oggInfo(d: Uint8Array): { rate: number; loop?: [number, number] } | null {
  if (!(d[0] === 0x4f && d[1] === 0x67 && d[2] === 0x67 && d[3] === 0x53)) return null;
  const head = new TextDecoder('latin1').decode(d.subarray(0, Math.min(d.length, 8192)));
  const i = head.indexOf('\x01vorbis');
  const rate = i >= 0 ? new DataView(d.buffer, d.byteOffset).getUint32(i + 12, true) : 44100;
  const a = head.match(/LOOPSTART=(\d+)/), b = head.match(/LOOPEND=(\d+)/);
  return { rate, loop: a && b ? [+a[1], +b[1]] : undefined };
}
