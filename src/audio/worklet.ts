// AudioWorklet that runs a sound chip emulation (see chip.ts) on the audio thread. Built as its own file
// (worklet.js) by build.mjs.
import { ChipEngine, ChipKind, createEngine } from './chip';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }

export type ChipMessage =
  | { type: 'play'; kind: ChipKind; key: string; data?: Uint8Array; song: number; epoch?: number }
  | { type: 'stop' };

class ChipProcessor extends AudioWorkletProcessor {
  private engine: ChipEngine | null = null;
  private data = new Map<string, Uint8Array>();
  private buf = new Float32Array(256);
  private epoch = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ChipMessage>) => {
      const m = e.data;
      if (m.type === 'stop') { this.engine = null; return; }
      if (m.data) { this.data.set(m.key, m.data); if (this.data.size > 4) this.data.delete(this.data.keys().next().value!); }
      const d = this.data.get(m.key);
      if (!d) { this.port.postMessage({ type: 'need', key: m.key }); return; }
      this.epoch = m.epoch ?? this.epoch;
      try { this.engine = createEngine(m.kind, d, m.song, sampleRate); this.port.postMessage({ type: 'playing', key: m.key }); }
      catch (err) { this.engine = null; this.port.postMessage({ type: 'error', message: String(err), epoch: this.epoch }); }
    };
  }

  private silence(out: Float32Array[]) {
    out[0].fill(0);
    if (out[1] && out[1] !== out[0]) out[1].fill(0);
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    // no engine yet (node is connected before the play message): an untouched buffer is noise
    if (!out?.[0]?.length) return true;
    if (!this.engine) { this.silence(out); return true; }
    const n = out[0].length;
    if (this.buf.length < n * 2) this.buf = new Float32Array(n * 2);
    try { this.engine.render(this.buf, n); } catch (err) {
      this.engine = null;
      this.silence(out);
      this.port.postMessage({ type: 'error', message: String(err), epoch: this.epoch });
      return true;
    }
    const l = out[0], r = out[1] ?? out[0], b = this.buf;
    for (let i = 0; i < n; i++) { l[i] = b[i * 2]; r[i] = b[i * 2 + 1]; }
    return true;
  }
}

registerProcessor('momo-chip', ChipProcessor);
