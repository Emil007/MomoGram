// Sound drivers of the Game Boy nonogram games, located by byte patterns in the user's ROM (no addresses or game
// data are stored here, so regional versions with shifted code work too).
import { GbDriver } from './music';

/** find `pat` (numbers, or -1 for any byte) in d[from..to) */
export function findPattern(d: Uint8Array, pat: number[], from = 0, to = d.length): number {
  outer: for (let i = from; i + pat.length <= to; i++) {
    for (let k = 0; k < pat.length; k++) if (pat[k] >= 0 && d[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

const _ = -1;

/**
 * Jupiter's Game Boy nonogram games use Toshiyuki Ueno's "DSEQ" sound driver. Bank 0 has two wrappers that switch
 * to the driver's bank: `request(A = command, C = parameter)` (command 0 resets, 1 starts song C, 0 stops) and
 * `update()` (called from VBlank). MomoGram calls them like a GBS player.
 */
export function findDseq(rom: Uint8Array): GbDriver | null {
  let sig = false;
  for (let b = 1; b * 0x4000 < rom.length && !sig; b++) sig = findPattern(rom, [0x44, 0x53, 0x45, 0x51], b * 0x4000, b * 0x4000 + 0x40) >= 0;
  if (!sig) return null;
  const PUSH = [0xf5, 0xc5, 0xd5, 0xe5];
  /** the routine (starting with push af/bc/de/hl) that contains a call to `target` in the driver bank */
  const wrapper = (target: number): number => {
    for (let i = 0; ; ) {
      const c = findPattern(rom, [0xcd, target & 0xff, target >> 8], i, 0x4000);
      if (c < 0) return -1;
      // nearest preceding push sequence with no `ret` in between
      for (let p = c - 4; p > c - 96 && p >= 0 && rom[p + 3] !== 0xc9; p--) if (findPattern(rom, PUSH, p, p + 4) === p) return p;
      i = c + 1;
    }
  };
  const upd = wrapper(0x4003), req = wrapper(0x4000);
  if (upd < 0 || req < 0) return null;
  const cgb = (rom[0x143] & 0x80) !== 0;
  // Pokemon Picross keeps songs >= $80 in a second copy of the driver: select it first, then reset that copy
  return {
    init: [],
    start: n => [{ pc: req, a: 1, c: n & 0x80 }, { pc: req, a: 0, c: 0 }, { pc: req, a: 1, c: n }],
    update: { pc: upd },
    rate: 59.73,
    cgb,
  };
}

// ------------------------------------------------------------------ sound asset
// MomoGram keeps only what the sound driver needs from the user's ROM: bank 0 (the wrappers) and the banks holding
// a copy of the driver with its songs. Format: "MGB1", bank count, bank numbers (u16 LE), then 16 KiB per bank.

export function soundBanks(rom: Uint8Array): number[] {
  const out = [0];
  for (let b = 1; b * 0x4000 < rom.length; b++) if (findPattern(rom, [0x44, 0x53, 0x45, 0x51], b * 0x4000, b * 0x4000 + 0x40) >= 0) out.push(b);
  return out;
}

export function packSoundRom(rom: Uint8Array): Uint8Array {
  const banks = soundBanks(rom);
  const out = new Uint8Array(5 + banks.length * 2 + banks.length * 0x4000);
  out.set([0x4d, 0x47, 0x42, 0x31, banks.length]);
  banks.forEach((b, i) => { out[5 + i * 2] = b & 0xff; out[6 + i * 2] = b >> 8; out.set(rom.subarray(b * 0x4000, b * 0x4000 + 0x4000), 5 + banks.length * 2 + i * 0x4000); });
  return out;
}

/** rebuild a (sparse) ROM image from a sound asset, or pass a plain ROM through */
export function unpackSoundRom(d: Uint8Array): Uint8Array {
  if (!(d[0] === 0x4d && d[1] === 0x47 && d[2] === 0x42 && d[3] === 0x31)) return d;
  const n = d[4], banks: number[] = [];
  for (let i = 0; i < n; i++) banks.push(d[5 + i * 2] | (d[6 + i * 2] << 8));
  let size = 0x8000;
  while (size < (Math.max(...banks) + 1) * 0x4000) size *= 2;
  const rom = new Uint8Array(size).fill(0xff);
  banks.forEach((b, i) => rom.set(d.subarray(5 + n * 2 + i * 0x4000, 5 + n * 2 + (i + 1) * 0x4000), b * 0x4000));
  return rom;
}

// ------------------------------------------------------------------ songs per game
// Song numbers were found by tracing which songs each game requests on its title screen, menus, puzzle screen
// (the game's own music table) and after a solved puzzle, then checked numerically (looping vs. one-shot).
type Roles = Partial<Record<'menu' | 'play' | 'play2' | 'clear' | 'title', number>>;
const ROLES: Array<[RegExp, Roles]> = [
  [/^MARIO'?S PICROSS/, { title: 0x0a, menu: 0x0d, play: 0x02, play2: 0x05, clear: 0x08 }],
  [/^PICROSS 2/, { title: 0x14, menu: 0x05, play: 0x0c, play2: 0x0d, clear: 0x15 }],
  [/^POKEPICROSS/, { title: 0x01, menu: 0x03, play: 0x04, clear: 0x0b }],
];

/** music for a pack made from a Game Boy nonogram game: the sound asset and the refs per role */
export function gbPackMusic(rom: Uint8Array): { asset: { name: string; data: Uint8Array }; music: Record<string, string> } | null {
  const title = String.fromCharCode(...rom.subarray(0x134, 0x143)).replace(/\0.*$/, '');
  const roles = ROLES.find(([re]) => re.test(title))?.[1];
  if (!roles || !findDseq(rom)) return null;
  const name = 'sound.gbsnd';
  const music: Record<string, string> = {};
  for (const [role, n] of Object.entries(roles)) music[role] = `${name}#gb:${n}`;
  return { asset: { name, data: packSoundRom(rom) }, music };
}
