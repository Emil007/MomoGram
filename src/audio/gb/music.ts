// Plays a Game Boy game's music the way a GBS player does: the game's own sound driver runs on the emulated CPU,
// MomoGram only calls its "start song" routine once and its per-frame update routine at the game's rate.
import { Gb } from './gb';
import { GB_CLOCK } from './apu';

/** a call into the game's code with some registers set */
export interface GbCall { pc: number; a?: number; b?: number; c?: number; d?: number; e?: number; h?: number; l?: number }

/** how a game's sound driver is driven; found by tracing each game (see the game tables in gbgames.ts) */
export interface GbDriver {
  /** calls made once before a song starts (driver reset); `$song` in a register means the song number */
  init: GbCall[];
  /** calls that start song `n` */
  start: (n: number) => GbCall[];
  /** per-frame update */
  update: GbCall;
  /** update calls per second (VBlank = 59.73) */
  rate: number;
  /** run as a Game Boy Color (double speed allowed) */
  cgb?: boolean;
  /** RAM range that holds the driver state (for loop detection in analysis tools) */
  state?: [number, number];
}

export class GbMusic {
  readonly gb: Gb;
  private frameCycles: number;
  private nextFrame = 0;
  ok = true;

  constructor(rom: Uint8Array, readonly driver: GbDriver, sampleRate: number) {
    this.gb = new Gb(rom, sampleRate, driver.cgb);
    this.frameCycles = GB_CLOCK / driver.rate;
  }

  private callFn(c: GbCall) {
    const g = this.gb;
    g.ime = false; g.ie = 0; g.if_ = 0;
    if (c.a !== undefined) g.a = c.a; if (c.b !== undefined) g.b = c.b; if (c.c !== undefined) g.c = c.c;
    if (c.d !== undefined) g.d = c.d; if (c.e !== undefined) g.e = c.e; if (c.h !== undefined) g.h = c.h; if (c.l !== undefined) g.l = c.l;
    g.sp = 0xfffe;
    if (!g.call(c.pc, 2_000_000)) this.ok = false;
  }

  /** start song `n` from a clean driver state */
  start(n: number) {
    for (const c of this.driver.init) this.callFn(c);
    for (const c of this.driver.start(n)) this.callFn(c);
    this.nextFrame = this.gb.apuNow() + this.frameCycles;
  }

  /** advance one driver frame */
  frame() {
    this.callFn(this.driver.update);
    // the CPU idles until the next frame: just move the clock on
    const g = this.gb;
    const now = g.apuNow();
    if (now < this.nextFrame) g.cycles += (this.nextFrame - now) * (g.doubleSpeed ? 2 : 1);
    this.nextFrame += this.frameCycles;
  }

  /** render `frames` stereo frames into dst (interleaved) */
  render(dst: Float32Array, frames: number) {
    const apu = this.gb.apu;
    while (apu.outLen < frames * 2) {
      this.frame();
      apu.advance(this.gb.apuNow());
    }
    apu.take(dst, frames);
  }
}
