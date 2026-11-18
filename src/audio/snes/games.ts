// Music of the Super Famicom / Satellaview nonogram games (Jupiter). All of them use the same sound engine: a
// 65816 library in its own ROM bank (entry at bank:$0000, A = command, Y = parameter; command $13 starts song Y,
// $1A stops the music) that uploads an SPC700 driver through the boot ROM protocol, then song data through its
// own handshake. Song numbers with bit 6 set loop, the others are one-shot jingles.
//
// When a pack is created, MomoGram boots the user's ROM on the emulated console until the game has loaded its
// sound driver, then calls the game's own "play song" routine for each song it needs and keeps a snapshot of
// the sound system (SPC700 RAM and registers, S-DSP state) right after the call. Only the sound system state is
// kept (compressed, in the user's pack): playback then runs the SPC700 + S-DSP emulation from that snapshot.
import { zlibSync, unzlibSync, strToU8, strFromU8 } from 'fflate';
import { Snes } from './snes';
import { Spc } from './spc700';

/** the sound library's bank (HiROM bank number $C0..), found by its boot-ROM upload routine */
export function findSoundBank(rom: Uint8Array): number {
  const r = rom.length % 0x8000 === 512 ? rom.subarray(512) : rom;
  for (let b = 0; b * 0x10000 + 0x0450 < r.length; b++) {
    const o = b * 0x10000 + 0x0444;
    // lda #$bbaa ; cmp $002140
    if (r[o] === 0xa9 && r[o + 1] === 0xaa && r[o + 2] === 0xbb && r[o + 3] === 0xcf && r[o + 4] === 0x40 && r[o + 5] === 0x21 && r[b * 0x10000] === 0x80) return 0xc0 | b;
  }
  return -1;
}

type Role = 'menu' | 'play' | 'play2' | 'clear' | 'title';
// Found by tracing which songs each game requests on its title screen, menus and puzzle screen (the puzzle
// music comes from the game's own music table) and checked numerically (looping vs. one-shot, duration).
const GAMES: Array<[RegExp, Partial<Record<Role, number>>]> = [
  [/^SUPER PICROSS/, { title: 0x42, menu: 0x44, play: 0x41, clear: 0x10 }],
  [/^PICROSS NP/, { title: 0x42, menu: 0x4a, play: 0x40, play2: 0x41, clear: 0x05 }],
  [/TAMORI|\xc0\xd3\xd8/, { title: 0x42, menu: 0x4a, play: 0x40, play2: 0x41, clear: 0x05 }],
];

function headerTitle(rom: Uint8Array): string {
  const r = rom.length % 0x8000 === 512 ? rom.subarray(512) : rom;
  const h = Snes.isHiRom(r) ? 0xffc0 : 0x7fc0;
  return String.fromCharCode(...r.subarray(h, h + 21)).trim();
}

const STOP = (entry: number) => [0xa9, 0x1a, 0x00, 0xa0, 0x00, 0x00, 0x22, entry & 0xff, (entry >> 8) & 0xff, entry >> 16];
const PLAY = (entry: number, n: number) => [0xa9, 0x13, 0x00, 0xa0, n & 0xff, 0x00, 0x22, entry & 0xff, (entry >> 8) & 0xff, entry >> 16];

/**
 * Boot the game and capture sound-system snapshots for `songs`. `yieldFn` is awaited between steps so the
 * page stays responsive. Returns null if the game never loaded its sound driver.
 */
export async function captureSongs(rom: Uint8Array, songs: number[], yieldFn: () => Promise<void> = async () => {}): Promise<Uint8Array | null> {
  const bank = findSoundBank(rom);
  if (bank < 0) return null;
  const entry = bank << 16;
  const s = new Snes(rom);
  // boot until the game has started a song of its own and is not inside the sound library
  let played = false, since = 0;
  const step = s.cpu.step.bind(s.cpu);
  (s.cpu as { step: () => void }).step = () => { if (s.cpu.pb === bank && s.cpu.pc === 0 && (s.cpu.a & 0xff) === 0x13) played = true; step(); };
  for (let f = 0; f < 2400 && (!played || f < 200 || since < 60 || s.cpu.pb === bank); f++) {
    s.runFrame();
    if (played) since++;
    if (f % 120 === 119) await yieldFn();
  }
  (s.cpu as { step: () => void }).step = step;
  if (s.spc.ipl.on) return null;
  const states: Array<{ song: number; state: unknown }> = [];
  const rams: Uint8Array[] = [];
  for (const n of songs) {
    if (!s.callCode([0xc2, 0x30, ...STOP(entry), ...PLAY(entry, n), 0xdb], 900)) continue;
    states.push({ song: n, state: s.spc.saveState() });
    rams.push(s.spc.ram.slice());
    await yieldFn();
  }
  if (!states.length) return null;
  // RAM images after the first are stored as differences to it (mostly zero), then everything is deflated
  const json = strToU8(JSON.stringify({ v: 1, songs: states }));
  const out = new Uint8Array(8 + json.length + rams.length * 0x10000);
  out.set([0x4d, 0x53, 0x50, 0x43]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  rams.forEach((r, i) => {
    const o = 8 + json.length + i * 0x10000;
    for (let k = 0; k < 0x10000; k++) out[o + k] = i ? r[k] ^ rams[0][k] : r[k];
  });
  return zlibSync(out, { level: 9 });
}

/** restore the snapshot of `song` into a fresh SPC */
export function loadSong(asset: Uint8Array, song: number): Spc | null {
  const d = unzlibSync(asset);
  if (d[0] !== 0x4d || d[1] !== 0x53 || d[2] !== 0x50 || d[3] !== 0x43) return null;
  const len = new DataView(d.buffer, d.byteOffset).getUint32(4, true);
  const meta = JSON.parse(strFromU8(d.subarray(8, 8 + len))) as { songs: Array<{ song: number; state: unknown }> };
  const i = meta.songs.findIndex(x => x.song === song);
  if (i < 0) return null;
  const base = 8 + len, ram = d.slice(base, base + 0x10000);
  if (i) { const o = base + i * 0x10000; for (let k = 0; k < 0x10000; k++) ram[k] ^= d[o + k]; }
  const spc = new Spc();
  spc.loadState(meta.songs[i].state, ram);
  return spc;
}

/** music for a pack made from a Super Famicom / Satellaview nonogram game */
export async function snesPackMusic(rom: Uint8Array, yieldFn?: () => Promise<void>): Promise<{ asset: { name: string; data: Uint8Array }; music: Record<string, string> } | null> {
  const title = headerTitle(rom);
  const roles = GAMES.find(([re]) => re.test(title))?.[1] ?? (findSoundBank(rom) >= 0 ? GAMES[1][1] : null);
  if (!roles) return null;
  const songs = [...new Set(Object.values(roles))] as number[];
  const data = await captureSongs(rom, songs, yieldFn);
  if (!data) return null;
  const name = 'sound.spcsnap';
  const music: Record<string, string> = {};
  for (const [role, n] of Object.entries(roles)) music[role] = `${name}#spc:${n}`;
  return { asset: { name, data }, music };
}

/** plays one song from a snapshot, resampled from the S-DSP's 32 kHz to the output rate */
export class SpcMusic {
  private pos = 0; // fractional read position in the DSP output
  private readonly step: number;
  constructor(private spc: Spc, sampleRate: number) { this.step = 32000 / sampleRate; }

  render(dst: Float32Array, frames: number) {
    const dsp = this.spc.dsp;
    const need = Math.ceil(this.pos + frames * this.step) + 2;
    while (dsp.outLen / 2 < need) this.spc.run(this.spc.cycles + 32 * 64);
    const o = dsp.out, k = 1 / 32768 * 0.9;
    let p = this.pos;
    for (let i = 0; i < frames; i++) {
      const j = p | 0, f = p - j;
      dst[i * 2] = (o[j * 2] + (o[j * 2 + 2] - o[j * 2]) * f) * k;
      dst[i * 2 + 1] = (o[j * 2 + 1] + (o[j * 2 + 3] - o[j * 2 + 1]) * f) * k;
      p += this.step;
    }
    // drop consumed samples
    const used = p | 0;
    o.copyWithin(0, used * 2, dsp.outLen);
    dsp.outLen -= used * 2;
    this.pos = p - used;
  }
}
