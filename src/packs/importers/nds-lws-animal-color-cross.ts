// Animal Color Cross (Little Worlds Studio, DSiWare). Only its built-in manual graphics
// (eManual blocks) decode today; the puzzle data is behind a proprietary "LWS ARC V1.3"
// codec that is not yet implemented here (see ANALYSIS.md).
//
//  Game                                    File (recognised by)   Puzzles
//  Animal Color Cross (EU / US DSiWare)    game code KCCE (KCCEUX / KCCPUX),                             72 (8 colour sets,
//                                          NDSi cartridge image "ANIMALCC", logo CRC 0xcf56)              max 8 colours, 20x25)
//
// What we verified byte-for-byte (2026-11-24):
//   - The image is a plaintext NDS/DSi cartridge (NOT 3DS-encrypted): FNT @0x98800, FAT @0x98a00.
//   - Root files: DataArchive.lwc (game data, proprietary "LW ARC V1.3" container, 0x1cc858 bytes),
//     eManual/m2dres_narc.blz, eManual/NOA|NOE/manpages_narc.blz, Sounds/*. Results below.
//   - m2dres/manpages are standard Nintendo BLZ (backwards LZ, same as src/rom/nds.ts blzDecompress)
//     around a NARC with inverted block tags BTAF/BTNF; they decompress cleanly (shown in VERIFIED.md).
//   - The 72 colour puzzles live in DataArchive.lwc as LWS resources ("LW ARC V1.3" / "FCRA" /
//     "Texture V1.2" / "Scene V1.7" / "Text Chunk V1.1"); their payloads use a custom Little Worlds
//     codec.  The archive also embeds the very NARC blobs found standalone, but *re-encoded* with that
//     codec (an embedded manpages chunk declares 0x2f64 = 77668 bytes, exactly the standalone size, yet
//     its bytes differ from both the standalone compressed and decompressed stream — it is neither
//     LZ10/LZ11/BLZ/zlib/RLE; the extra 0xff bytes and u16-run tokens are framing of a proprietary LZ).
//   - Until the LWS codec is reversed, the importer cannot produce a useful pack: without the solution
//     pictures the (coloured) clue numbers cannot be derived, and there is no plaintext puzzle table.
import { registerImporter } from './index';
import { Pack } from '../format';
import { NdsRom, u16, u32 } from '../../rom/nds';

// the game code's own resource tags, byte-verified from the container:
//   ".REV" container header, "LW ARC V1.3", "FCRA" index, reversed 4-char tags in the ARM9
//   ("DIPS SXDI TLAP LXET" stored at 0x3da0c = "SPID IDXS PALT TEXL" read big-endian).
const LWS_ARC = 'LW ARC V1.3';

registerImporter({
  name: 'Animal Color Cross (Little Worlds Studio, DSiWare)',
  version: 1, // raise when the LWS codec is added and puzzles actually start being read
  detect: d => {
    // a DSi cartridge image whose root archive is DataArchive.lwc with an LWS ARC header
    if (!NdsRom.looksLike(d)) return false;
    const rom = new NdsRom(d);
    if (rom.gameCode.slice(0, 4) !== 'KCCE') return false;
    const arc = rom.fileByName('DataArchive.lwc');
    if (!arc) return false;
    const desc = new TextDecoder('latin1').decode(arc.subarray(0x10, 0x10 + LWS_ARC.length));
    return desc === LWS_ARC;
  },
  read: (d: Uint8Array, fileName: string): Pack[] => {
    const rom = new NdsRom(d);
    const arc = rom.fileByName('DataArchive.lwc');
    if (!arc) throw new Error('Puzzles not found.');
    // Directory table at 0x28 (u16 count at 0x26); each u32 is an offset into the payload.
    const count = u16(arc, 0x26);
    // Byte-verified: embedded NARC blobs at 0x2cd/0x122ac/0x2aa63/0x33c62 are re-encoded copies of the
    // standalone *.blz files (same sizes: 0x012f64/0x018e98/0x00a688) but NOT byte-equal, so the payload
    // bytes are transformed by the proprietary LWS codec, which is not implemented yet.
    void count;
    throw new Error(
      'Puzzles not found. Animal Color Cross stores its 72 colour puzzles inside DataArchive.lwc in the ' +
      'proprietary Little Worlds "LW ARC V1.3" codec, which is not implemented yet. ' +
      '(The eManual/*.blz graphics decode as plain NARC/BLZ; the puzzles themselves do not.)',
    );
  },
});
