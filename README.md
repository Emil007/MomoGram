# MomoGram

A nonogram player built around **your own Picross DS ROM**: the original 345 puzzles with their level structure, names, animated solved pictures and music. It runs in the browser and as a desktop app (Windows, Linux, Steam Deck, macOS), and works in **portrait on phones**.

The name combines *nonogram* with Momo, from Michael Ende's novel, because Picross steals time too.

> **No game data is included.** MomoGram reads everything (puzzles, names, pictures, music) at runtime from a Picross DS ROM you provide. The ROM stays on your device. Puzzle packs are made by you, from games you own.

> This project (code, tools and documentation) was written by an AI (Claude, by Anthropic), directed and tested by a human. Expect AI-typical mistakes, and please report what you find.

## Playing

1. Open MomoGram and choose your Picross DS ROM (`.nds`, or a `.zip` with the `.nds` inside). The European, US, Japanese and Korean releases all work. The names come in the languages of your release (Europe: EN/DE/FR/IT/ES).
2. Play **Easy**, **Normal** (levels 1–10 + Extra) or **Free** (levels 1–10 + Extra), or the **Daily Picross** set of five 7×7 puzzles.
   - Normal rules: wrong fills are caught and cost 2, 4, then 8 minutes. Finish in under 60 minutes to see the picture.
   - Free rules: no checks. Use **Try it out** to test an idea, then keep or discard it.
   - Levels unlock as in the original (levels 5–10 after 40/50/…/90 cleared puzzles; Extra after clearing every level in under an hour). Options → *Unlock all levels* skips this.
3. Controls
   - Touch / mouse: tap or drag to fill (a drag stays on its row or column), **Mark** or right-click to cross out, two fingers / mouse wheel to zoom, two fingers / middle mouse to pan.
   - Keyboard: arrows, `Z`/Space = fill, `X` = mark (hold and move to paint), `C` = zoom, `U` = undo, `Esc` = menu.
   - Gamepad / Steam Deck: D-pad, A = fill, B = mark, Y = zoom, L = undo, R = try it out, Start = menu.

## Puzzle packs

**Puzzle packs → Create packs from your games** reads the puzzles from other Picross games you own and turns each one into a pack: one `.momopack.json` file per game, keeping the original level structure and the puzzle names where the game has them. Do it once, keep the files, and import them anywhere with **Import packs** (single files or a `.zip` of several). **Export all as .zip** bundles your packs.

| Game | Platform | Status |
|---|---|---|
| Picross DS (full game and the Download Station / Nintendo Channel demos) | DS | ✓ |
| Picross e, e2–e9, Pokémon Picross, Club Nintendo Picross (+ Plus), My Nintendo Picross, Sanrio Characters Picross | 3DS (decrypted files) | ✓ |
| Mario's Picross | Game Boy | ✓ (Easy, Kinoko, Star, Time Trial) |
| Picross 2 | Game Boy | ✓ as 15×15 sections (the 30×30 pictures are not reassembled yet) |
| Pokémon Picross (prototype) | Game Boy Color | not yet |
| Mario no Super Picross (also the Virtual Console release) | Super Famicom | ✓ all 300 puzzles (Mario 1–10, Special, EX; Wario 1–10, Special, Ultra, EX) |
| Tamori no Picross | Satellaview (.bs) | ✓ standard puzzles plus the daily and weekly puzzles of each broadcast; importing several broadcasts adds their days to one pack |
| Picross NP Vol. 1–8 | Super Famicom (Nintendo Power) | not yet |
| Picross S series and other Switch games | Switch | not yet |

Regional versions of the same game are merged into one pack (all languages' names). `.zip`, `.7z` and `.rar` archives can be chosen directly.

Only puzzles from Jupiter / Nintendo releases are supported.

### Pack format

```jsonc
{
  "format": "momogram-pack", "version": 1,
  "id": "marios-picross-gb",
  "title": { "en": "Mario's Picross" },
  "source": { "game": "Mario's Picross", "platform": "Game Boy", "region": "USA/EUR" },
  "levels": [{
    "id": "easy-a", "title": { "en": "Easy A" }, "rules": "normal", "group": "easy",
    "puzzles": [{ "id": "easy-a-01", "width": 5, "height": 5,
                  "rows": ["..#..", ".###.", "#####", ".###.", "..#.."],
                  "name": { "en": "…" } }]
  }]
}
```

`rows` uses `#` for filled and `.` for empty. Optional per-puzzle `color` (palette + rows) gives a coloured solved picture. Levels can have `unlockAfter` (cleared puzzles in the same `group`) and `extra`.

## Building

```sh
npm ci
npm run build                 # web app in dist/web (static files, any web host / GitHub Pages)
cp -r dist/web electron/web
cd electron && npm install && npx electron-builder   # desktop builds in dist/desktop
```

GitHub Actions (`.github/workflows/release.yml`) builds the web app, Windows (x64/ARM64), Linux (x64/ARM64 AppImage + tarball; the x64 AppImage runs on Steam Deck) and macOS (universal) on every `v*` tag, and publishes the web app to GitHub Pages.

On Steam Deck: add the AppImage to Steam as a non-Steam game; it starts fullscreen in Gaming Mode.

## How it works

- `src/rom/nds.ts`: DS ROM file system, ARM9/overlays, BLZ decompression.
- `src/rom/picrossds.ts`: finds the puzzle-set tables, records, display order, localized names (overlay tables in the European ROM, message lists in the US/Korean ROMs, record titles in the Japanese ROM) and solved-picture animation scripts.
- `src/rom/dsgfx.ts`: renders DS OBJ cells (4bpp, 2D mapping) for the solved pictures.
- `src/audio/`: SDAT reader and an SSEQ sequencer on Web Audio for the original music.
- `src/game/`: rules and board view; `src/ui/` and `src/app.ts`: screens.

## License

MIT for MomoGram's own code. Picross and Picross DS are trademarks of Nintendo and Jupiter; MomoGram is an unofficial fan project, not affiliated with or endorsed by them.
