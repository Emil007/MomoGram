// SSEQ sequence player on Web Audio. Plays sequenced music from a DS sound archive (SDAT) a pack brings.
import { Sdat, Bank, NoteDef, Wave } from './sdat';

const TICK_SEC = (64 * 2728) / 33513982; // DS sequencer update interval (~5.2 ms)

interface Track {
  pc: number; wait: number; active: boolean;
  prog: number; vol: number; expr: number; pan: number; transpose: number;
  bend: number; bendRange: number; tie: boolean; noteWait: boolean;
  attack: number; decay: number; sustain: number; release: number;
  stack: Array<{ pc: number; count: number; loopPc: number }>;
  callStack: number[];
  voices: Voice[];
}

interface Voice { src: AudioScheduledSourceNode; gain: GainNode; pan: StereoPannerNode; end: number; release: number; rate?: number; base?: number }

// DS envelope tables, mapped to approximate times
function attackTime(a: number) { return a >= 127 ? 0 : a >= 109 ? 0.002 * (128 - a) : 0.04 + (109 - a) * 0.012; }
function decayTime(d: number) { return d >= 127 ? 0.001 : 0.02 + Math.pow((127 - d) / 127, 2.2) * 6; }
function releaseTime(r: number) { return r >= 127 ? 0.005 : 0.02 + Math.pow((127 - r) / 127, 2.2) * 6; }
function sustainLevel(s: number) { return s >= 127 ? 1 : Math.pow(10, (-(127 - s) * 0.72) / 20); }
function volCurve(v: number) { return v <= 0 ? 0 : Math.pow(10, (-(127 - v) * 0.36) / 20); }

/** loudness of sequenced DS music against the games' recorded music (measured) */
export let SEQ_LEVEL = 4.5;
export function setSeqLevel(v: number) { SEQ_LEVEL = v; }

export class SeqPlayer {
  private ac: AudioContext;
  private out: GainNode;
  private sdat: Sdat;
  private bank!: Bank;
  private data!: Uint8Array;
  private tracks: Track[] = [];
  private vars = new Int16Array(32);
  private tempo = 120;
  private tempoAcc = 0;
  private seqVol = 127;
  private time = 0;
  private timer = 0;
  private bufCache = new Map<string, AudioBuffer>();
  private loop = true;
  playing = false;

  constructor(ac: AudioContext, out: AudioNode, sdat: Sdat) {
    this.ac = ac;
    this.sdat = sdat;
    this.out = ac.createGain();
    // DS sequences come out much quieter than the recorded streams of the 3DS / Switch games: lifted to match
    const level = ac.createGain();
    level.gain.value = SEQ_LEVEL;
    this.out.connect(level).connect(out);
  }

  play(name: string, loop = true): boolean {
    this.stop();
    const s = this.sdat.seqByName(name);
    if (!s || s.fileId < 0) return false;
    this.loop = loop;
    this.bank = this.sdat.bank(s.bank);
    this.data = this.sdat.seqData(s).data;
    this.seqVol = s.volume;
    this.tracks = [];
    this.vars.fill(-1);
    this.tempo = 120;
    this.tempoAcc = 0;
    this.out.gain.value = 1;
    this.tracks.push(this.newTrack(0));
    this.time = this.ac.currentTime + 0.05;
    this.playing = true;
    this.pump();
    return true;
  }

  stop(fade = 0) {
    this.playing = false;
    clearTimeout(this.timer);
    const now = this.ac.currentTime;
    for (const t of this.tracks) for (const v of t.voices) {
      try { v.gain.gain.cancelScheduledValues(now); v.gain.gain.setTargetAtTime(0, now, fade || 0.02); v.src.stop(now + (fade || 0.02) * 6); } catch { /* already stopped */ }
    }
    this.tracks = [];
  }

  private newTrack(pc: number): Track {
    return { pc, wait: 0, active: true, prog: 0, vol: 127, expr: 127, pan: 64, transpose: 0, bend: 0, bendRange: 2, tie: false, noteWait: true,
      attack: 255, decay: 255, sustain: 255, release: 255, stack: [], callStack: [], voices: [] };
  }

  /** schedule ~250 ms ahead */
  private pump() {
    if (!this.playing) return;
    const horizon = this.ac.currentTime + 0.25;
    while (this.time < horizon && this.playing) {
      this.tempoAcc += this.tempo;
      while (this.tempoAcc >= 240) {
        this.tempoAcc -= 240;
        this.tick();
      }
      this.time += TICK_SEC;
      if (!this.tracks.some(t => t.active)) {
        if (this.loop) { /* sequence ended without loop: stop */ }
        this.playing = false;
      }
    }
    this.timer = window.setTimeout(() => this.pump(), 60);
  }

  private varlen(t: Track): number {
    let v = 0, b: number;
    do { b = this.data[t.pc++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return v;
  }

  private tick() {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (!t.active) continue;
      if (t.wait > 0) { t.wait--; if (t.wait > 0) continue; }
      let guard = 0;
      while (t.active && t.wait === 0 && guard++ < 1000) this.step(t);
    }
  }

  private step(t: Track) {
    const d = this.data;
    const u16 = () => { const v = d[t.pc] | (d[t.pc + 1] << 8); t.pc += 2; return v; };
    const s16 = () => (u16() << 16) >> 16;
    const u24 = () => { const v = d[t.pc] | (d[t.pc + 1] << 8) | (d[t.pc + 2] << 16); t.pc += 3; return v; };
    let cmd = d[t.pc++];
    if (cmd === undefined) { t.active = false; return; }
    // prefixes: random / variable / conditional
    let argOverride: number | null = null, skip = false;
    if (cmd === 0xa0) { cmd = d[t.pc++]; const lo = s16(), hi = s16(); argOverride = lo + Math.floor(Math.random() * (hi - lo + 1)); }
    else if (cmd === 0xa1) { cmd = d[t.pc++]; argOverride = this.vars[d[t.pc++]]; }
    else if (cmd === 0xa2) { cmd = d[t.pc++]; skip = !this.cond; }
    void skip;
    if (cmd < 0x80) {
      const vel = d[t.pc++];
      const dur = argOverride ?? this.varlen(t);
      if (!skip) this.noteOn(t, cmd + t.transpose, vel, dur);
      if (t.noteWait) t.wait = dur;
      return;
    }
    switch (cmd) {
      case 0x80: { const v = argOverride ?? this.varlen(t); if (!skip) t.wait = v; return; }
      case 0x81: { const v = argOverride ?? this.varlen(t); if (!skip) t.prog = v; return; }
      case 0x93: { const n = d[t.pc++]; const off = u24(); if (!skip) { const nt = this.newTrack(off); nt.wait = 0; void n; this.tracks.push(nt); } return; }
      case 0x94: { const off = u24(); if (!skip) { if (!this.loop && off <= t.pc) { t.active = false; return; } t.pc = off; } return; }
      case 0x95: { const off = u24(); if (!skip) { t.callStack.push(t.pc); t.pc = off; } return; }
      case 0xfd: { if (!skip) { const r = t.callStack.pop(); if (r === undefined) t.active = false; else t.pc = r; } return; }
      case 0xd4: { const c = d[t.pc++]; if (!skip) t.stack.push({ pc: t.pc, count: c, loopPc: t.pc }); return; }
      case 0xfc: {
        if (skip) return;
        const top = t.stack[t.stack.length - 1];
        if (!top) return;
        if (top.count === 0) { t.pc = top.loopPc; return; } // infinite
        if (--top.count > 0) t.pc = top.loopPc; else t.stack.pop();
        return;
      }
      case 0xfe: { u16(); return; }
      case 0xff: { t.active = false; return; }
    }
    if (cmd >= 0xb0 && cmd <= 0xbd) {
      const v = d[t.pc++]; const val = argOverride ?? s16();
      if (skip) return;
      const V = this.vars;
      switch (cmd) {
        case 0xb0: V[v] = val; break; case 0xb1: V[v] += val; break; case 0xb2: V[v] -= val; break;
        case 0xb3: V[v] *= val; break; case 0xb4: if (val) V[v] = Math.trunc(V[v] / val); break;
        case 0xb5: V[v] = val >= 0 ? V[v] << val : V[v] >> -val; break;
        case 0xb6: V[v] = Math.floor(Math.random() * (val + 1)); break;
        case 0xb8: this.cond = V[v] === val; break; case 0xb9: this.cond = V[v] >= val; break;
        case 0xba: this.cond = V[v] > val; break; case 0xbb: this.cond = V[v] <= val; break;
        case 0xbc: this.cond = V[v] < val; break; case 0xbd: this.cond = V[v] !== val; break;
      }
      return;
    }
    if (cmd === 0xe0 || cmd === 0xe1 || cmd === 0xe3) {
      const v = argOverride ?? s16();
      if (!skip && cmd === 0xe1) this.tempo = v;
      return;
    }
    // one-byte-argument commands
    const a = argOverride ?? d[t.pc++];
    if (skip) return;
    switch (cmd) {
      case 0xc0: t.pan = a; break;
      case 0xc1: t.vol = a; break;
      case 0xc2: this.seqVol = a; break;
      case 0xc3: t.transpose = (a << 24) >> 24; break;
      case 0xc4: t.bend = (a << 24) >> 24; this.updateBend(t); break;
      case 0xc5: t.bendRange = a; break;
      case 0xc7: t.noteWait = !!a; break;
      case 0xc8: t.tie = !!a; break;
      case 0xd0: t.attack = a; break;
      case 0xd1: t.decay = a; break;
      case 0xd2: t.sustain = a; break;
      case 0xd3: t.release = a; break;
      case 0xd5: t.expr = a; break;
      default: break; // priority, modulation, portamento, sweep: not emulated
    }
  }
  private cond = true;

  private updateBend(t: Track) {
    for (const v of t.voices) if (v.rate !== undefined && 'playbackRate' in v.src) {
      (v.src as AudioBufferSourceNode).playbackRate.setValueAtTime(v.rate * Math.pow(2, (t.bend * t.bendRange) / 128 / 12), Math.max(this.time, this.ac.currentTime));
    }
  }

  private buffer(w: Wave, key: string): AudioBuffer {
    let b = this.bufCache.get(key);
    if (!b) {
      b = this.ac.createBuffer(1, Math.max(1, w.data.length), Math.max(3000, Math.min(96000, w.rate)));
      b.copyToChannel(w.data as Float32Array<ArrayBuffer>, 0);
      this.bufCache.set(key, b);
    }
    return b;
  }

  private psgBuffer(kind: 'psg' | 'noise', duty: number): AudioBuffer {
    const key = kind + duty;
    let b = this.bufCache.get(key);
    if (!b) {
      if (kind === 'noise') {
        b = this.ac.createBuffer(1, 32768, 32768);
        const ch = b.getChannelData(0);
        let lfsr = 0x7fff;
        for (let i = 0; i < ch.length; i++) { const bit = lfsr & 1; lfsr >>= 1; if (bit) lfsr ^= 0x6000; ch[i] = bit ? 0.5 : -0.5; }
      } else {
        // 8-step square, duty (n+1)/8; one cycle per 8 samples at 440*8 Hz for A4 (note 69)
        b = this.ac.createBuffer(1, 8, 8 * 440);
        const ch = b.getChannelData(0);
        for (let i = 0; i < 8; i++) ch[i] = i <= duty ? 0.5 : -0.5;
      }
      this.bufCache.set(key, b);
    }
    return b;
  }

  private noteOn(t: Track, note: number, vel: number, dur: number) {
    const ins = this.bank.instruments[t.prog];
    if (!ins) return;
    const reg = ins.regions.find(r => note >= r.lo && note <= r.hi) ?? ins.regions[ins.regions.length - 1];
    if (!reg) return;
    const def: NoteDef = reg.def;
    const ac = this.ac;
    const start = Math.max(this.time, ac.currentTime);
    let src: AudioBufferSourceNode;
    let rate = 1;
    if (def.kind === 'pcm') {
      const arc = this.bank.waveArcs[def.swar];
      const waves = this.sdat.waves(arc);
      const w = waves[def.swav];
      if (!w || !w.data.length) return;
      src = ac.createBufferSource();
      src.buffer = this.buffer(w, arc + ':' + def.swav);
      if (w.loop) { src.loop = true; src.loopStart = w.loopStart / src.buffer.sampleRate; src.loopEnd = w.data.length / src.buffer.sampleRate; }
      rate = Math.pow(2, (note - def.baseNote) / 12) * (w.rate / src.buffer.sampleRate);
    } else {
      src = ac.createBufferSource();
      src.buffer = this.psgBuffer(def.kind, def.duty);
      src.loop = true;
      rate = def.kind === 'noise' ? Math.pow(2, (note - 60) / 12) : Math.pow(2, (note - 69) / 12);
    }
    src.playbackRate.value = rate * Math.pow(2, (t.bend * t.bendRange) / 128 / 12);
    const g = ac.createGain();
    const p = ac.createStereoPanner();
    const pan = ((t.pan - 64) + (def.pan - 64)) / 64;
    p.pan.value = Math.max(-1, Math.min(1, pan));
    const atk = t.attack !== 255 ? t.attack : def.attack, dec = t.decay !== 255 ? t.decay : def.decay;
    const sus = t.sustain !== 255 ? t.sustain : def.sustain, rel = t.release !== 255 ? t.release : def.release;
    const peak = volCurve(vel) * volCurve(t.vol) * volCurve(t.expr) * volCurve(this.seqVol) * 1.6 * (def.kind === 'pcm' ? 1 : 0.35);
    const at = attackTime(atk), dt = decayTime(dec), sl = sustainLevel(sus), rt = releaseTime(rel);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + at + 0.001);
    g.gain.setTargetAtTime(peak * sl, start + at, dt / 4);
    src.connect(g).connect(p).connect(this.out);
    src.start(start);
    const v: Voice = { src, gain: g, pan: p, end: 0, release: rt, rate: rate, base: def.baseNote };
    if (!t.tie && dur > 0) {
      const off = start + dur * TICK_SEC * (240 / Math.max(1, this.tempo));
      g.gain.cancelScheduledValues(off);
      g.gain.setTargetAtTime(0, off, rt / 4);
      src.stop(off + rt * 1.2 + 0.05);
      v.end = off;
    } else if (t.tie) {
      // tie mode: the previous note is replaced by this one
      for (const o of t.voices) { try { o.gain.gain.setTargetAtTime(0, start, 0.01); o.src.stop(start + 0.1); } catch { /* */ } }
      t.voices = [];
    }
    t.voices.push(v);
    src.onended = () => { const i = t.voices.indexOf(v); if (i >= 0) t.voices.splice(i, 1); };
  }
}
