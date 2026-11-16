// Sony S-DSP (Super Famicom sound generator): 8 voices playing BRR-compressed samples with 4-point interpolation,
// ADSR / GAIN envelopes, noise, pitch modulation and an 8-tap FIR echo, 32 kHz stereo output.
// Written from the public hardware documentation (fullsnes by Martin Korth, anomie's S-DSP doc). Sample-accurate,
// not cycle-accurate. The interpolation kernel is a computed Gaussian of the documented shape. MIT licence.

const RATE = [0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const RATE_OFFSET = [0, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0];
const COUNTER_RANGE = 2048 * 5 * 3;

/** 512-entry interpolation table: weight for a sample at distance 2 - k/256 from the output position */
const GAUSS = (() => {
  const t = new Int32Array(512), sigma = 0.56;
  const f = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma));
  let sum = 0;
  const raw = Array.from({ length: 512 }, (_, k) => f(2 - k / 256));
  // normalise so the four weights for every phase sum to 2048 (unity gain)
  for (let i = 0; i < 256; i++) {
    const s = raw[255 - i] + raw[511 - i] + raw[256 + i] + raw[i];
    sum += s;
  }
  const scale = 2048 / (sum / 256);
  for (let k = 0; k < 512; k++) t[k] = Math.round(raw[k] * scale);
  return t;
})();

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
const s8 = (v: number) => (v << 24) >> 24;

const enum Env { Release, Attack, Decay, Sustain }

class Voice {
  addr = 0; // address of the next BRR block
  block = new Int16Array(16); blockPos = 16; // decoded samples of the current block
  hist = new Int32Array(4); // last four samples, [3] newest
  p1 = 0; p2 = 0; // BRR filter history
  interp = 0;
  env = 0; mode = Env.Release;
  konDelay = 0;
  out = 0;
  endPending = false; loopPending = false;
}

export class Dsp {
  regs = new Uint8Array(128);
  private readonly v = Array.from({ length: 8 }, () => new Voice());
  private counter = 0;
  private noise = 0x4000;
  private echoPos = 0; private echoLen = 4;
  private firL = new Int32Array(8); private firR = new Int32Array(8); private firPos = 0;
  private konPending = 0;
  /** 32 kHz output, interleaved stereo 16-bit values; consumers drain it */
  out = new Int16Array(4096); outLen = 0;
  /** per voice: number of samples with a non-zero envelope (analysis) */
  activity = new Float64Array(8);

  constructor(private ram: Uint8Array, _sampleRate: number) {
    this.regs[0x6c] = 0xe0; // soft reset, mute, echo writes off
  }

  read(r: number): number { return this.regs[r]; }

  saveState(): Record<string, unknown> {
    return {
      regs: [...this.regs], counter: this.counter, noise: this.noise, echoPos: this.echoPos, echoLen: this.echoLen,
      firL: [...this.firL], firR: [...this.firR], firPos: this.firPos, konPending: this.konPending,
      v: this.v.map(o => ({ addr: o.addr, block: [...o.block], blockPos: o.blockPos, hist: [...o.hist], p1: o.p1, p2: o.p2, interp: o.interp, env: o.env, mode: o.mode, konDelay: o.konDelay, out: o.out })),
    };
  }
  loadState(st: any) {
    this.regs.set(st.regs);
    this.counter = st.counter; this.noise = st.noise; this.echoPos = st.echoPos; this.echoLen = st.echoLen;
    this.firL.set(st.firL); this.firR.set(st.firR); this.firPos = st.firPos; this.konPending = st.konPending;
    st.v.forEach((o: any, k: number) => {
      const d = this.v[k];
      d.addr = o.addr; d.block.set(o.block); d.blockPos = o.blockPos; d.hist.set(o.hist); d.p1 = o.p1; d.p2 = o.p2;
      d.interp = o.interp; d.env = o.env; d.mode = o.mode; d.konDelay = o.konDelay; d.out = o.out;
    });
  }

  write(r: number, v: number) {
    if (r === 0x7c) { this.regs[r] = 0; return; } // writing ENDX clears it
    this.regs[r] = v;
    if (r === 0x4c) this.konPending |= v;
  }

  private tick(rate: number): boolean {
    if (!rate) return false;
    return (this.counter + RATE_OFFSET[rate]) % RATE[rate] === 0;
  }

  private decodeBlock(vo: Voice, k: number) {
    const ram = this.ram;
    const hdr = ram[vo.addr], shift = hdr >> 4, filter = (hdr >> 2) & 3;
    let p1 = vo.p1, p2 = vo.p2;
    for (let i = 0; i < 16; i++) {
      const b = ram[(vo.addr + 1 + (i >> 1)) & 0xffff];
      let s = (i & 1) ? (b << 28) >> 28 : (b << 24) >> 28;
      s = shift <= 12 ? (s << shift) >> 1 : (s < 0 ? -2048 : 0);
      if (filter === 1) s += p1 + ((-p1) >> 4);
      else if (filter === 2) s += (p1 << 1) + ((-p1 * 3) >> 5) - p2 + (p2 >> 4);
      else if (filter === 3) s += (p1 << 1) + ((-p1 * 13) >> 6) - p2 + ((p2 * 3) >> 4);
      s = clamp16(s);
      s = (s << 17) >> 16; // the hardware keeps 15 bits, doubled (with wrap-around)
      vo.block[i] = s;
      p2 = p1; p1 = s;
    }
    vo.p1 = p1; vo.p2 = p2;
    vo.blockPos = 0;
    const end = (hdr & 1) !== 0, loop = (hdr & 2) !== 0;
    if (end) {
      this.regs[0x7c] |= 1 << k;
      const dir = this.regs[0x5d] << 8, e = (dir + this.regs[k * 16 + 4] * 4) & 0xffff;
      vo.addr = ram[(e + 2) & 0xffff] | (ram[(e + 3) & 0xffff] << 8);
      if (!loop) { vo.mode = Env.Release; vo.env = 0; }
    } else vo.addr = (vo.addr + 9) & 0xffff;
  }

  private nextSample(vo: Voice, k: number): number {
    if (vo.blockPos >= 16) this.decodeBlock(vo, k);
    return vo.block[vo.blockPos++];
  }

  private envelope(vo: Voice, base: number) {
    const adsr1 = this.regs[base + 5], adsr2 = this.regs[base + 6], gain = this.regs[base + 7];
    if (vo.mode === Env.Release) { vo.env -= 8; if (vo.env < 0) vo.env = 0; return; }
    let env = vo.env;
    if (adsr1 & 0x80) {
      if (vo.mode === Env.Attack) {
        const rate = ((adsr1 & 15) << 1) | 1;
        if (this.tick(rate)) env += rate === 31 ? 1024 : 32;
        if (env >= 0x7ff) { env = 0x7ff; vo.mode = Env.Decay; }
      } else if (vo.mode === Env.Decay) {
        const rate = (((adsr1 >> 4) & 7) << 1) + 16;
        if (this.tick(rate)) env -= ((env - 1) >> 8) + 1;
        if ((env >> 8) <= (adsr2 >> 5)) vo.mode = Env.Sustain;
      } else {
        if (this.tick(adsr2 & 31)) env -= ((env - 1) >> 8) + 1;
      }
    } else if (gain & 0x80) {
      if (this.tick(gain & 31)) {
        switch ((gain >> 5) & 3) {
          case 0: env -= 32; break;
          case 1: env -= ((env - 1) >> 8) + 1; break;
          case 2: env += 32; break;
          default: env += env < 0x600 ? 32 : 8;
        }
      }
    } else env = (gain & 0x7f) << 4;
    vo.env = env < 0 ? 0 : env > 0x7ff ? 0x7ff : env;
  }

  /** generate one 32 kHz stereo sample */
  sample() {
    const r = this.regs, ram = this.ram;
    this.counter = this.counter ? this.counter - 1 : COUNTER_RANGE - 1;
    const flg = r[0x6c];
    if (this.tick(flg & 31)) {
      const f = ((this.noise >> 0) ^ (this.noise >> 1)) & 1;
      this.noise = (this.noise >> 1) | (f << 14);
    }
    const noiseOut = ((this.noise << 17) >> 16);
    // key on / key off
    const kon = this.konPending; this.konPending = 0;
    const koff = r[0x5c];
    let mainL = 0, mainR = 0, echoL = 0, echoR = 0;
    const pmon = r[0x2d], non = r[0x3d], eon = r[0x4d];
    let prevOut = 0;
    for (let k = 0; k < 8; k++) {
      const vo = this.v[k], base = k * 16;
      if ((kon >> k) & 1) {
        const e = ((r[0x5d] << 8) + r[base + 4] * 4) & 0xffff;
        vo.addr = ram[e] | (ram[(e + 1) & 0xffff] << 8);
        vo.blockPos = 16; vo.p1 = vo.p2 = 0; vo.hist.fill(0);
        vo.interp = 0; vo.env = 0; vo.mode = Env.Attack; vo.konDelay = 5;
        r[0x7c] &= ~(1 << k);
      }
      if ((koff >> k) & 1 || flg & 0x80) { vo.mode = Env.Release; if (flg & 0x80) vo.env = 0; }
      if (vo.konDelay) { vo.konDelay--; vo.out = 0; r[base + 8] = 0; r[base + 9] = 0; prevOut = 0; continue; }
      // pitch (with modulation by the previous voice)
      let pitch = (r[base + 2] | (r[base + 3] << 8)) & 0x3fff;
      if (k && (pmon >> k) & 1) pitch += ((prevOut >> 5) * pitch) >> 10;
      if (pitch < 0) pitch = 0; else if (pitch > 0x7fff) pitch = 0x7fff;
      // interpolated sample
      const i = (vo.interp >> 4) & 0xff, h = vo.hist;
      let s: number;
      if ((non >> k) & 1) s = noiseOut;
      else {
        s = (GAUSS[255 - i] * h[0] + GAUSS[511 - i] * h[1] + GAUSS[256 + i] * h[2] + GAUSS[i] * h[3]) >> 11;
        s = clamp16(s) & ~1;
      }
      this.envelope(vo, base);
      const out = (s * vo.env) >> 11;
      vo.out = out; prevOut = out;
      if (vo.env) this.activity[k]++;
      r[base + 8] = vo.env >> 4;
      r[base + 9] = (out >> 7) & 0xff;
      // advance the sample position
      vo.interp += pitch;
      while (vo.interp >= 0x1000) {
        vo.interp -= 0x1000;
        h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = this.nextSample(vo, k);
      }
      const l = (out * s8(r[base])) >> 7, rr = (out * s8(r[base + 1])) >> 7;
      mainL = clamp16(mainL + l); mainR = clamp16(mainR + rr);
      if ((eon >> k) & 1) { echoL = clamp16(echoL + l); echoR = clamp16(echoR + rr); }
    }
    // echo: read the delayed sample, FIR filter, feedback into the buffer
    const esa = r[0x6d] << 8;
    const ea = (esa + this.echoPos) & 0xffff;
    const rd16 = (a: number) => ((ram[a & 0xffff] | (ram[(a + 1) & 0xffff] << 8)) << 16) >> 16;
    this.firPos = (this.firPos + 1) & 7;
    this.firL[this.firPos] = rd16(ea) >> 1; this.firR[this.firPos] = rd16(ea + 2) >> 1;
    let fl = 0, fr = 0;
    for (let t = 0; t < 8; t++) {
      const c = s8(r[t * 16 + 0x0f]), p = (this.firPos + 1 + t) & 7; // tap 0 = oldest
      fl += (c * this.firL[p]) >> 6; fr += (c * this.firR[p]) >> 6;
    }
    fl = clamp16(fl) & ~1; fr = clamp16(fr) & ~1;
    let outL = clamp16(((mainL * s8(r[0x0c])) >> 7) + ((fl * s8(r[0x2c])) >> 7));
    let outR = clamp16(((mainR * s8(r[0x1c])) >> 7) + ((fr * s8(r[0x3c])) >> 7));
    if (!(flg & 0x20)) {
      const efb = s8(r[0x0d]);
      const wl = clamp16(echoL + ((fl * efb) >> 7)) & ~1, wr = clamp16(echoR + ((fr * efb) >> 7)) & ~1;
      ram[ea] = wl & 0xff; ram[(ea + 1) & 0xffff] = (wl >> 8) & 0xff;
      ram[(ea + 2) & 0xffff] = wr & 0xff; ram[(ea + 3) & 0xffff] = (wr >> 8) & 0xff;
    }
    this.echoPos += 4;
    if (this.echoPos >= this.echoLen) { this.echoPos = 0; this.echoLen = (r[0x7d] & 15) ? (r[0x7d] & 15) * 2048 : 4; }
    if (flg & 0x40) { outL = 0; outR = 0; }
    if (this.outLen + 2 > this.out.length) { const n = new Int16Array(this.out.length * 2); n.set(this.out); this.out = n; }
    this.out[this.outLen++] = outL; this.out[this.outLen++] = outR;
  }
}
