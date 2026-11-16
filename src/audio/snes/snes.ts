// A minimal Super Famicom for sound purposes: 65C816 + WRAM + cartridge mapping (LoROM / HiROM) + the CPU
// registers a game touches during start-up (NMI / IRQ timing, multiply / divide, DMA, joypads, the WRAM port)
// + the SPC700 sound system. Nothing is drawn: PPU registers are accepted and ignored.
// Used when importing a pack, to let the game itself upload its sound program and start songs. MIT licence.
import { W65816 } from './w65816';
import { Spc } from './spc700';

const MASTER_PER_LINE = 1364, LINES = 262, VBLANK_LINE = 225;
const MASTER_PER_SPC = 21477272 / 1024000;

export class Snes {
  readonly rom: Uint8Array;
  readonly hirom: boolean;
  wram = new Uint8Array(0x20000);
  sram: Uint8Array;
  readonly cpu: W65816;
  readonly spc: Spc;
  private wmadd = 0;
  private nmitimen = 0; private rdnmi = 0; private timeup = 0; private vtime = 0x1ff; private htime = 0x1ff;
  private wrmpya = 0xff; private wrdiv = 0xffff; private rddiv = 0; private rdmpy = 0;
  private dma = new Uint8Array(0x80);
  private line = 0; private lineStart = 0;
  frame = 0;
  /** held joypad buttons (SNES order: B Y Select Start Up Down Left Right A X L R in bits 15..4) */
  buttons = 0;
  /** writes to $2140-$2143 (analysis) */
  onPortWrite: ((port: number, v: number, s: Snes) => void) | null = null;

  constructor(rom: Uint8Array) {
    // drop a 512-byte copier header
    this.rom = rom.length % 0x8000 === 512 ? rom.subarray(512) : rom;
    this.hirom = Snes.isHiRom(this.rom);
    // cartridge RAM size from the header (games test that it mirrors correctly)
    const ramSize = this.rom[(this.hirom ? 0xffc0 : 0x7fc0) + 0x18];
    this.sram = new Uint8Array(ramSize > 0 && ramSize <= 8 ? 1024 << ramSize : 0x800);
    this.cpu = new W65816(this);
    this.spc = new Spc();
    this.cpu.reset();
  }

  /** HiROM if the reset vector in the $FFxx header area points into ROM code and the LoROM one does not */
  static isHiRom(rom: Uint8Array): boolean {
    if (rom.length < 0x10000) return false;
    const score = (base: number) => {
      const reset = rom[base + 0x3c] | (rom[base + 0x3d] << 8);
      let s = reset >= 0x8000 ? 2 : -4;
      const mode = rom[base + 0x15];
      if ((mode & 0xef) === (base === 0xffc0 ? 0x21 : 0x20)) s += 2;
      const csum = rom[base + 0x1c] | (rom[base + 0x1d] << 8), comp = rom[base + 0x1e] | (rom[base + 0x1f] << 8);
      if ((csum ^ comp) === 0xffff) s += 3;
      return s;
    };
    return score(0xffc0) > score(0x7fc0);
  }

  private romAddr(bank: number, off: number): number {
    if (this.hirom) return (((bank & 0x3f) << 16) | off) % this.rom.length;
    return ((((bank & 0x7f) << 15) | (off & 0x7fff)) >>> 0) % this.rom.length;
  }

  // ------------------------------------------------------------------ bus
  read(a: number): number {
    const bank = a >> 16, off = a & 0xffff;
    if (bank === 0x7e || bank === 0x7f) return this.wram[a - 0x7e0000];
    if (!(bank & 0x40)) {
      if (off < 0x2000) return this.wram[off];
      if (off < 0x8000) {
        if (off >= 0x2140 && off < 0x2180) { this.sync(); return this.spc.portOut[off & 3]; }
        if (off >= 0x6000 && this.hirom && (bank & 0x7f) >= 0x20) return this.sram[(((bank & 0x1f) << 13) | (off - 0x6000)) & (this.sram.length - 1)];
        return this.readIo(off);
      }
      return this.rom[this.romAddr(bank, off)];
    }
    if (!this.hirom && (bank & 0x7f) >= 0x70 && (bank & 0x7f) < 0x7e && off < 0x8000) return this.sram[(((bank & 0xf) << 15) | off) & (this.sram.length - 1)];
    return this.rom[this.romAddr(bank, off)];
  }

  write(a: number, v: number) {
    const bank = a >> 16, off = a & 0xffff;
    if (bank === 0x7e || bank === 0x7f) { this.wram[a - 0x7e0000] = v; return; }
    if (!(bank & 0x40)) {
      if (off < 0x2000) { this.wram[off] = v; return; }
      if (off < 0x8000) {
        if (off >= 0x2140 && off < 0x2180) { this.sync(); this.spc.portIn[off & 3] = v; this.onPortWrite?.(off & 3, v, this); return; }
        if (off >= 0x6000 && this.hirom && (bank & 0x7f) >= 0x20) { this.sram[(((bank & 0x1f) << 13) | (off - 0x6000)) & (this.sram.length - 1)] = v; return; }
        this.writeIo(off, v);
      }
      return;
    }
    if (!this.hirom && (bank & 0x7f) >= 0x70 && (bank & 0x7f) < 0x7e && off < 0x8000) this.sram[(((bank & 0xf) << 15) | off) & (this.sram.length - 1)] = v;
  }

  private get vblank() { return this.line >= VBLANK_LINE; }

  private readIo(off: number): number {
    switch (off) {
      case 0x2180: { const v = this.wram[this.wmadd]; this.wmadd = (this.wmadd + 1) & 0x1ffff; return v; }
      case 0x213e: return 0x01;
      case 0x213f: return 0x01 | ((this.frame & 1) << 7);
      case 0x4016: case 0x4017: return 0;
      case 0x4210: { const v = this.rdnmi | 0x02; this.rdnmi = 0; return v; }
      case 0x4211: { const v = this.timeup; this.timeup = 0; this.cpu.irq = false; return v; }
      case 0x4212: {
        const h = (this.cpu.cycles - this.lineStart) > 1096;
        return (this.vblank ? 0x80 : 0) | (h ? 0x40 : 0) | (this.vblank && this.line < VBLANK_LINE + 3 && (this.nmitimen & 1) ? 1 : 0);
      }
      case 0x4214: return this.rddiv & 0xff;
      case 0x4215: return this.rddiv >> 8;
      case 0x4216: return this.rdmpy & 0xff;
      case 0x4217: return this.rdmpy >> 8;
      case 0x4218: case 0x421a: case 0x421c: case 0x421e: return off === 0x4218 ? this.buttons & 0xff : 0;
      case 0x4219: case 0x421b: case 0x421d: case 0x421f: return off === 0x4219 ? this.buttons >> 8 : 0;
    }
    if (off >= 0x4300 && off < 0x4380) return this.dma[off - 0x4300];
    return 0;
  }

  private writeIo(off: number, v: number) {
    switch (off) {
      case 0x2180: this.wram[this.wmadd] = v; this.wmadd = (this.wmadd + 1) & 0x1ffff; return;
      case 0x2181: this.wmadd = (this.wmadd & 0x1ff00) | v; return;
      case 0x2182: this.wmadd = (this.wmadd & 0x100ff) | (v << 8); return;
      case 0x2183: this.wmadd = (this.wmadd & 0xffff) | ((v & 1) << 16); return;
      case 0x4200: this.nmitimen = v; if (!(v & 0x30)) { this.cpu.irq = false; this.timeup = 0; } return;
      case 0x4202: this.wrmpya = v; return;
      case 0x4203: this.rdmpy = this.wrmpya * v; this.rddiv = v; return;
      case 0x4204: this.wrdiv = (this.wrdiv & 0xff00) | v; return;
      case 0x4205: this.wrdiv = (this.wrdiv & 0xff) | (v << 8); return;
      case 0x4206: if (v) { this.rddiv = Math.floor(this.wrdiv / v); this.rdmpy = this.wrdiv % v; } else { this.rddiv = 0xffff; this.rdmpy = this.wrdiv; } return;
      case 0x4207: this.htime = (this.htime & 0x100) | v; return;
      case 0x4208: this.htime = (this.htime & 0xff) | ((v & 1) << 8); return;
      case 0x4209: this.vtime = (this.vtime & 0x100) | v; return;
      case 0x420a: this.vtime = (this.vtime & 0xff) | ((v & 1) << 8); return;
      case 0x420b: this.runDma(v); return;
    }
    if (off >= 0x4300 && off < 0x4380) this.dma[off - 0x4300] = v;
  }

  private runDma(mask: number) {
    const PATTERN = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];
    for (let ch = 0; ch < 8; ch++) {
      if (!((mask >> ch) & 1)) continue;
      const r = this.dma.subarray(ch * 16, ch * 16 + 16);
      const ctrl = r[0], bbad = r[1];
      let addr = r[2] | (r[3] << 8);
      const bank = r[4];
      let count = r[5] | (r[6] << 8) || 0x10000;
      const pat = PATTERN[ctrl & 7], step = ctrl & 8 ? 0 : ctrl & 0x10 ? -1 : 1;
      let i = 0;
      while (count--) {
        const b = 0x2100 | ((bbad + pat[i++ % pat.length]) & 0xff), aa = (bank << 16) | addr;
        if (ctrl & 0x80) this.write(aa, this.read(b)); else this.write(b, this.read(aa));
        addr = (addr + step) & 0xffff;
        this.cpu.cycles += 8;
      }
      r[2] = addr & 0xff; r[3] = addr >> 8; r[5] = 0; r[6] = 0;
    }
  }

  /** bring the SPC up to the CPU's time */
  sync() { this.spc.run(this.cpu.cycles / MASTER_PER_SPC); }

  /**
   * run a small machine-code routine of our own (e.g. "call the game's play-song function, then STP") with the
   * game's interrupts off; returns false if it did not finish within `maxFrames`
   */
  callCode(code: number[], maxFrames = 600): boolean {
    const cpu = this.cpu, base = 0x7fff00;
    code.forEach((b, i) => { this.wram[base - 0x7e0000 + i] = b; });
    this.nmitimen = 0; cpu.irq = false; cpu.nmi = false;
    cpu.e = false; cpu.p = 0x34; cpu.pb = base >> 16; cpu.pc = base & 0xffff; cpu.s = 0x1ff0; cpu.stopped = false; cpu.waiting = false;
    const end = this.frame + maxFrames;
    while (!cpu.stopped && this.frame < end) {
      cpu.step();
      while (cpu.cycles - this.lineStart >= MASTER_PER_LINE) {
        this.lineStart += MASTER_PER_LINE;
        if (++this.line === VBLANK_LINE) this.rdnmi = 0x80;
        if (this.line >= LINES) { this.line = 0; this.rdnmi = 0; this.frame++; }
      }
    }
    this.sync();
    const ok = cpu.stopped;
    cpu.stopped = false;
    return ok;
  }

  /** let only the sound system run for `frames` frames (the main CPU stays halted) */
  runSpcFrames(frames: number) {
    for (let i = 0; i < frames; i++) { this.cpu.cycles += MASTER_PER_LINE * LINES; this.sync(); }
    this.lineStart = this.cpu.cycles; this.line = 0;
  }

  /** run the CPU for one frame (with NMI / IRQ timing) */
  runFrame() {
    const cpu = this.cpu;
    for (;;) {
      cpu.step();
      while (cpu.cycles - this.lineStart >= MASTER_PER_LINE) {
        this.lineStart += MASTER_PER_LINE;
        this.line++;
        if (this.line === VBLANK_LINE) { this.rdnmi = 0x80; if (this.nmitimen & 0x80) cpu.nmi = true; }
        if ((this.nmitimen & 0x20) && this.line === this.vtime) { this.timeup = 0x80; cpu.irq = true; }
        else if ((this.nmitimen & 0x30) === 0x10) { this.timeup = 0x80; cpu.irq = true; }
        if (this.line >= LINES) { this.line = 0; this.rdnmi = 0; this.frame++; this.sync(); return; }
      }
    }
  }
}
