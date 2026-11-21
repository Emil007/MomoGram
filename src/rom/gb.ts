// Game Boy / Game Boy Color: header checks and the game's own music, shared by the Game Boy importers.
import { Pack } from '../packs/format';
import { gbPackMusic } from '../audio/gb/games';

/** the cartridge header title (0x134) */
export const gbTitle = (d: Uint8Array) => String.fromCharCode(...d.subarray(0x134, 0x143)).replace(/\0.*$/, '').trim();
/** a Game Boy ROM: the Nintendo logo starts at 0x104 */
export const isGb = (d: Uint8Array) => d.length >= 0x8000 && d[0x104] === 0xce && d[0x105] === 0xed && d[0x106] === 0x66;

/** the game's own music, played by MomoGram's Game Boy sound emulation (src/audio/gb) */
export function gbWithMusic(p: Pack, rom: Uint8Array): Pack {
  let m = null;
  try { m = gbPackMusic(rom); } catch (e) { console.warn('GB music', e); }
  if (m) { p.theme = { ...p.theme, music: m.music, songs: m.songs }; p.assets = [...(p.assets ?? []), m.asset]; }
  return p;
}
