// Super Famicom / Satellaview: header and the game's own music, shared by the Super Famicom importers.
import { Pack } from '../packs/format';
import { snesPackMusic } from '../audio/snes/games';

/** the internal header title (HiROM, 0xFFC0) */
export const sfcHeaderTitle = (d: Uint8Array) => d.length >= 0x10000 ? String.fromCharCode(...d.subarray(0xffc0, 0xffd5)) : '';

/** the game's own music, played by MomoGram's SPC700 / S-DSP emulation (src/audio/snes) */
export async function sfcWithMusic(p: Pack, rom: Uint8Array): Promise<Pack> {
  try {
    const m = await snesPackMusic(rom, () => new Promise(r => setTimeout(r, 0)));
    if (m) { p.theme = { ...p.theme, music: m.music }; p.assets = [...(p.assets ?? []), m.asset]; }
  } catch (e) { console.warn('SNES music', e); }
  return p;
}
