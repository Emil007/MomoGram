// Sony SPC700 (the Super Famicom's sound CPU) with its 64 KiB RAM, I/O registers and three timers.
// Written from the public hardware documentation (fullsnes by Martin Korth, anomie's SPC700 doc). The boot ROM
// ("IPL") is not included: its documented transfer protocol is emulated directly (see `ipl`). MIT licence.
import { Dsp } from './dsp';

const N = 0x80, V = 0x40, P = 0x20, B = 0x10, H = 0x08, I = 0x04, Z = 0x02, C = 0x01;

// cycles per opcode (taken branches add 2)
const CYCLES = [
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
  2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
];

export class Spc {
  ram = new Uint8Array(0x10000);
  a = 0; x = 0; y = 0; sp = 0xef; pc = 0xffc0; psw = 0x02;
  /** values the main CPU wrote to $2140-$2143 (read by the SPC at $F4-$F7) */
  portIn = new Uint8Array(4);
  /** values the SPC wrote to $F4-$F7 (read by the main CPU at $2140-$2143) */
  portOut = new Uint8Array(4);
  control = 0x80; dspAddr = 0;
  timerTarget = new Uint8Array(3); timerStage = [0, 0, 0]; timerOut = [0, 0, 0]; timerDiv = [0, 0, 0];
  cycles = 0;
  stopped = false;
  readonly dsp: Dsp;
  private dspCycles = 0;
  /** boot ROM state machine (the IPL's transfer protocol), active while the SPC runs at $FFC0.. */
  ipl = { on: true, state: 0, echo: 0, index: 0, addr: 0 };

  constructor(sampleRate = 32000) {
    this.dsp = new Dsp(this.ram, sampleRate);
    this.iplReset();
  }

  // ------------------------------------------------------------------ state
  /** everything except RAM, as plain numbers (RAM is stored separately) */
  saveState(): Record<string, unknown> {
    return {
      a: this.a, x: this.x, y: this.y, sp: this.sp, pc: this.pc, psw: this.psw, portIn: [...this.portIn], portOut: [...this.portOut],
      control: this.control, dspAddr: this.dspAddr, timerTarget: [...this.timerTarget], timerStage: this.timerStage, timerOut: this.timerOut,
      timerDiv: this.timerDiv, stopped: this.stopped, dspCycles: this.dspCycles, ipl: this.ipl, dsp: this.dsp.saveState(),
    };
  }
  loadState(st: any, ram: Uint8Array) {
    this.ram.set(ram);
    Object.assign(this, { a: st.a, x: st.x, y: st.y, sp: st.sp, pc: st.pc, psw: st.psw, control: st.control, dspAddr: st.dspAddr, stopped: st.stopped, dspCycles: st.dspCycles });
    this.portIn.set(st.portIn); this.portOut.set(st.portOut); this.timerTarget.set(st.timerTarget);
    this.timerStage = [...st.timerStage]; this.timerOut = [...st.timerOut]; this.timerDiv = [...st.timerDiv];
    this.ipl = { ...st.ipl };
    this.dsp.loadState(st.dsp);
  }

  // ------------------------------------------------------------------ I/O
  read(a: number): number {
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf2: return this.dspAddr;
        case 0xf3: return this.dsp.read(this.dspAddr & 0x7f);
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: return this.portIn[a - 0xf4];
        case 0xfd: case 0xfe: case 0xff: { const v = this.timerOut[a - 0xfd]; this.timerOut[a - 0xfd] = 0; return v; }
        case 0xf0: case 0xf1: case 0xfa: case 0xfb: case 0xfc: return 0;
      }
    }
    return this.ram[a];
  }

  write(a: number, v: number) {
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf1:
          for (let t = 0; t < 3; t++) if ((v >> t) & 1 && !((this.control >> t) & 1)) { this.timerStage[t] = 0; this.timerOut[t] = 0; }
          if (v & 0x10) { this.portIn[0] = 0; this.portIn[1] = 0; }
          if (v & 0x20) { this.portIn[2] = 0; this.portIn[3] = 0; }
          this.control = v;
          break;
        case 0xf2: this.dspAddr = v; break;
        case 0xf3: if (this.dspAddr < 0x80) this.dsp.write(this.dspAddr, v); break;
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: this.portOut[a - 0xf4] = v; break;
        case 0xfa: case 0xfb: case 0xfc: this.timerTarget[a - 0xfa] = v; break;
      }
    }
    this.ram[a] = v; // writes always reach RAM underneath
  }

  private rd(a: number) { return this.read(a & 0xffff); }
  private dp(d: number) { return ((this.psw & P) << 3) | (d & 0xff); }
  private rdDp(d: number) { return this.read(this.dp(d)); }
  private wrDp(d: number, v: number) { this.write(this.dp(d), v & 0xff); }
  private rdDpW(d: number) { return this.rdDp(d) | (this.rdDp((d + 1) & 0xff) << 8); }
  private fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetchW() { const l = this.fetch(); return l | (this.fetch() << 8); }
  private push(v: number) { this.write(0x100 | this.sp, v & 0xff); this.sp = (this.sp - 1) & 0xff; }
  private pop() { this.sp = (this.sp + 1) & 0xff; return this.read(0x100 | this.sp); }
  private nz(v: number) { this.psw = (this.psw & ~(N | Z)) | (v & 0x80) | ((v & 0xff) ? 0 : Z); return v & 0xff; }

  // ------------------------------------------------------------------ ALU
  private adc(a: number, b: number): number {
    const c = this.psw & C, r = a + b + c;
    this.psw &= ~(V | H | C);
    if (~(a ^ b) & (a ^ r) & 0x80) this.psw |= V;
    if (((a & 0xf) + (b & 0xf) + c) > 0xf) this.psw |= H;
    if (r > 0xff) this.psw |= C;
    return this.nz(r);
  }
  private sbc(a: number, b: number) { return this.adc(a, b ^ 0xff); }
  private cmp(a: number, b: number) { const r = a - b; this.psw = (this.psw & ~C) | (r >= 0 ? C : 0); this.nz(r); }
  private alu(op: number, a: number, b: number): number {
    switch (op) {
      case 0: return this.nz(a | b);
      case 1: return this.nz(a & b);
      case 2: return this.nz(a ^ b);
      case 3: this.cmp(a, b); return a;
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }
  private shift(op: number, v: number): number {
    let r: number, c: number;
    switch (op) {
      case 0: c = v >> 7; r = v << 1; break; // ASL
      case 1: c = v >> 7; r = (v << 1) | (this.psw & C); break; // ROL
      case 2: c = v & 1; r = v >> 1; break; // LSR
      default: c = v & 1; r = (v >> 1) | ((this.psw & C) << 7); // ROR
    }
    this.psw = (this.psw & ~C) | c;
    return this.nz(r);
  }
  private branch(cond: boolean): number {
    const r = this.fetch();
    if (cond) { this.pc = (this.pc + ((r << 24) >> 24)) & 0xffff; return 2; }
    return 0;
  }
  private memBit(): [number, number] { const w = this.fetchW(); return [w & 0x1fff, w >> 13]; }

  // ------------------------------------------------------------------ boot ROM (IPL) protocol
  private iplReset() {
    for (let i = 1; i <= 0xef; i++) this.ram[i] = 0;
    this.sp = 0xef;
    this.portOut[0] = 0xaa; this.portOut[1] = 0xbb;
    this.ipl.on = true; this.ipl.state = 0;
  }

  private iplStep() {
    const s = this.ipl, p = this.portIn;
    if (s.state === 0) { // waiting for $CC
      if (p[0] === 0xcc) { s.addr = p[2] | (p[3] << 8); s.echo = 0xcc; s.index = 0; this.portOut[0] = 0xcc; s.state = p[1] ? 1 : 2; if (s.state === 2) this.iplJump(); }
      return;
    }
    if (s.state === 1) { // transfer
      const v = p[0];
      if (v === s.echo) return;
      if (v === s.index) {
        this.ram[s.addr] = p[1]; s.addr = (s.addr + 1) & 0xffff;
        this.portOut[0] = v; s.echo = v; s.index = (s.index + 1) & 0xff;
        return;
      }
      // a new command: another block, or start the uploaded program
      this.portOut[0] = v; s.echo = v; s.index = 0;
      s.addr = p[2] | (p[3] << 8);
      if (!p[1]) this.iplJump();
    }
  }

  private iplJump() {
    this.ipl.on = false;
    this.ram[0] = this.ipl.addr & 0xff; this.ram[1] = this.ipl.addr >> 8;
    this.pc = this.ipl.addr; this.a = 0; this.x = 0; this.y = 0; this.psw = 0x02;
  }

  // ------------------------------------------------------------------ execution
  /** run until `cycles` reaches `until` */
  run(until: number) {
    while (this.cycles < until) {
      let n: number;
      if (this.ipl.on) { this.iplStep(); n = 24; }
      else if (this.stopped) n = 24;
      else {
        if (this.pc >= 0xffc0 && (this.control & 0x80)) { this.iplReset(); continue; }
        n = this.step();
      }
      this.cycles += n;
      this.clock(n);
    }
  }

  private clock(n: number) {
    // timers: 0 and 1 at 8 kHz (every 128 cycles), 2 at 64 kHz (every 16)
    for (let t = 0; t < 3; t++) {
      this.timerDiv[t] += n;
      const per = t === 2 ? 16 : 128;
      while (this.timerDiv[t] >= per) {
        this.timerDiv[t] -= per;
        if ((this.control >> t) & 1) {
          const target = this.timerTarget[t] || 256;
          if (++this.timerStage[t] >= target) { this.timerStage[t] = 0; this.timerOut[t] = (this.timerOut[t] + 1) & 15; }
        }
      }
    }
    // DSP: one sample every 32 cycles
    this.dspCycles += n;
    while (this.dspCycles >= 32) { this.dspCycles -= 32; this.dsp.sample(); }
  }

  step(): number {
    const op = this.fetch();
    let extra = 0;
    const lo = op & 0x0f, hi = op >> 4;
    // the regular ALU block: OR/AND/EOR/CMP/ADC/SBC (rows 0-B, even/odd pairs), columns 4-9
    const aluOp = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5][hi];
    if (hi <= 0xb && lo >= 4 && lo <= 9) {
      const odd = hi & 1;
      switch (lo) {
        case 4: this.a = this.alu(aluOp, this.a, odd ? this.rdDp(this.fetch() + this.x) : this.rdDp(this.fetch())); break;
        case 5: { const a = this.fetchW(); this.a = this.alu(aluOp, this.a, this.rd(odd ? a + this.x : a)); break; }
        case 6: { if (odd) { const a = this.fetchW(); this.a = this.alu(aluOp, this.a, this.rd(a + this.y)); } else this.a = this.alu(aluOp, this.a, this.rdDp(this.x)); break; }
        case 7: {
          const d = this.fetch();
          const addr = odd ? (this.rdDpW(d) + this.y) : this.rdDpW((d + this.x) & 0xff);
          this.a = this.alu(aluOp, this.a, this.rd(addr)); break;
        }
        case 8: {
          if (odd) { const i = this.fetch(), d = this.fetch(); const r = this.alu(aluOp, this.rdDp(d), i); if (aluOp !== 3) this.wrDp(d, r); }
          else this.a = this.alu(aluOp, this.a, this.fetch());
          break;
        }
        case 9: {
          if (odd) { const d = this.dp(this.x), r = this.alu(aluOp, this.read(d), this.rdDp(this.y)); if (aluOp !== 3) this.write(d, r); }
          else { const s = this.fetch(), d = this.fetch(); const r = this.alu(aluOp, this.rdDp(d), this.rdDp(s)); if (aluOp !== 3) this.wrDp(d, r); }
          break;
        }
      }
      return CYCLES[op];
    }
    if (lo === 1) { // TCALL n
      this.push(this.pc >> 8); this.push(this.pc);
      const v = 0xffde - hi * 2; this.pc = this.rd(v) | (this.rd(v + 1) << 8);
      return CYCLES[op];
    }
    if (lo === 2) { // SET1 / CLR1 d.bit
      const d = this.fetch(), bit = hi >> 1, v = this.rdDp(d);
      this.wrDp(d, hi & 1 ? v & ~(1 << bit) : v | (1 << bit));
      return CYCLES[op];
    }
    if (lo === 3) { // BBS / BBC d.bit, rel
      const d = this.fetch(), bit = hi >> 1, v = (this.rdDp(d) >> bit) & 1;
      return CYCLES[op] + this.branch(hi & 1 ? !v : !!v);
    }
    switch (op) {
      case 0x00: break;
      case 0x0a: case 0x2a: case 0x4a: case 0x6a: case 0x8a: case 0xaa: {
        const [a, b] = this.memBit(); let bit = (this.rd(a) >> b) & 1;
        if (op === 0x2a || op === 0x6a) bit ^= 1;
        const c = this.psw & C;
        const r = op === 0x0a || op === 0x2a ? c | bit : op === 0x4a || op === 0x6a ? c & bit : op === 0x8a ? c ^ bit : bit;
        this.psw = (this.psw & ~C) | r; break;
      }
      case 0xca: { const [a, b] = this.memBit(); const v = this.rd(a); this.write(a, (v & ~(1 << b)) | ((this.psw & C) << b)); break; }
      case 0xea: { const [a, b] = this.memBit(); this.write(a, this.rd(a) ^ (1 << b)); break; }
      // shifts
      case 0x0b: case 0x2b: case 0x4b: case 0x6b: { const d = this.fetch(); this.wrDp(d, this.shift(hi >> 1, this.rdDp(d))); break; }
      case 0x1b: case 0x3b: case 0x5b: case 0x7b: { const d = (this.fetch() + this.x) & 0xff; this.wrDp(d, this.shift(hi >> 1, this.rdDp(d))); break; }
      case 0x0c: case 0x2c: case 0x4c: case 0x6c: { const a = this.fetchW(); this.write(a, this.shift(hi >> 1, this.rd(a))); break; }
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: this.a = this.shift(hi >> 1, this.a); break;
      // push / pop
      case 0x0d: this.push(this.psw); break;
      case 0x2d: this.push(this.a); break;
      case 0x4d: this.push(this.x); break;
      case 0x6d: this.push(this.y); break;
      case 0x8e: this.psw = this.pop(); break;
      case 0xae: this.a = this.pop(); break;
      case 0xce: this.x = this.pop(); break;
      case 0xee: this.y = this.pop(); break;
      // test-and-set/clear
      case 0x0e: case 0x4e: { const a = this.fetchW(), v = this.rd(a); this.nz((this.a - v) & 0xff); this.write(a, op === 0x0e ? v | this.a : v & ~this.a); break; }
      case 0x0f: { // BRK
        this.push(this.pc >> 8); this.push(this.pc); this.push(this.psw);
        this.psw = (this.psw | B) & ~I; this.pc = this.rd(0xffde) | (this.rd(0xffdf) << 8); break;
      }
      // branches
      case 0x10: extra = this.branch(!(this.psw & N)); break;
      case 0x30: extra = this.branch(!!(this.psw & N)); break;
      case 0x50: extra = this.branch(!(this.psw & V)); break;
      case 0x70: extra = this.branch(!!(this.psw & V)); break;
      case 0x90: extra = this.branch(!(this.psw & C)); break;
      case 0xb0: extra = this.branch(!!(this.psw & C)); break;
      case 0xd0: extra = this.branch(!(this.psw & Z)); break;
      case 0xf0: extra = this.branch(!!(this.psw & Z)); break;
      case 0x2f: this.branch(true); break;
      // word ops
      case 0x1a: case 0x3a: { const d = this.fetch(); const w = (this.rdDpW(d) + (op === 0x3a ? 1 : -1)) & 0xffff; this.wrDp(d, w); this.wrDp((d + 1) & 0xff, w >> 8); this.nzw(w); break; }
      case 0x5a: { const w = this.rdDpW(this.fetch()), ya = (this.y << 8) | this.a, r = ya - w; this.psw = (this.psw & ~C) | (r >= 0 ? C : 0); this.nzw(r & 0xffff); break; }
      case 0x7a: case 0x9a: {
        const w = this.rdDpW(this.fetch()), ya = (this.y << 8) | this.a;
        let r: number;
        this.psw &= ~(V | H | C);
        if (op === 0x7a) {
          r = ya + w;
          if (r > 0xffff) this.psw |= C;
          if (((ya & 0xfff) + (w & 0xfff)) > 0xfff) this.psw |= H;
          if (~(ya ^ w) & (ya ^ r) & 0x8000) this.psw |= V;
        } else {
          r = ya - w;
          if (r >= 0) this.psw |= C;
          if ((ya & 0xfff) - (w & 0xfff) >= 0) this.psw |= H;
          if ((ya ^ w) & (ya ^ r) & 0x8000) this.psw |= V;
        }
        r &= 0xffff; this.a = r & 0xff; this.y = r >> 8; this.nzw(r); break;
      }
      case 0xba: { const w = this.rdDpW(this.fetch()); this.a = w & 0xff; this.y = w >> 8; this.nzw(w); break; }
      case 0xda: { const d = this.fetch(); this.wrDp(d, this.a); this.wrDp((d + 1) & 0xff, this.y); break; }
      // compares with X / Y
      case 0x1e: this.cmp(this.x, this.rd(this.fetchW())); break;
      case 0x3e: this.cmp(this.x, this.rdDp(this.fetch())); break;
      case 0x5e: this.cmp(this.y, this.rd(this.fetchW())); break;
      case 0x7e: this.cmp(this.y, this.rdDp(this.fetch())); break;
      case 0xc8: this.cmp(this.x, this.fetch()); break;
      case 0xad: this.cmp(this.y, this.fetch()); break;
      // jumps / calls
      case 0x1f: { const a = (this.fetchW() + this.x) & 0xffff; this.pc = this.rd(a) | (this.rd(a + 1) << 8); break; }
      case 0x5f: this.pc = this.fetchW(); break;
      case 0x3f: { const a = this.fetchW(); this.push(this.pc >> 8); this.push(this.pc); this.pc = a; break; }
      case 0x4f: { const u = this.fetch(); this.push(this.pc >> 8); this.push(this.pc); this.pc = 0xff00 | u; break; }
      case 0x6f: { const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      case 0x7f: { this.psw = this.pop(); const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      // inc / dec
      case 0x1d: this.x = this.nz(this.x - 1); break;
      case 0x3d: this.x = this.nz(this.x + 1); break;
      case 0xdc: this.y = this.nz(this.y - 1); break;
      case 0xfc: this.y = this.nz(this.y + 1); break;
      case 0x9c: this.a = this.nz(this.a - 1); break;
      case 0xbc: this.a = this.nz(this.a + 1); break;
      case 0x8b: { const d = this.fetch(); this.wrDp(d, this.nz(this.rdDp(d) - 1)); break; }
      case 0xab: { const d = this.fetch(); this.wrDp(d, this.nz(this.rdDp(d) + 1)); break; }
      case 0x9b: { const d = (this.fetch() + this.x) & 0xff; this.wrDp(d, this.nz(this.rdDp(d) - 1)); break; }
      case 0xbb: { const d = (this.fetch() + this.x) & 0xff; this.wrDp(d, this.nz(this.rdDp(d) + 1)); break; }
      case 0x8c: { const a = this.fetchW(); this.write(a, this.nz(this.rd(a) - 1)); break; }
      case 0xac: { const a = this.fetchW(); this.write(a, this.nz(this.rd(a) + 1)); break; }
      // flags
      case 0x20: this.psw &= ~P; break;
      case 0x40: this.psw |= P; break;
      case 0x60: this.psw &= ~C; break;
      case 0x80: this.psw |= C; break;
      case 0xa0: this.psw |= I; break;
      case 0xc0: this.psw &= ~I; break;
      case 0xe0: this.psw &= ~(V | H); break;
      case 0xed: this.psw ^= C; break;
      // CBNE / DBNZ
      case 0x2e: { const d = this.fetch(); extra = this.branch(this.a !== this.rdDp(d)); break; }
      case 0xde: { const d = (this.fetch() + this.x) & 0xff; extra = this.branch(this.a !== this.rdDp(d)); break; }
      case 0x6e: { const d = this.fetch(), v = (this.rdDp(d) - 1) & 0xff; this.wrDp(d, v); extra = this.branch(v !== 0); break; }
      case 0xfe: { this.y = (this.y - 1) & 0xff; extra = this.branch(this.y !== 0); break; }
      // register moves
      case 0x5d: this.x = this.nz(this.a); break;
      case 0x7d: this.a = this.nz(this.x); break;
      case 0xdd: this.a = this.nz(this.y); break;
      case 0xfd: this.y = this.nz(this.a); break;
      case 0x9d: this.x = this.nz(this.sp); break;
      case 0xbd: this.sp = this.x; break;
      // immediate loads
      case 0x8d: this.y = this.nz(this.fetch()); break;
      case 0xcd: this.x = this.nz(this.fetch()); break;
      case 0xe8: this.a = this.nz(this.fetch()); break;
      case 0x8f: { const i = this.fetch(), d = this.fetch(); this.wrDp(d, i); break; }
      case 0xfa: { const s = this.fetch(), d = this.fetch(); this.wrDp(d, this.rdDp(s)); break; }
      // loads
      case 0xe4: this.a = this.nz(this.rdDp(this.fetch())); break;
      case 0xe5: this.a = this.nz(this.rd(this.fetchW())); break;
      case 0xe6: this.a = this.nz(this.rdDp(this.x)); break;
      case 0xe7: this.a = this.nz(this.rd(this.rdDpW((this.fetch() + this.x) & 0xff))); break;
      case 0xf4: this.a = this.nz(this.rdDp(this.fetch() + this.x)); break;
      case 0xf5: this.a = this.nz(this.rd(this.fetchW() + this.x)); break;
      case 0xf6: this.a = this.nz(this.rd(this.fetchW() + this.y)); break;
      case 0xf7: this.a = this.nz(this.rd(this.rdDpW(this.fetch()) + this.y)); break;
      case 0xbf: this.a = this.nz(this.rdDp(this.x)); this.x = (this.x + 1) & 0xff; break;
      case 0xe9: this.x = this.nz(this.rd(this.fetchW())); break;
      case 0xf8: this.x = this.nz(this.rdDp(this.fetch())); break;
      case 0xf9: this.x = this.nz(this.rdDp(this.fetch() + this.y)); break;
      case 0xeb: this.y = this.nz(this.rdDp(this.fetch())); break;
      case 0xec: this.y = this.nz(this.rd(this.fetchW())); break;
      case 0xfb: this.y = this.nz(this.rdDp(this.fetch() + this.x)); break;
      // stores
      case 0xc4: this.wrDp(this.fetch(), this.a); break;
      case 0xc5: this.write(this.fetchW(), this.a); break;
      case 0xc6: this.wrDp(this.x, this.a); break;
      case 0xc7: this.write(this.rdDpW((this.fetch() + this.x) & 0xff), this.a); break;
      case 0xd4: this.wrDp(this.fetch() + this.x, this.a); break;
      case 0xd5: this.write((this.fetchW() + this.x) & 0xffff, this.a); break;
      case 0xd6: this.write((this.fetchW() + this.y) & 0xffff, this.a); break;
      case 0xd7: this.write((this.rdDpW(this.fetch()) + this.y) & 0xffff, this.a); break;
      case 0xaf: this.wrDp(this.x, this.a); this.x = (this.x + 1) & 0xff; break;
      case 0xc9: this.write(this.fetchW(), this.x); break;
      case 0xd8: this.wrDp(this.fetch(), this.x); break;
      case 0xd9: this.wrDp(this.fetch() + this.y, this.x); break;
      case 0xcb: this.wrDp(this.fetch(), this.y); break;
      case 0xcc: this.write(this.fetchW(), this.y); break;
      case 0xdb: this.wrDp(this.fetch() + this.x, this.y); break;
      // arithmetic specials
      case 0xcf: { const r = this.y * this.a; this.a = r & 0xff; this.y = r >> 8; this.nz(this.y); break; }
      case 0x9e: {
        const ya = (this.y << 8) | this.a, x = this.x;
        this.psw &= ~(V | H);
        if (this.y >= x) this.psw |= V;
        if ((this.y & 15) >= (x & 15)) this.psw |= H;
        if (this.y < (x << 1)) { this.a = Math.floor(ya / x) & 0xff; this.y = ya % x; }
        else { this.a = (255 - Math.floor((ya - (x << 9)) / (256 - x))) & 0xff; this.y = (x + ((ya - (x << 9)) % (256 - x))) & 0xff; }
        this.nz(this.a); break;
      }
      case 0x9f: this.a = this.nz(((this.a >> 4) | (this.a << 4)) & 0xff); break;
      case 0xdf: {
        if ((this.psw & C) || this.a > 0x99) { this.a = (this.a + 0x60) & 0xff; this.psw |= C; }
        if ((this.psw & H) || (this.a & 15) > 9) this.a = (this.a + 6) & 0xff;
        this.nz(this.a); break;
      }
      case 0xbe: {
        if (!(this.psw & C) || this.a > 0x99) { this.a = (this.a - 0x60) & 0xff; this.psw &= ~C; }
        if (!(this.psw & H) || (this.a & 15) > 9) this.a = (this.a - 6) & 0xff;
        this.nz(this.a); break;
      }
      case 0xef: case 0xff: this.stopped = true; break; // SLEEP / STOP
    }
    return CYCLES[op] + extra;
  }

  private nzw(w: number) { this.psw = (this.psw & ~(N | Z)) | ((w >> 8) & 0x80) | (w & 0xffff ? 0 : Z); }
}
