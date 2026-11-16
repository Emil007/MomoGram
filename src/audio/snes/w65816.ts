// WDC 65C816 (the Super Famicom's main CPU), complete instruction set including decimal mode and emulation mode.
// MomoGram only uses it while importing a pack: it runs the game's own start-up code until the game has uploaded
// its sound program to the SPC700. Timing is approximate (memory accesses and internal cycles counted).
// Written from the public documentation (WDC W65C816S datasheet, fullsnes). MIT licence.

export interface Bus { read(a: number): number; write(a: number, v: number): void }

const C = 1, Z = 2, I = 4, D = 8, X = 0x10, M = 0x20, V = 0x40, N = 0x80;

export class W65816 {
  a = 0; x = 0; y = 0; s = 0x1ff; d = 0; db = 0; pb = 0; pc = 0; p = 0x34; e = true;
  /** master clocks (approximate: 8 per memory access, 6 per internal cycle) */
  cycles = 0;
  nmi = false; irq = false; waiting = false; stopped = false;

  constructor(private bus: Bus) {}

  reset() {
    this.e = true; this.p = 0x34; this.s = 0x1ff; this.d = 0; this.db = 0; this.pb = 0; this.x &= 0xff; this.y &= 0xff;
    this.pc = this.rd(0xfffc) | (this.rd(0xfffd) << 8);
  }

  // ------------------------------------------------------------------ memory
  private rd(a: number): number { this.cycles += 8; return this.bus.read(a & 0xffffff); }
  private wr(a: number, v: number) { this.cycles += 8; this.bus.write(a & 0xffffff, v & 0xff); }
  private io(n = 1) { this.cycles += 6 * n; }
  private rdW(a: number, bank0 = false): number { return this.rd(a) | (this.rd(bank0 ? (a & 0xff0000) | ((a + 1) & 0xffff) : a + 1) << 8); }
  private wrW(a: number, v: number, bank0 = false) { this.wr(a, v); this.wr(bank0 ? (a & 0xff0000) | ((a + 1) & 0xffff) : a + 1, v >> 8); }
  private fetch(): number { const v = this.rd((this.pb << 16) | this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetchW(): number { const l = this.fetch(); return l | (this.fetch() << 8); }
  private fetchL(): number { const w = this.fetchW(); return w | (this.fetch() << 16); }
  private get m8() { return (this.p & M) !== 0; }
  private get x8() { return (this.p & X) !== 0; }
  private push(v: number) { this.wr(this.s, v); this.s = this.e ? 0x100 | ((this.s - 1) & 0xff) : (this.s - 1) & 0xffff; }
  private pull(): number { this.s = this.e ? 0x100 | ((this.s + 1) & 0xff) : (this.s + 1) & 0xffff; return this.rd(this.s); }
  private pushW(v: number) { this.push(v >> 8); this.push(v); }
  private pullW(): number { const l = this.pull(); return l | (this.pull() << 8); }

  // ------------------------------------------------------------------ addressing (24-bit effective addresses)
  private dpAddr(o: number): number { if (this.d & 0xff) this.io(); return (this.d + o) & 0xffff; }
  private aDp() { return this.dpAddr(this.fetch()); }
  private aDpX() { const o = this.fetch(); this.io(); return this.e && !(this.d & 0xff) ? (this.d & 0xff00) | ((o + this.x) & 0xff) : (this.d + o + this.x) & 0xffff; }
  private aDpY() { const o = this.fetch(); this.io(); return this.e && !(this.d & 0xff) ? (this.d & 0xff00) | ((o + this.y) & 0xff) : (this.d + o + this.y) & 0xffff; }
  private aInd() { const p = this.aDp(); return (this.db << 16) | this.rdW(p, true); }
  private aIndX() { const p = this.aDpX(); return (this.db << 16) | this.rdW(p, true); }
  private aIndY() { const p = this.aDp(); return (((this.db << 16) | this.rdW(p, true)) + this.y) & 0xffffff; }
  private aIndL() { const p = this.aDp(); return this.rdW(p, true) | (this.rd((p + 2) & 0xffff) << 16); }
  private aIndLY() { return (this.aIndL() + this.y) & 0xffffff; }
  private aAbs() { return (this.db << 16) | this.fetchW(); }
  private aAbsX() { return (((this.db << 16) | this.fetchW()) + this.x) & 0xffffff; }
  private aAbsY() { return (((this.db << 16) | this.fetchW()) + this.y) & 0xffffff; }
  private aLong() { return this.fetchL(); }
  private aLongX() { return (this.fetchL() + this.x) & 0xffffff; }
  private aSr() { const o = this.fetch(); this.io(); return (this.s + o) & 0xffff; }
  private aSrY() { const p = this.aSr(); this.io(); return (((this.db << 16) | this.rdW(p, true)) + this.y) & 0xffffff; }

  // ------------------------------------------------------------------ flags
  private setP(v: number) {
    this.p = v;
    if (this.e) this.p |= M | X;
    if (this.p & X) { this.x &= 0xff; this.y &= 0xff; }
  }
  private nz8(v: number) { this.p = (this.p & ~(N | Z)) | (v & 0x80) | ((v & 0xff) ? 0 : Z); }
  private nz16(v: number) { this.p = (this.p & ~(N | Z)) | ((v >> 8) & 0x80) | ((v & 0xffff) ? 0 : Z); }
  private nzM(v: number) { if (this.m8) this.nz8(v); else this.nz16(v); }
  private nzX(v: number) { if (this.x8) this.nz8(v); else this.nz16(v); }

  // data of M / X width at an address
  private rdM(a: number, bank0 = false) { return this.m8 ? this.rd(a) : this.rdW(a, bank0); }
  private wrM(a: number, v: number, bank0 = false) { if (this.m8) this.wr(a, v); else this.wrW(a, v, bank0); }
  private rdX(a: number, bank0 = false) { return this.x8 ? this.rd(a) : this.rdW(a, bank0); }
  private wrX(a: number, v: number, bank0 = false) { if (this.x8) this.wr(a, v); else this.wrW(a, v, bank0); }
  private immM() { return this.m8 ? this.fetch() : this.fetchW(); }
  private immX() { return this.x8 ? this.fetch() : this.fetchW(); }

  private get acc() { return this.m8 ? this.a & 0xff : this.a; }
  private set acc(v: number) { this.a = this.m8 ? (this.a & 0xff00) | (v & 0xff) : v & 0xffff; }

  // ------------------------------------------------------------------ ALU
  private adc(v: number) {
    const w = this.m8 ? 8 : 16, mask = (1 << w) - 1, sign = 1 << (w - 1);
    const a = this.acc;
    let c = this.p & C, r: number;
    if (this.p & D) {
      r = 0;
      for (let i = 0; i < w; i += 4) {
        let d = ((a >> i) & 15) + ((v >> i) & 15) + c;
        if (d > 9) d += 6;
        c = d > 15 ? 1 : 0;
        r |= (d & 15) << i;
      }
      this.p = (this.p & ~(V | C)) | (~(a ^ v) & (a ^ r) & sign ? V : 0) | c;
    } else {
      r = a + v + c;
      this.p = (this.p & ~(V | C)) | (~(a ^ v) & (a ^ r) & sign ? V : 0) | (r > mask ? C : 0);
      r &= mask;
    }
    this.acc = r; this.nzM(r);
  }
  private sbc(v: number) {
    if (!(this.p & D)) { this.adc(v ^ (this.m8 ? 0xff : 0xffff)); return; }
    const w = this.m8 ? 8 : 16, sign = 1 << (w - 1);
    const a = this.acc;
    let borrow = (this.p & C) ? 0 : 1, r = 0;
    for (let i = 0; i < w; i += 4) {
      let d = ((a >> i) & 15) - ((v >> i) & 15) - borrow;
      if (d < 0) { d += 10; borrow = 1; } else borrow = 0;
      r |= (d & 15) << i;
    }
    this.p = (this.p & ~(V | C)) | ((a ^ v) & (a ^ r) & sign ? V : 0) | (borrow ? 0 : C);
    this.acc = r; this.nzM(r);
  }
  private cmpW(reg: number, v: number, w8: boolean) {
    const r = reg - v;
    this.p = (this.p & ~C) | (r >= 0 ? C : 0);
    if (w8) this.nz8(r); else this.nz16(r);
  }
  private group1(op: number, addr: number | null, bank0 = false) {
    const kind = op >> 5;
    if (kind === 4) { this.wrM(addr!, this.acc, bank0); return; } // STA
    const v = addr === null ? this.immM() : this.rdM(addr, bank0);
    switch (kind) {
      case 0: this.acc = this.acc | v; this.nzM(this.acc); break;
      case 1: this.acc = this.acc & v; this.nzM(this.acc); break;
      case 2: this.acc = this.acc ^ v; this.nzM(this.acc); break;
      case 3: this.adc(v); break;
      case 5: this.acc = v; this.nzM(v); break;
      case 6: this.cmpW(this.acc, v, this.m8); break;
      case 7: this.sbc(v); break;
    }
  }
  /** read-modify-write: 0 ASL, 1 ROL, 2 LSR, 3 ROR, 4 INC, 5 DEC, 6 TSB, 7 TRB */
  private rmwVal(kind: number, v: number): number {
    const w8 = this.m8, msb = w8 ? 0x80 : 0x8000, mask = w8 ? 0xff : 0xffff;
    let r: number;
    switch (kind) {
      case 0: r = (v << 1) & mask; this.p = (this.p & ~C) | (v & msb ? C : 0); break;
      case 1: r = ((v << 1) | (this.p & C)) & mask; this.p = (this.p & ~C) | (v & msb ? C : 0); break;
      case 2: r = v >> 1; this.p = (this.p & ~C) | (v & 1); break;
      case 3: r = (v >> 1) | ((this.p & C) ? msb : 0); this.p = (this.p & ~C) | (v & 1); break;
      case 4: r = (v + 1) & mask; break;
      case 5: r = (v - 1) & mask; break;
      case 6: this.p = (this.p & ~Z) | ((v & this.acc) ? 0 : Z); return v | this.acc;
      default: this.p = (this.p & ~Z) | ((v & this.acc) ? 0 : Z); return v & ~this.acc & mask;
    }
    this.nzM(r);
    return r;
  }
  private rmw(kind: number, addr: number, bank0 = false) { const v = this.rdM(addr, bank0); this.io(); this.wrM(addr, this.rmwVal(kind, v), bank0); }
  private bit(v: number, imm: boolean) {
    const msb = this.m8 ? 0x80 : 0x8000;
    this.p = (this.p & ~Z) | ((v & this.acc) ? 0 : Z);
    if (!imm) this.p = (this.p & ~(N | V)) | (v & msb ? N : 0) | (v & (msb >> 1) ? V : 0);
  }
  private branch(cond: boolean) {
    const o = (this.fetch() << 24) >> 24;
    if (cond) { this.io(); this.pc = (this.pc + o) & 0xffff; }
  }

  private interrupt(native: number, emu: number) {
    if (!this.e) this.push(this.pb);
    this.pushW(this.pc);
    this.push(this.e ? this.p & ~0x10 : this.p);
    this.p = (this.p | I) & ~D;
    this.pb = 0;
    const v = this.e ? emu : native;
    this.pc = this.rd(v) | (this.rd(v + 1) << 8);
  }

  // ------------------------------------------------------------------ execution
  step() {
    if (this.nmi) { this.nmi = false; this.waiting = false; this.interrupt(0xffea, 0xfffa); return; }
    if (this.irq && !(this.p & I)) { this.waiting = false; this.interrupt(0xffee, 0xfffe); return; }
    if (this.waiting || this.stopped) { this.cycles += 24; if (this.irq) this.waiting = false; return; }
    const op = this.fetch();
    // group 1 (ORA AND EOR ADC STA LDA CMP SBC)
    const lo = op & 0x1f;
    if (((op & 1) && (op & 0x0f) !== 0x0b) || lo === 0x12) {
      if (op === 0x89) { this.bit(this.immM(), true); return; }
      switch (lo) {
        case 0x01: this.group1(op, this.aIndX()); return;
        case 0x03: this.group1(op, this.aSr(), true); return;
        case 0x05: this.group1(op, this.aDp(), true); return;
        case 0x07: this.group1(op, this.aIndL()); return;
        case 0x09: this.group1(op, null); return;
        case 0x0d: this.group1(op, this.aAbs()); return;
        case 0x0f: this.group1(op, this.aLong()); return;
        case 0x11: this.group1(op, this.aIndY()); return;
        case 0x12: this.group1(op, this.aInd()); return;
        case 0x13: this.group1(op, this.aSrY()); return;
        case 0x15: this.group1(op, this.aDpX(), true); return;
        case 0x17: this.group1(op, this.aIndLY()); return;
        case 0x19: this.group1(op, this.aAbsY()); return;
        case 0x1d: this.group1(op, this.aAbsX()); return;
        case 0x1f: this.group1(op, this.aLongX()); return;
      }
    }
    switch (op) {
      // read-modify-write
      case 0x06: this.rmw(0, this.aDp(), true); break;
      case 0x0e: this.rmw(0, this.aAbs()); break;
      case 0x16: this.rmw(0, this.aDpX(), true); break;
      case 0x1e: this.rmw(0, this.aAbsX()); break;
      case 0x0a: this.io(); this.acc = this.rmwVal(0, this.acc); break;
      case 0x26: this.rmw(1, this.aDp(), true); break;
      case 0x2e: this.rmw(1, this.aAbs()); break;
      case 0x36: this.rmw(1, this.aDpX(), true); break;
      case 0x3e: this.rmw(1, this.aAbsX()); break;
      case 0x2a: this.io(); this.acc = this.rmwVal(1, this.acc); break;
      case 0x46: this.rmw(2, this.aDp(), true); break;
      case 0x4e: this.rmw(2, this.aAbs()); break;
      case 0x56: this.rmw(2, this.aDpX(), true); break;
      case 0x5e: this.rmw(2, this.aAbsX()); break;
      case 0x4a: this.io(); this.acc = this.rmwVal(2, this.acc); break;
      case 0x66: this.rmw(3, this.aDp(), true); break;
      case 0x6e: this.rmw(3, this.aAbs()); break;
      case 0x76: this.rmw(3, this.aDpX(), true); break;
      case 0x7e: this.rmw(3, this.aAbsX()); break;
      case 0x6a: this.io(); this.acc = this.rmwVal(3, this.acc); break;
      case 0xe6: this.rmw(4, this.aDp(), true); break;
      case 0xee: this.rmw(4, this.aAbs()); break;
      case 0xf6: this.rmw(4, this.aDpX(), true); break;
      case 0xfe: this.rmw(4, this.aAbsX()); break;
      case 0x1a: this.io(); this.acc = this.rmwVal(4, this.acc); break;
      case 0xc6: this.rmw(5, this.aDp(), true); break;
      case 0xce: this.rmw(5, this.aAbs()); break;
      case 0xd6: this.rmw(5, this.aDpX(), true); break;
      case 0xde: this.rmw(5, this.aAbsX()); break;
      case 0x3a: this.io(); this.acc = this.rmwVal(5, this.acc); break;
      case 0x04: this.rmw(6, this.aDp(), true); break;
      case 0x0c: this.rmw(6, this.aAbs()); break;
      case 0x14: this.rmw(7, this.aDp(), true); break;
      case 0x1c: this.rmw(7, this.aAbs()); break;
      // BIT
      case 0x24: this.bit(this.rdM(this.aDp(), true), false); break;
      case 0x2c: this.bit(this.rdM(this.aAbs()), false); break;
      case 0x34: this.bit(this.rdM(this.aDpX(), true), false); break;
      case 0x3c: this.bit(this.rdM(this.aAbsX()), false); break;
      // index registers
      case 0xa2: this.x = this.immX(); this.nzX(this.x); break;
      case 0xa6: this.x = this.rdX(this.aDp(), true); this.nzX(this.x); break;
      case 0xae: this.x = this.rdX(this.aAbs()); this.nzX(this.x); break;
      case 0xb6: this.x = this.rdX(this.aDpY(), true); this.nzX(this.x); break;
      case 0xbe: this.x = this.rdX(this.aAbsY()); this.nzX(this.x); break;
      case 0xa0: this.y = this.immX(); this.nzX(this.y); break;
      case 0xa4: this.y = this.rdX(this.aDp(), true); this.nzX(this.y); break;
      case 0xac: this.y = this.rdX(this.aAbs()); this.nzX(this.y); break;
      case 0xb4: this.y = this.rdX(this.aDpX(), true); this.nzX(this.y); break;
      case 0xbc: this.y = this.rdX(this.aAbsX()); this.nzX(this.y); break;
      case 0x86: this.wrX(this.aDp(), this.x, true); break;
      case 0x8e: this.wrX(this.aAbs(), this.x); break;
      case 0x96: this.wrX(this.aDpY(), this.x, true); break;
      case 0x84: this.wrX(this.aDp(), this.y, true); break;
      case 0x8c: this.wrX(this.aAbs(), this.y); break;
      case 0x94: this.wrX(this.aDpX(), this.y, true); break;
      case 0x64: this.wrM(this.aDp(), 0, true); break;
      case 0x74: this.wrM(this.aDpX(), 0, true); break;
      case 0x9c: this.wrM(this.aAbs(), 0); break;
      case 0x9e: this.wrM(this.aAbsX(), 0); break;
      case 0xe0: this.cmpW(this.x, this.immX(), this.x8); break;
      case 0xe4: this.cmpW(this.x, this.rdX(this.aDp(), true), this.x8); break;
      case 0xec: this.cmpW(this.x, this.rdX(this.aAbs()), this.x8); break;
      case 0xc0: this.cmpW(this.y, this.immX(), this.x8); break;
      case 0xc4: this.cmpW(this.y, this.rdX(this.aDp(), true), this.x8); break;
      case 0xcc: this.cmpW(this.y, this.rdX(this.aAbs()), this.x8); break;
      case 0xe8: this.io(); this.x = (this.x + 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.x); break;
      case 0xc8: this.io(); this.y = (this.y + 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.y); break;
      case 0xca: this.io(); this.x = (this.x - 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.x); break;
      case 0x88: this.io(); this.y = (this.y - 1) & (this.x8 ? 0xff : 0xffff); this.nzX(this.y); break;
      // branches
      case 0x10: this.branch(!(this.p & N)); break;
      case 0x30: this.branch(!!(this.p & N)); break;
      case 0x50: this.branch(!(this.p & V)); break;
      case 0x70: this.branch(!!(this.p & V)); break;
      case 0x90: this.branch(!(this.p & C)); break;
      case 0xb0: this.branch(!!(this.p & C)); break;
      case 0xd0: this.branch(!(this.p & Z)); break;
      case 0xf0: this.branch(!!(this.p & Z)); break;
      case 0x80: this.branch(true); break;
      case 0x82: { const o = this.fetchW(); this.io(); this.pc = (this.pc + o) & 0xffff; break; }
      // jumps
      case 0x4c: this.pc = this.fetchW(); break;
      case 0x5c: { const a = this.fetchL(); this.pc = a & 0xffff; this.pb = a >> 16; break; }
      case 0x6c: { const a = this.fetchW(); this.pc = this.rdW(a, true); break; }
      case 0x7c: { const a = (this.fetchW() + this.x) & 0xffff; this.io(); this.pc = this.rdW((this.pb << 16) | a); break; }
      case 0xdc: { const a = this.fetchW(); this.pc = this.rdW(a, true); this.pb = this.rd((a + 2) & 0xffff); break; }
      case 0x20: { const a = this.fetchW(); this.io(); this.pushW((this.pc - 1) & 0xffff); this.pc = a; break; }
      case 0xfc: { const a = (this.fetchW() + this.x) & 0xffff; this.io(); this.pushW((this.pc - 1) & 0xffff); this.pc = this.rdW((this.pb << 16) | a); break; }
      case 0x22: { const a = this.fetchL(); this.push(this.pb); this.io(); this.pushW((this.pc - 1) & 0xffff); this.pc = a & 0xffff; this.pb = a >> 16; break; }
      case 0x60: this.io(2); this.pc = (this.pullW() + 1) & 0xffff; this.io(); break;
      case 0x6b: this.io(2); this.pc = (this.pullW() + 1) & 0xffff; this.pb = this.pull(); break;
      case 0x40: {
        this.io(2);
        this.setP(this.pull()); this.pc = this.pullW();
        if (!this.e) this.pb = this.pull();
        break;
      }
      case 0x00: this.fetch(); this.interrupt(0xffe6, 0xfffe); break; // BRK
      case 0x02: this.fetch(); this.interrupt(0xffe4, 0xfff4); break; // COP
      // stack
      case 0x48: this.io(); if (this.m8) this.push(this.a); else this.pushW(this.a); break;
      case 0x68: this.io(2); this.acc = this.m8 ? this.pull() : this.pullW(); this.nzM(this.acc); break;
      case 0xda: this.io(); if (this.x8) this.push(this.x); else this.pushW(this.x); break;
      case 0xfa: this.io(2); this.x = this.x8 ? this.pull() : this.pullW(); this.nzX(this.x); break;
      case 0x5a: this.io(); if (this.x8) this.push(this.y); else this.pushW(this.y); break;
      case 0x7a: this.io(2); this.y = this.x8 ? this.pull() : this.pullW(); this.nzX(this.y); break;
      case 0x08: this.io(); this.push(this.p); break;
      case 0x28: this.io(2); this.setP(this.pull()); break;
      case 0x8b: this.io(); this.push(this.db); break;
      case 0xab: this.io(2); this.db = this.pull(); this.nz8(this.db); break;
      case 0x0b: this.io(); this.pushW(this.d); break;
      case 0x2b: this.io(2); this.d = this.pullW(); this.nz16(this.d); break;
      case 0x4b: this.io(); this.push(this.pb); break;
      case 0xf4: this.pushW(this.fetchW()); break;
      case 0xd4: { const p = this.aDp(); this.pushW(this.rdW(p, true)); break; }
      case 0x62: { const o = this.fetchW(); this.io(); this.pushW((this.pc + o) & 0xffff); break; }
      // flags
      case 0x18: this.io(); this.p &= ~C; break;
      case 0x38: this.io(); this.p |= C; break;
      case 0x58: this.io(); this.p &= ~I; break;
      case 0x78: this.io(); this.p |= I; break;
      case 0xb8: this.io(); this.p &= ~V; break;
      case 0xd8: this.io(); this.p &= ~D; break;
      case 0xf8: this.io(); this.p |= D; break;
      case 0xc2: { const v = this.fetch(); this.io(); this.setP(this.p & ~v); break; }
      case 0xe2: { const v = this.fetch(); this.io(); this.setP(this.p | v); break; }
      case 0xfb: { // XCE
        this.io();
        const c = this.p & C;
        this.p = (this.p & ~C) | (this.e ? 1 : 0);
        this.e = c !== 0;
        if (this.e) { this.p |= M | X; this.x &= 0xff; this.y &= 0xff; this.s = 0x100 | (this.s & 0xff); }
        break;
      }
      // transfers
      case 0xaa: this.io(); this.x = this.x8 ? this.a & 0xff : this.a; this.nzX(this.x); break;
      case 0xa8: this.io(); this.y = this.x8 ? this.a & 0xff : this.a; this.nzX(this.y); break;
      case 0x8a: this.io(); this.acc = this.x; this.nzM(this.acc); break;
      case 0x98: this.io(); this.acc = this.y; this.nzM(this.acc); break;
      case 0xba: this.io(); this.x = this.x8 ? this.s & 0xff : this.s; this.nzX(this.x); break;
      case 0x9a: this.io(); this.s = this.e ? 0x100 | (this.x & 0xff) : this.x; break;
      case 0x9b: this.io(); this.y = this.x; this.nzX(this.y); break;
      case 0xbb: this.io(); this.x = this.y; this.nzX(this.x); break;
      case 0x5b: this.io(); this.d = this.a; this.nz16(this.d); break;
      case 0x7b: this.io(); this.a = this.d; this.nz16(this.a); break;
      case 0x1b: this.io(); this.s = this.e ? 0x100 | (this.a & 0xff) : this.a; break;
      case 0x3b: this.io(); this.a = this.s; this.nz16(this.a); break;
      case 0xeb: this.io(2); this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff; this.nz8(this.a); break;
      // block moves
      case 0x54: case 0x44: {
        const dst = this.fetch(), src = this.fetch();
        this.db = dst;
        this.wr((dst << 16) | this.y, this.rd((src << 16) | this.x));
        this.io(2);
        const dx = op === 0x54 ? 1 : -1, mask = this.x8 ? 0xff : 0xffff;
        this.x = (this.x + dx) & mask; this.y = (this.y + dx) & mask;
        this.a = (this.a - 1) & 0xffff;
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff;
        break;
      }
      case 0xea: this.io(); break;
      case 0x42: this.fetch(); break; // WDM
      case 0xcb: this.waiting = true; break;
      case 0xdb: this.stopped = true; break;
      default: break;
    }
  }
}
