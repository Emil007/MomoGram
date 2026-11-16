// Game Boy / Game Boy Color machine for music playback: Sharp LR35902 CPU, MBC1/MBC3/MBC5 banking, timer,
// interrupts, and just enough LCD timing (LY, STAT, VBlank) for a game's code to run. Nothing is drawn.
// Written from the public hardware documentation (Pan Docs, gbdev.io). MIT licence, part of MomoGram.
import { GbApu } from './apu';

export const IRQ_VBLANK = 1, IRQ_STAT = 2, IRQ_TIMER = 4, IRQ_SERIAL = 8, IRQ_JOYPAD = 16;
const F_Z = 0x80, F_N = 0x40, F_H = 0x20, F_C = 0x10;

export class Gb {
  // registers
  a = 0x11; f = 0xb0; b = 0; c = 0x13; d = 0; e = 0xd8; h = 1; l = 0x4d; sp = 0xfffe; pc = 0x100;
  ime = false; eiDelay = 0; halted = false; stopped = false;
  // memory
  readonly rom: Uint8Array;
  romBank = 1; ramBank = 0; ramOn = false; mbc1Mode = 0; mbc1Hi = 0;
  readonly mbc: number; // 0 none, 1 MBC1, 3 MBC3, 5 MBC5
  readonly romMask: number;
  vram = new Uint8Array(0x4000); vbank = 0;
  eram = new Uint8Array(0x20000);
  wram = new Uint8Array(0x8000); wbank = 1;
  oam = new Uint8Array(0xa0);
  hram = new Uint8Array(0x80);
  io = new Uint8Array(0x80);
  ie = 0; if_ = 0xe1;
  /** held buttons: A B Select Start Right Left Up Down (bit 0..7) */
  buttons = 0;
  readonly cgb: boolean;
  doubleSpeed = false;
  // timing
  /** total CPU cycles (T-cycles at the current speed) */
  cycles = 0;
  divCounter = 0;
  lineCycles = 0; ly = 0;
  readonly apu: GbApu;
  /** called for every executed instruction when set (analysis tools only) */
  trace: ((g: Gb) => void) | null = null;
  onWrite: ((addr: number, v: number) => void) | null = null;
  /** switchable ROM banks read so far, when set (to keep only the sound banks of a ROM) */
  banksRead: Set<number> | null = null;

  constructor(rom: Uint8Array, sampleRate: number, cgbMode?: boolean) {
    this.rom = rom;
    const t = rom[0x147];
    this.mbc = t === 0 ? 0 : t <= 3 ? 1 : t >= 0x0f && t <= 0x13 ? 3 : t >= 0x19 && t <= 0x1e ? 5 : 1;
    let banks = 2;
    while (banks * 0x4000 < rom.length) banks <<= 1;
    this.romMask = banks - 1;
    this.cgb = cgbMode ?? (rom[0x143] & 0x80) !== 0;
    if (this.cgb) this.a = 0x11;
    this.apu = new GbApu(sampleRate);
    this.io[0x40] = 0x91; this.io[0x47] = 0xfc;
  }

  // ------------------------------------------------------------------ bus
  read(a: number): number {
    switch (a >> 12) {
      case 0: case 1: case 2: case 3:
        if (this.mbc === 1 && this.mbc1Mode) return this.rom[(((this.mbc1Hi << 5) & this.romMask) * 0x4000 + a) % this.rom.length];
        return this.rom[a];
      case 4: case 5: case 6: case 7:
        if (this.banksRead) this.banksRead.add(this.romBank & this.romMask);
        return this.rom[((this.romBank & this.romMask) * 0x4000 + (a - 0x4000)) % this.rom.length];
      case 8: case 9: return this.vram[this.vbank * 0x2000 + (a - 0x8000)];
      case 0xa: case 0xb: return this.ramOn ? this.eram[(this.ramBank * 0x2000 + (a - 0xa000)) & 0x1ffff] : 0xff;
      case 0xc: return this.wram[a - 0xc000];
      case 0xd: return this.wram[this.wbank * 0x1000 + (a - 0xd000)];
      case 0xe: return this.wram[a - 0xe000];
      default:
        if (a < 0xfe00) return this.wram[this.wbank * 0x1000 + (a - 0xf000)];
        if (a < 0xfea0) return this.oam[a - 0xfe00];
        if (a < 0xff00) return 0xff;
        if (a >= 0xff80) return a === 0xffff ? this.ie : this.hram[a - 0xff80];
        return this.readIo(a & 0x7f);
    }
  }

  readIo(r: number): number {
    if (r >= 0x10 && r < 0x40) return this.apu.read(r, this.apuNow());
    switch (r) {
      case 0x00: { // joypad (analysis tools can hold buttons; playback never does)
        const sel = this.io[0] & 0x30;
        let k = 0x0f;
        if (!(sel & 0x20)) k &= ~(this.buttons & 15);
        if (!(sel & 0x10)) k &= ~(this.buttons >> 4);
        return 0xc0 | sel | k;
      }
      case 0x04: return (this.divCounter >> 8) & 0xff;
      case 0x0f: return this.if_ | 0xe0;
      case 0x41: return 0x80 | (this.io[0x41] & 0x78) | (this.ly === this.io[0x45] ? 4 : 0) | this.lcdMode();
      case 0x44: return this.ly;
      case 0x4d: return this.cgb ? (this.doubleSpeed ? 0x80 : 0) | (this.io[0x4d] & 1) | 0x7e : 0xff;
      case 0x4f: return this.cgb ? 0xfe | this.vbank : 0xff;
      case 0x70: return this.cgb ? 0xf8 | this.wbank : 0xff;
    }
    return this.io[r];
  }

  lcdMode(): number {
    if (!(this.io[0x40] & 0x80)) return 0;
    if (this.ly >= 144) return 1;
    return this.lineCycles < 80 ? 2 : this.lineCycles < 252 ? 3 : 0;
  }

  write(a: number, v: number) {
    if (this.onWrite) this.onWrite(a, v);
    switch (a >> 12) {
      case 0: case 1: this.ramOn = (v & 0x0f) === 0x0a; return;
      case 2: case 3:
        if (this.mbc === 5) { if (a < 0x3000) this.romBank = (this.romBank & 0x100) | v; else this.romBank = (this.romBank & 0xff) | ((v & 1) << 8); }
        else if (this.mbc === 3) this.romBank = (v & 0x7f) || 1;
        else if (this.mbc === 1) { this.romBank = (this.romBank & 0x60) | ((v & 0x1f) || 1); }
        return;
      case 4: case 5:
        if (this.mbc === 5) this.ramBank = v & 0x0f;
        else if (this.mbc === 3) this.ramBank = v & 3;
        else if (this.mbc === 1) { this.mbc1Hi = v & 3; this.romBank = (this.romBank & 0x1f) | (this.mbc1Hi << 5); if (this.mbc1Mode) this.ramBank = this.mbc1Hi; }
        return;
      case 6: case 7: if (this.mbc === 1) { this.mbc1Mode = v & 1; this.ramBank = this.mbc1Mode ? this.mbc1Hi : 0; } return;
      case 8: case 9: this.vram[this.vbank * 0x2000 + (a - 0x8000)] = v; return;
      case 0xa: case 0xb: if (this.ramOn) this.eram[(this.ramBank * 0x2000 + (a - 0xa000)) & 0x1ffff] = v; return;
      case 0xc: this.wram[a - 0xc000] = v; return;
      case 0xd: this.wram[this.wbank * 0x1000 + (a - 0xd000)] = v; return;
      case 0xe: this.wram[a - 0xe000] = v; return;
      default:
        if (a < 0xfe00) { this.wram[this.wbank * 0x1000 + (a - 0xf000)] = v; return; }
        if (a < 0xfea0) { this.oam[a - 0xfe00] = v; return; }
        if (a < 0xff00) return;
        if (a >= 0xff80) { if (a === 0xffff) this.ie = v; else this.hram[a - 0xff80] = v; return; }
        this.writeIo(a & 0x7f, v);
    }
  }

  writeIo(r: number, v: number) {
    if (r >= 0x10 && r < 0x40) { this.apu.write(r, v, this.apuNow()); return; }
    switch (r) {
      case 0x04: this.divCounter = 0; return;
      case 0x0f: this.if_ = v & 0x1f; return;
      case 0x40: if (!(v & 0x80)) { this.ly = 0; this.lineCycles = 0; } break;
      case 0x44: return;
      case 0x46: { const s = v << 8; for (let i = 0; i < 0xa0; i++) this.oam[i] = this.read(s + i); break; }
      case 0x4d: if (this.cgb) this.io[0x4d] = v & 1; return;
      case 0x4f: if (this.cgb) this.vbank = v & 1; return;
      case 0x55: if (this.cgb) { this.hdma(v); return; } break;
      case 0x70: if (this.cgb) this.wbank = (v & 7) || 1; return;
    }
    this.io[r] = v;
  }

  hdma(v: number) {
    const src = ((this.io[0x51] << 8) | this.io[0x52]) & 0xfff0, dst = 0x8000 | (((this.io[0x53] << 8) | this.io[0x54]) & 0x1ff0);
    const n = ((v & 0x7f) + 1) * 16;
    for (let i = 0; i < n; i++) this.vram[this.vbank * 0x2000 + ((dst + i) & 0x1fff)] = this.read(src + i);
    this.io[0x55] = 0xff;
  }

  /** APU time in its own (single-speed) clock */
  apuNow(): number { return this.apuBase + (this.cycles - this.apuCpuBase) / (this.doubleSpeed ? 2 : 1); }
  private apuBase = 0; private apuCpuBase = 0;

  // ------------------------------------------------------------------ timing
  private tick(n: number) {
    this.cycles += n;
    // timer: DIV is the upper byte of a 16-bit counter; TIMA counts falling edges of a counter bit
    const tac = this.io[0x07];
    const old = this.divCounter;
    this.divCounter = (old + n) & 0xffff;
    if (tac & 4) {
      const bit = [9, 3, 5, 7][tac & 3];
      const period = 1 << (bit + 1);
      // number of falling edges of bit `bit` between old and old+n
      const edges = Math.floor((old + n) / period) - Math.floor(old / period);
      for (let k = 0; k < edges; k++) {
        const t = this.io[0x05] + 1;
        if (t > 0xff) { this.io[0x05] = this.io[0x06]; this.if_ |= IRQ_TIMER; } else this.io[0x05] = t;
      }
    }
    // LCD timing (runs at single speed)
    const ln = this.doubleSpeed ? n >> 1 : n;
    if (this.io[0x40] & 0x80) {
      const oldMode = this.lcdMode();
      this.lineCycles += ln;
      if (this.lineCycles >= 456) {
        this.lineCycles -= 456;
        this.ly = (this.ly + 1) % 154;
        if (this.ly === 144) { this.if_ |= IRQ_VBLANK; if (this.io[0x41] & 0x10) this.if_ |= IRQ_STAT; }
        if (this.ly === this.io[0x45] && (this.io[0x41] & 0x40)) this.if_ |= IRQ_STAT;
      }
      const m = this.lcdMode();
      if (m !== oldMode && ((m === 0 && (this.io[0x41] & 8)) || (m === 2 && (this.io[0x41] & 0x20)))) this.if_ |= IRQ_STAT;
    }
  }

  /** switch speed (CGB STOP with KEY1 armed) keeping APU time continuous */
  private toggleSpeed() {
    this.apuBase = this.apuNow(); this.apuCpuBase = this.cycles;
    this.doubleSpeed = !this.doubleSpeed;
    this.io[0x4d] = 0;
  }

  // ------------------------------------------------------------------ CPU helpers
  private get hl() { return (this.h << 8) | this.l; }
  private setHl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  private fetch(): number { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetch16(): number { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  push(v: number) { this.sp = (this.sp - 1) & 0xffff; this.write(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xffff; this.write(this.sp, v & 0xff); }
  private pop(): number { const lo = this.read(this.sp); this.sp = (this.sp + 1) & 0xffff; const hi = this.read(this.sp); this.sp = (this.sp + 1) & 0xffff; return (hi << 8) | lo; }

  private getR(i: number): number {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; case 6: return this.read(this.hl); default: return this.a;
    }
  }
  private setR(i: number, v: number) {
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.write(this.hl, v); break; default: this.a = v;
    }
  }
  private getRR(i: number): number {
    switch (i) { case 0: return (this.b << 8) | this.c; case 1: return (this.d << 8) | this.e; case 2: return this.hl; default: return this.sp; }
  }
  private setRR(i: number, v: number) {
    v &= 0xffff;
    switch (i) { case 0: this.b = v >> 8; this.c = v & 0xff; break; case 1: this.d = v >> 8; this.e = v & 0xff; break; case 2: this.setHl(v); break; default: this.sp = v; }
  }
  private cond(i: number): boolean {
    switch (i) { case 0: return !(this.f & F_Z); case 1: return !!(this.f & F_Z); case 2: return !(this.f & F_C); default: return !!(this.f & F_C); }
  }

  private alu(op: number, v: number) {
    const a = this.a;
    let r: number;
    switch (op) {
      case 0: r = a + v; this.f = ((r & 0xff) ? 0 : F_Z) | (((a & 0xf) + (v & 0xf)) > 0xf ? F_H : 0) | (r > 0xff ? F_C : 0); this.a = r & 0xff; break;
      case 1: { const c = (this.f & F_C) ? 1 : 0; r = a + v + c; this.f = ((r & 0xff) ? 0 : F_Z) | (((a & 0xf) + (v & 0xf) + c) > 0xf ? F_H : 0) | (r > 0xff ? F_C : 0); this.a = r & 0xff; break; }
      case 2: r = a - v; this.f = F_N | ((r & 0xff) ? 0 : F_Z) | ((a & 0xf) < (v & 0xf) ? F_H : 0) | (r < 0 ? F_C : 0); this.a = r & 0xff; break;
      case 3: { const c = (this.f & F_C) ? 1 : 0; r = a - v - c; this.f = F_N | ((r & 0xff) ? 0 : F_Z) | ((a & 0xf) < (v & 0xf) + c ? F_H : 0) | (r < 0 ? F_C : 0); this.a = r & 0xff; break; }
      case 4: this.a = a & v; this.f = (this.a ? 0 : F_Z) | F_H; break;
      case 5: this.a = a ^ v; this.f = this.a ? 0 : F_Z; break;
      case 6: this.a = a | v; this.f = this.a ? 0 : F_Z; break;
      default: r = a - v; this.f = F_N | ((r & 0xff) ? 0 : F_Z) | ((a & 0xf) < (v & 0xf) ? F_H : 0) | (r < 0 ? F_C : 0); break;
    }
  }

  private addSp(e: number): number {
    const s = (e << 24) >> 24, sp = this.sp;
    this.f = (((sp & 0xf) + (e & 0xf)) > 0xf ? F_H : 0) | (((sp & 0xff) + (e & 0xff)) > 0xff ? F_C : 0);
    return (sp + s) & 0xffff;
  }

  private cb(): number {
    const op = this.fetch(), r = op & 7, y = (op >> 3) & 7;
    const v = this.getR(r);
    const mem = r === 6;
    switch (op >> 6) {
      case 0: {
        let res: number, c: number;
        switch (y) {
          case 0: c = v >> 7; res = ((v << 1) | c) & 0xff; break; // RLC
          case 1: c = v & 1; res = (v >> 1) | (c << 7); break; // RRC
          case 2: c = v >> 7; res = ((v << 1) | ((this.f & F_C) ? 1 : 0)) & 0xff; break; // RL
          case 3: c = v & 1; res = (v >> 1) | ((this.f & F_C) ? 0x80 : 0); break; // RR
          case 4: c = v >> 7; res = (v << 1) & 0xff; break; // SLA
          case 5: c = v & 1; res = (v >> 1) | (v & 0x80); break; // SRA
          case 6: c = 0; res = ((v << 4) | (v >> 4)) & 0xff; break; // SWAP
          default: c = v & 1; res = v >> 1; // SRL
        }
        this.f = (res ? 0 : F_Z) | (c ? F_C : 0);
        this.setR(r, res);
        return mem ? 16 : 8;
      }
      case 1: this.f = (this.f & F_C) | F_H | ((v >> y) & 1 ? 0 : F_Z); return mem ? 12 : 8; // BIT
      case 2: this.setR(r, v & ~(1 << y)); return mem ? 16 : 8; // RES
      default: this.setR(r, v | (1 << y)); return mem ? 16 : 8; // SET
    }
  }

  /** execute one instruction (or interrupt dispatch / halt cycle); returns T-cycles */
  step(): number {
    // interrupts
    const pending = this.ie & this.if_ & 0x1f;
    if (pending) {
      this.halted = false;
      if (this.ime) {
        this.ime = false;
        const bit = pending & -pending;
        this.if_ &= ~bit;
        this.push(this.pc);
        this.pc = 0x40 + 8 * (31 - Math.clz32(bit));
        this.tick(20);
        return 20;
      }
    }
    if (this.halted) { this.tick(4); return 4; }
    if (this.eiDelay && --this.eiDelay === 0) this.ime = true;
    if (this.trace) this.trace(this);
    const n = this.exec(this.fetch());
    this.tick(n);
    return n;
  }

  private exec(op: number): number {
    // regular blocks
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) { this.halted = true; return 4; }
      const s = op & 7, d = (op >> 3) & 7;
      this.setR(d, this.getR(s));
      return s === 6 || d === 6 ? 8 : 4;
    }
    if (op >= 0x80 && op < 0xc0) { const s = op & 7; this.alu((op >> 3) & 7, this.getR(s)); return s === 6 ? 8 : 4; }
    switch (op) {
      case 0x00: return 4;
      case 0x10: this.fetch(); if (this.cgb && (this.io[0x4d] & 1)) this.toggleSpeed(); else this.stopped = true; return 4;
      case 0x01: case 0x11: case 0x21: case 0x31: this.setRR(op >> 4, this.fetch16()); return 12;
      case 0x02: this.write((this.b << 8) | this.c, this.a); return 8;
      case 0x12: this.write((this.d << 8) | this.e, this.a); return 8;
      case 0x22: { const hl = this.hl; this.write(hl, this.a); this.setHl(hl + 1); return 8; }
      case 0x32: { const hl = this.hl; this.write(hl, this.a); this.setHl(hl - 1); return 8; }
      case 0x0a: this.a = this.read((this.b << 8) | this.c); return 8;
      case 0x1a: this.a = this.read((this.d << 8) | this.e); return 8;
      case 0x2a: { const hl = this.hl; this.a = this.read(hl); this.setHl(hl + 1); return 8; }
      case 0x3a: { const hl = this.hl; this.a = this.read(hl); this.setHl(hl - 1); return 8; }
      case 0x03: case 0x13: case 0x23: case 0x33: this.setRR(op >> 4, this.getRR(op >> 4) + 1); return 8;
      case 0x0b: case 0x1b: case 0x2b: case 0x3b: this.setRR(op >> 4, this.getRR(op >> 4) - 1); return 8;
      case 0x09: case 0x19: case 0x29: case 0x39: {
        const hl = this.hl, v = this.getRR(op >> 4), r = hl + v;
        this.f = (this.f & F_Z) | (((hl & 0xfff) + (v & 0xfff)) > 0xfff ? F_H : 0) | (r > 0xffff ? F_C : 0);
        this.setHl(r); return 8;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const i = op >> 3, v = (this.getR(i) + 1) & 0xff;
        this.f = (this.f & F_C) | (v ? 0 : F_Z) | ((v & 0xf) === 0 ? F_H : 0);
        this.setR(i, v); return i === 6 ? 12 : 4;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const i = op >> 3, v = (this.getR(i) - 1) & 0xff;
        this.f = (this.f & F_C) | F_N | (v ? 0 : F_Z) | ((v & 0xf) === 0xf ? F_H : 0);
        this.setR(i, v); return i === 6 ? 12 : 4;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x36: case 0x3e: {
        const i = op >> 3; this.setR(i, this.fetch()); return i === 6 ? 12 : 8;
      }
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = c ? F_C : 0; return 4; }
      case 0x0f: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? F_C : 0; return 4; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | ((this.f & F_C) ? 1 : 0)) & 0xff; this.f = c ? F_C : 0; return 4; }
      case 0x1f: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & F_C) ? 0x80 : 0); this.f = c ? F_C : 0; return 4; }
      case 0x08: { const a = this.fetch16(); this.write(a, this.sp & 0xff); this.write((a + 1) & 0xffff, this.sp >> 8); return 20; }
      case 0x18: { const e = (this.fetch() << 24) >> 24; this.pc = (this.pc + e) & 0xffff; return 12; }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const e = (this.fetch() << 24) >> 24;
        if (this.cond((op >> 3) & 3)) { this.pc = (this.pc + e) & 0xffff; return 12; }
        return 8;
      }
      case 0x27: { // DAA
        let a = this.a;
        const n = this.f & F_N, hf = this.f & F_H; let cf = this.f & F_C;
        if (!n) { if (cf || a > 0x99) { a += 0x60; cf = F_C; } if (hf || (a & 0xf) > 9) a += 6; }
        else { if (cf) a -= 0x60; if (hf) a -= 6; }
        a &= 0xff; this.a = a; this.f = (a ? 0 : F_Z) | n | cf; return 4;
      }
      case 0x2f: this.a ^= 0xff; this.f |= F_N | F_H; return 4;
      case 0x37: this.f = (this.f & F_Z) | F_C; return 4;
      case 0x3f: this.f = (this.f & F_Z) | ((this.f & F_C) ? 0 : F_C); return 4;
      case 0xc0: case 0xc8: case 0xd0: case 0xd8: if (this.cond((op >> 3) & 3)) { this.pc = this.pop(); return 20; } return 8;
      case 0xc9: this.pc = this.pop(); return 16;
      case 0xd9: this.pc = this.pop(); this.ime = true; return 16;
      case 0xc1: case 0xd1: case 0xe1: this.setRR((op >> 4) & 3, this.pop()); return 12;
      case 0xf1: { const v = this.pop(); this.a = v >> 8; this.f = v & 0xf0; return 12; }
      case 0xc5: case 0xd5: case 0xe5: this.push(this.getRR((op >> 4) & 3)); return 16;
      case 0xf5: this.push((this.a << 8) | this.f); return 16;
      case 0xc2: case 0xca: case 0xd2: case 0xda: { const a = this.fetch16(); if (this.cond((op >> 3) & 3)) { this.pc = a; return 16; } return 12; }
      case 0xc3: this.pc = this.fetch16(); return 16;
      case 0xe9: this.pc = this.hl; return 4;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: { const a = this.fetch16(); if (this.cond((op >> 3) & 3)) { this.push(this.pc); this.pc = a; return 24; } return 12; }
      case 0xcd: { const a = this.fetch16(); this.push(this.pc); this.pc = a; return 24; }
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff: this.push(this.pc); this.pc = op & 0x38; return 16;
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe: this.alu((op >> 3) & 7, this.fetch()); return 8;
      case 0xcb: return this.cb();
      case 0xe0: this.write(0xff00 | this.fetch(), this.a); return 12;
      case 0xf0: this.a = this.read(0xff00 | this.fetch()); return 12;
      case 0xe2: this.write(0xff00 | this.c, this.a); return 8;
      case 0xf2: this.a = this.read(0xff00 | this.c); return 8;
      case 0xea: this.write(this.fetch16(), this.a); return 16;
      case 0xfa: this.a = this.read(this.fetch16()); return 16;
      case 0xe8: this.sp = this.addSp(this.fetch()); return 16;
      case 0xf8: this.setHl(this.addSp(this.fetch())); return 12;
      case 0xf9: this.sp = this.hl; return 8;
      case 0xf3: this.ime = false; this.eiDelay = 0; return 4;
      case 0xfb: if (!this.ime && !this.eiDelay) this.eiDelay = 1; return 4;
    }
    // undefined opcodes lock the CPU
    this.halted = true; this.ie = 0;
    return 4;
  }

  /** run for `n` CPU cycles (at the current speed) */
  run(n: number) {
    const end = this.cycles + n;
    while (this.cycles < end) this.step();
  }

  /** call a routine as a GBS player does: returns once it returns to the sentinel or after `limit` cycles */
  call(addr: number, limit = 4_000_000): boolean {
    const SENTINEL = 0xfffe; // never executed: a return here ends the call
    this.push(SENTINEL);
    this.pc = addr; this.halted = false;
    const end = this.cycles + limit;
    while (this.cycles < end) {
      if (this.pc === SENTINEL) return true;
      this.step();
      if (this.halted && !(this.ie & this.if_ & 0x1f) && !this.ime) return false;
    }
    return false;
  }
}
