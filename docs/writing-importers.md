# Adding a game: writing an importer

MomoGram makes its packs from the player's own game files. An importer recognises a game file and reads its puzzles into a [pack](momopack-format.md). This page explains how to add one.

## Where the importers are

```
src/packs/importers/
  index.ts                  the registry: the Importer interface, registerImporter, importGameFile
  all.ts                    written by build.mjs: loads every other file here (don't edit)
  gb-picross.ts             one file per import method …
  gbc-pokemon-picross.ts
  sfc-picross.ts
  sfc-picross-np.ts
  nds-picross-ds.ts
  nds-hudson-illust-logic.ts
  nds-ds-puzzler.ts
  nds-illu-logi-vow.ts
  nds-hello-kitty-logic.ts
  nsw-picross-s.ts          Switch games: a folder, read with registerSetImporter (see below)
  ctr-picross.ts
src/rom/                    shared readers for the systems: headers, containers, compression, music
  gb.ts  sfc.ts  nds.ts  ctr.ts  jtex.ts  dsgfx.ts
```

Each file in `importers/` is one way of reading puzzles. When several games store their puzzles the same way, they share a file. For example, Mario's Picross and Picross 2 share `gb-picross.ts`, and all the 3DS games share `ctr-picross.ts`. A game stored differently gets a file of its own.

File names are `<system>-<method>.ts`. The system prefixes are `gb`, `gbc`, `sfc`, `nds` and `ctr` (3DS), following the systems' own codes.

## The header table

Every importer file starts with a comment. It tells a reader, without reading code, which games the file reads, how each one is recognised and where its data is. Example from `gb-picross.ts`:

```ts
// Game Boy nonogram games by Jupiter that store each puzzle as a 32-byte record.
//
// Record: width, height, then 15 rows of 16 bits (most significant bit = left column).
//
//  Game                         File (recognised by)                 Puzzles
//  Mario's Picross (USA/EUR)    header title "MARIO'S PICROSS"       longest run of records sized 5/10/15 (>= 256):
//  Mario no Picross (JPN)       header title "MARIO.S PICROSS"         Easy 64, Kinoko 64, Star 64, Time Trial 64
//  Picross 2 (JPN)              header title "PICROSS 2"             the two runs of >= 64 15x15 records (Mario, Wario),
//                                                                      four records = one 30x30 picture
```

When you add a game to an existing method, add its row to the table. Write down offsets, record layouts, file names inside containers, and the order of the modes, including anything learned the hard way. Prefer finding data by its structure (a table that validates) over fixed offsets: then other regions and revisions work too. Where a fixed offset is needed, list it per revision in the table.

## The interface

```ts
import { registerImporter } from './index';
import { Pack } from '../format';

registerImporter({
  name: 'My Game (System)',          // shown when a file is read, and in error messages
  version: 1,                        // raise it whenever the importer reads more or differently: a file read by
                                     // the same version is skipped on the next import ("already read")
  detect(data, fileName) {           // fast: header bytes or a title, never a full parse
    return …;
  },
  read(data, fileName): Pack[] {     // may be async; may return several packs (one file, several games)
    …
  },
  upgrade(pack) {                    // optional: brings a pack stored by an older version up to date without the
    return false;                    // game file (a renamed field, a fixed title); true when it changed the pack
  },
});
```

Games that are a folder rather than one file (Switch RomFS) use `registerSetImporter({ name, find, read })`
instead: `find(paths)` returns the root folder of each game among the picked files (a folder, a zip, or a single
file), and `read(files, root)` gets the files lazily through `files.get(path)`.

`importGameFile` asks each importer's `detect` in turn. The first one that returns true and then returns at least one pack wins. If its `read` throws, the error message is shown to the player, so write it for them (for example `'Puzzle table not found.'`).

A new file is picked up on the next `node build.mjs`, which regenerates `all.ts`. No other file needs changing.

## Building the pack

Use the types in `src/packs/format.ts`; the [format description](momopack-format.md) explains every field. The rules that matter most:

- **Ids are forever.** `pack.id` names the game (for example `sfc-picross-np-3`). The same game from another region must get the same id, so regions merge into one pack. Puzzle ids must stay the same in every later version of the importer, because players' progress is stored under them. Name them after the game's own structure (`easy-3B`, `10x10-07`), never after a running index that could shift.
- **Rows** are strings of `#` and `.`. `rowsFromBits(w, h, (x, y) => bool)` builds them from any bit layout.
- **Names** (`puzzle.name`) are only shown after the puzzle is solved. Include every language the game has.
- **Modes**: levels with the same `group` form one mode. `extra`, `unlockAfter` and `rules` imitate the game's unlocks and its rules (whether mistakes are caught).
- **Look and sound**: `theme.palette` imitates the game's colours. Music goes into `assets` and is referenced from `theme.music`. For Game Boy and Super Famicom, `gbWithMusic(pack, rom)` / `sfcWithMusic(pack, rom)` do this when the game's sound driver is known (`src/audio/gb/games.ts`, `src/audio/snes/`).
- **Icon**: `makeIcon(w, h, rgba)`, from the game's own icon where it has one.

## Helpers in src/rom

| File | What it gives you |
|---|---|
| `gb.ts` | `isGb`, `gbTitle` (cartridge header), `gbWithMusic` |
| `sfc.ts` | `sfcHeaderTitle`, `sfcWithMusic` |
| `nds.ts` | `NdsRom` (file system, overlays; DSiWare too), `blzDecompress`, `ndsMusic` (the game's sound archive as pack music), `bgr555Hex` |
| `ctr.ts` | `readCtr` (CIA / CCI / CXI → files of the RomFS, titles, icon), `ctrCode` (code.bin), `lz11`, `ctrEncrypted` |
| `unity.ts` | Unity bundles (LZ4 / LZMA) and serialized files: `serializedFiles`, `readSerialized`, `namedBlobs`, `audioClip`, `readTyped` |
| `../audio/fsb5.ts` | FMOD FSB5 banks; `fsbVorbisToOgg` (needs the setup header in `vorbis-setups.ts`) |
| `jtex.ts` | 3DS textures, `packPictures` for coloured solved pictures |
| `dsgfx.ts` | DS tiles and palettes |

MomoGram decrypts nothing. A game that is only available encrypted is reported as `encrypted` and the player is told to use a decrypted copy of their own.

## Trying it out

```
node build.mjs                                   # regenerates all.ts
node tools/import.mjs "path/to/game file" …      # what each file (or game folder) becomes
node tools/import.mjs game.sfc --json out/       # also writes each pack.json (without assets)
```

Typical output:

```
Picross 2 (Japan) (SGB Enhanced).gb: Picross 2 (Game Boy)
  gb-picross-2  "Picross 2"  53 levels, 836 puzzles, 0 named, 1 assets
```

Compare the counts with the game's own. Before you change an existing importer, write its packs with `--json` to a folder, then compare them afterwards. Every difference should be one you meant. Finally, add the files in the app (Packs → Add files) and play a few puzzles from different modes.

`npx tsc --noEmit -p .` checks the types.

## Keep game data out of the repository

The repository holds code only. Never commit ROMs, files extracted from them, exported packs, dumps or screenshots of copyrighted pictures. Short facts *about* a format (offsets, sizes, the layout of a record, a table's length) are fine, and that is what the header table is for. Puzzle solutions and names are not, because they come from the player's file at runtime.
