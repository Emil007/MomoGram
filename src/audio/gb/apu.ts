// Game Boy APU: two pulse channels (the first with frequency sweep), a 4-bit wave channel and an LFSR noise
// channel, with length counters, volume envelopes, the 512 Hz frame sequencer, NR50/NR51 mixing and the output
// high-pass filter. Event-driven: the emulation catches up to the CPU's time on every register access and the
// output is box-filtered per sample (cheap band-limiting).
// Written from the public hardware documentation (Pan Docs, gbdev.io "Game Boy sound hardware"). MIT licence.

export const GB_CLOCK = 4194304;
const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
// read-back OR masks for FF10..FF3F
const READ_OR = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff,
  0xff, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

class Chan {
  on = false; dac = false;
  length = 0; lengthOn = false;
  vol = 0; envPeriod = 0; envUp = false; envTimer = 0;
  timer = 0; // cycles until the next waveform step
  freq = 0;
  out = 0; // current digital output 0..15
}

export class GbApu {
  regs = new Uint8Array(0x30); // FF10..FF3F
  wave = new Uint8Array(16);
  power = true;
  readonly ch = [new Chan(), new Chan(), new Chan(), new Chan()];
  // pulse
  duty = [0, 0]; dutyPos = [0, 0];
  // sweep (channel 1)
  sweepPeriod = 0; sweepDown = false; sweepShift = 0; sweepTimer = 0; sweepOn = false; shadow = 0;
  // wave
  wavePos = 0; waveShift = 4;
  // noise
  lfsr = 0x7fff; noiseWidth7 = false;
  // frame sequencer
  fsTimer = 8192; fsStep = 0;
  // time
  time = 0; // APU cycles already emulated
  private readonly cps: number; // cycles per output sample
  private sampleLeft: number;
  private accL = 0; private accR = 0;
  private capL = 0; private capR = 0; private readonly charge: number;
  out: Float32Array; outLen = 0; // interleaved stereo
  /** per-channel time with audible output (analysis) */
  activity = new Float64Array(4);
  muted = 0; // bit mask

  constructor(readonly sampleRate: number) {
    this.cps = GB_CLOCK / sampleRate;
    this.sampleLeft = this.cps;
    this.charge = Math.pow(0.999958, this.cps);
    this.out = new Float32Array(8192);
  }

  // ------------------------------------------------------------------ registers
  read(r: number, now: number): number {
    this.advance(now);
    const i = r - 0x10;
    if (r >= 0x30) return this.ch[2].on ? 0xff : this.wave[r - 0x30];
    if (r === 0x26) return (this.power ? 0x80 : 0) | 0x70 | this.ch.reduce((m, c, k) => m | (c.on ? 1 << k : 0), 0);
    return this.regs[i] | READ_OR[i];
  }

  write(r: number, v: number, now: number) {
    this.advance(now);
    if (r >= 0x30) { this.wave[r - 0x30] = v; return; }
    if (r === 0x26) {
      const on = (v & 0x80) !== 0;
      if (!on && this.power) { for (let i = 0; i < 0x16; i++) this.writeReg(0x10 + i, 0); for (const c of this.ch) c.on = false; }
      if (on && !this.power) { this.fsStep = 0; this.fsTimer = 8192; this.dutyPos = [0, 0]; }
      this.power = on;
      return;
    }
    if (!this.power) { // only length counters are writable while off (DMG)
      if (r === 0x11 || r === 0x16 || r === 0x20) this.ch[r === 0x11 ? 0 : r === 0x16 ? 1 : 3].length = 64 - (v & 63);
      else if (r === 0x1b) this.ch[2].length = 256 - v;
      return;
    }
    this.writeReg(r, v);
  }

  private writeReg(r: number, v: number) {
    this.regs[r - 0x10] = v;
    const ch = this.ch;
    switch (r) {
      case 0x10: this.sweepPeriod = (v >> 4) & 7; this.sweepDown = (v & 8) !== 0; this.sweepShift = v & 7; break;
      case 0x11: case 0x16: { const k = r === 0x11 ? 0 : 1; this.duty[k] = v >> 6; ch[k].length = 64 - (v & 63); break; }
      case 0x12: case 0x17: case 0x21: {
        const c = ch[r === 0x12 ? 0 : r === 0x17 ? 1 : 3];
        c.dac = (v & 0xf8) !== 0; if (!c.dac) c.on = false;
        break;
      }
      case 0x13: case 0x18: { const c = ch[r === 0x13 ? 0 : 1]; c.freq = (c.freq & 0x700) | v; break; }
      case 0x14: case 0x19: case 0x1e: {
        const k = r === 0x14 ? 0 : r === 0x19 ? 1 : 2, c = ch[k];
        c.freq = (c.freq & 0xff) | ((v & 7) << 8);
        this.lengthEnable(c, (v & 0x40) !== 0, k === 2 ? 256 : 64);
        if (v & 0x80) this.trigger(k);
        break;
      }
      case 0x1a: ch[2].dac = (v & 0x80) !== 0; if (!ch[2].dac) ch[2].on = false; break;
      case 0x1b: ch[2].length = 256 - v; break;
      case 0x1c: this.waveShift = [4, 0, 1, 2][(v >> 5) & 3]; break;
      case 0x1d: ch[2].freq = (ch[2].freq & 0x700) | v; break;
      case 0x20: ch[3].length = 64 - (v & 63); break;
      case 0x22: this.noiseWidth7 = (v & 8) !== 0; break;
      case 0x23: this.lengthEnable(ch[3], (v & 0x40) !== 0, 64); if (v & 0x80) this.trigger(3); break;
    }
  }

  /** length enable with the "extra clock" quirk when enabled during the first half of a length period */
  private lengthEnable(c: Chan, en: boolean, max: number) {
    const firstHalf = (this.fsStep & 1) === 1; // the next step does not clock length
    if (en && !c.lengthOn && firstHalf && c.length > 0) { c.length--; if (c.length === 0) c.on = false; }
    c.lengthOn = en;
    void max;
  }

  private trigger(k: number) {
    const c = this.ch[k], r = this.regs;
    c.on = c.dac;
    if (c.length === 0) c.length = k === 2 ? 256 : 64;
    if (k === 2) { c.timer = (2048 - c.freq) * 2 + 6; this.wavePos = 0; return; }
    const env = r[k === 0 ? 2 : k === 1 ? 7 : 0x11];
    c.vol = env >> 4; c.envUp = (env & 8) !== 0; c.envPeriod = env & 7; c.envTimer = c.envPeriod || 8;
    if (k === 3) { this.lfsr = 0x7fff; c.timer = this.noisePeriod(); return; }
    c.timer = (2048 - c.freq) * 4;
    if (k === 0) {
      this.shadow = c.freq;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepOn = this.sweepPeriod > 0 || this.sweepShift > 0;
      if (this.sweepShift) this.sweepCalc();
    }
  }

  private noisePeriod(): number {
    const v = this.regs[0x12];
    const div = (v & 7) ? (v & 7) * 16 : 8;
    return div << (v >> 4);
  }

  private sweepCalc(): number {
    const d = this.shadow >> this.sweepShift;
    const f = this.sweepDown ? this.shadow - d : this.shadow + d;
    if (f > 2047) this.ch[0].on = false;
    return f;
  }

  // ------------------------------------------------------------------ frame sequencer
  private frameStep() {
    const s = this.fsStep;
    this.fsStep = (s + 1) & 7;
    if ((s & 1) === 0) for (const c of this.ch) if (c.lengthOn && c.length > 0 && --c.length === 0) c.on = false;
    if (s === 2 || s === 6) {
      if (--this.sweepTimer <= 0) {
        this.sweepTimer = this.sweepPeriod || 8;
        if (this.sweepOn && this.sweepPeriod) {
          const f = this.sweepCalc();
          if (f <= 2047 && this.sweepShift) {
            this.shadow = f; this.ch[0].freq = f;
            this.regs[3] = f & 0xff; this.regs[4] = (this.regs[4] & 0xf8) | (f >> 8);
            this.sweepCalc();
          }
        }
      }
    }
    if (s === 7) {
      for (let k = 0; k < 4; k++) {
        if (k === 2) continue;
        const c = this.ch[k];
        if (!c.envPeriod) continue;
        if (--c.envTimer <= 0) {
          c.envTimer = c.envPeriod;
          if (c.envUp && c.vol < 15) c.vol++; else if (!c.envUp && c.vol > 0) c.vol--;
        }
      }
    }
  }

  // ------------------------------------------------------------------ synthesis
  private levels(): void {
    const c = this.ch;
    c[0].out = c[0].on && ((DUTY[this.duty[0]] >> (7 - this.dutyPos[0])) & 1) ? c[0].vol : 0;
    c[1].out = c[1].on && ((DUTY[this.duty[1]] >> (7 - this.dutyPos[1])) & 1) ? c[1].vol : 0;
    if (c[2].on) { const b = this.wave[this.wavePos >> 1]; c[2].out = ((this.wavePos & 1) ? b & 15 : b >> 4) >> this.waveShift; } else c[2].out = 0;
    c[3].out = c[3].on && !(this.lfsr & 1) ? c[3].vol : 0;
  }

  /** emulate up to APU time `now` */
  advance(now: number) {
    let dt = now - this.time;
    if (dt <= 0) return;
    this.time = now;
    const c = this.ch;
    while (dt > 0) {
      // time to the next event
      let step = dt;
      if (this.sampleLeft < step) step = this.sampleLeft;
      if (this.fsTimer < step) step = this.fsTimer;
      for (let k = 0; k < 4; k++) if (c[k].on && c[k].timer < step) step = c[k].timer;
      if (step < 0) step = 0;
      // accumulate the current output level over `step`
      this.levels();
      const nr50 = this.regs[0x14], nr51 = this.regs[0x15];
      let l = 0, r = 0;
      for (let k = 0; k < 4; k++) {
        const ck = c[k];
        if (!ck.dac || (this.muted >> k) & 1) continue;
        const a = ck.out / 15;
        if (nr51 & (0x10 << k)) l += a;
        if (nr51 & (1 << k)) r += a;
        if (ck.on && ck.out) this.activity[k] += step;
      }
      l *= ((nr50 >> 4) & 7) + 1; r *= (nr50 & 7) + 1;
      this.accL += l * step; this.accR += r * step;
      dt -= step;
      this.sampleLeft -= step;
      this.fsTimer -= step;
      for (let k = 0; k < 4; k++) {
        const ck = c[k];
        if (!ck.on) continue;
        ck.timer -= step;
        while (ck.timer <= 0) {
          if (k < 2) { ck.timer += (2048 - ck.freq) * 4; this.dutyPos[k] = (this.dutyPos[k] + 1) & 7; }
          else if (k === 2) { ck.timer += (2048 - ck.freq) * 2; this.wavePos = (this.wavePos + 1) & 31; }
          else {
            ck.timer += this.noisePeriod();
            const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
            this.lfsr = (this.lfsr >> 1) | (x << 14);
            if (this.noiseWidth7) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
          }
        }
      }
      if (this.fsTimer <= 0) { this.fsTimer += 8192; this.frameStep(); }
      if (this.sampleLeft <= 1e-9) { this.sampleLeft += this.cps; this.emit(); }
    }
  }

  private emit() {
    // 4 channels x 8 master steps at full scale = 32 (unipolar DAC model); scale, then remove DC like the hardware
    let l = this.accL / this.cps / 32 * 1.5, r = this.accR / this.cps / 32 * 1.5;
    this.accL = 0; this.accR = 0;
    const ol = l - this.capL; this.capL = l - ol * this.charge; l = ol;
    const or = r - this.capR; this.capR = r - or * this.charge; r = or;
    if (this.outLen + 2 > this.out.length) { const n = new Float32Array(this.out.length * 2); n.set(this.out); this.out = n; }
    this.out[this.outLen++] = l; this.out[this.outLen++] = r;
  }

  /** remove and return the first `frames` stereo frames */
  take(dst: Float32Array, frames: number): number {
    const n = Math.min(frames * 2, this.outLen);
    dst.set(this.out.subarray(0, n));
    this.out.copyWithin(0, n, this.outLen);
    this.outLen -= n;
    return n / 2;
  }
}
