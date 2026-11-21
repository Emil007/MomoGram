// Picross DS (Nintendo DS, 2007) and its Download Station / Nintendo Channel demos.
//
//  Game                  File (recognised by)                     Data (see src/rom/picrossds.ts)
//  Picross DS (all       game code AXP? or ROM title "PICROSS"    puzzles, names in every language of the
//    regions)                                                       release, Daily sets, solved-picture
//                                                                   animations (anim.pck), music (SDAT), icon
//  Picross DS demos      same, without the full game's files      the demo's puzzles and Japanese titles
import { registerImporter } from './index';
import { makeIcon } from '../format';
import { NdsRom } from '../../rom/nds';
import { readPicrossDs, readPicrossDsDemo, dsToPack } from '../../rom/picrossds';

registerImporter({
  name: 'Picross DS',
  detect: d => NdsRom.looksLike(d) && new NdsRom(d).gameCode.startsWith('AXP') || (NdsRom.looksLike(d) && new NdsRom(d).title.startsWith('PICROSS')),
  read: d => {
    const px = new NdsRom(d).icon();
    const icon = px ? makeIcon(32, 32, px) : undefined;
    let ds;
    try { ds = readPicrossDs(d); } catch { return [{ ...readPicrossDsDemo(d), icon }]; }
    // puzzles, names, daily sets, solved-picture animations, music and icon; the ROM itself is not kept
    return [{ ...dsToPack(ds), icon }];
  },
});
