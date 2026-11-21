# The .momopack format

A `.momopack` file holds one puzzle pack with everything it needs: the puzzles, their names, the levels, the look of the original game, its music and pictures. MomoGram writes one when you export a pack, uploads them to a MomoGram server, and opens them when you add a file. On the desktop it also opens them by double-click.

Packs are always made by the player from games they own. MomoGram itself ships no game data. The one exception is its own small starter pack.

## Container

A `.momopack` is an ordinary zip file:

```
pack.json          the pack (UTF-8 JSON, described below)
assets/<name>      binary files the pack refers to: music, pictures, animations
```

An "Export all" file is a plain `.zip` holding one `.momopack` per pack.

Files are deflated, except those that are compressed already (`.ogg`, images, `.spcsnap`, `.momopack`): they are
stored as they are, which saves time and costs no space. `pack.json` and small files use the strongest level.

A `.momopack` always carries all of its files, even when the app on a device keeps a file only once for several
packs (the same title music in every game of a series). Each pack file stands on its own.

## Versions

`pack.json` carries a hidden revision in `rev`: the time this version of the pack was made, in milliseconds since 1970. It is set when a game is read (or read again) and every time a pack is saved in the editor. The player never sees it.

- A higher `rev` is a newer version. The app offers an update when a server has a pack with a higher `rev` than the installed one, and the server keeps only the newest.
- A pack without `rev` counts as revision 1.

The bare `.momopack.json` files of early versions are no longer read.

## pack.json

```jsonc
{
  "format": "momogram-pack",          // required
  "version": 1,                       // format version of pack.json (not the pack's revision)
  "id": "ctr-picross-e2",             // stable id; packs with the same id are the same game (regions merge)
  "rev": 1795219200000,               // revision, see above (optional)
  "title": { "en": "PICROSS e2", "ja": "ピクロスe2" },
  "source": {                         // shown in the pack list; nothing here is needed to play
    "game": "PICROSS e2", "platform": "Nintendo 3DS", "region": "E/P",
    "developer": "Jupiter", "year": 2013, "file": "…"
  },
  "icon": { "w": 48, "h": 48, "rgba": "<base64 of w*h*4 bytes>" },   // optional
  "theme": { … },                     // optional, see below
  "levels": [ … ]
}
```

Texts (`title`, names) are objects with one entry per language: `en`, `de`, `fr`, `it`, `es`, `ja`, `ko`. The app shows the player's language and falls back to another one.

### Levels

```jsonc
{
  "id": "s10x10-1",
  "title": { "en": "10×10 1" },
  "rules": "normal",                  // "normal": mistakes are caught (time penalty); "free": no checking
  "group": "10x10",                   // optional: levels with the same group form one mode
  "groupTitle": { "en": "10×10" },    // optional: the mode's name
  "extra": true,                      // optional: unlocked when the rest of the group is cleared in time
  "unlockAfter": 30,                  // optional: puzzles to solve in the pack before this level opens
  "puzzles": [ … ]
}
```

### Puzzles

```jsonc
{
  "id": "10x10-07",                   // stable within the pack: progress is saved under "<pack id>/<puzzle id>"
  "width": 10, "height": 10,
  "rows": ["..####....", "…"],         // one string per row: '#' filled, '.' empty
  "name": { "ja": "きゃたつ", "en": "Stepladder" },   // optional, only shown once the puzzle is solved
  "exclusive": "JPN",                 // optional: only in this region's release (set when regions merge)
  "color": { "palette": ["#ff0000", …], "rows": ["0011..", …] }   // optional coloured solved picture
}
```

Puzzle ids must never change between versions of a pack. Otherwise players lose their progress.

### Theme

```jsonc
{
  "palette": {                        // colours imitating the original game (all optional except accent)
    "accent": "#1f9be0", "fill": "#222", "cell": "#fff", "grid": "#88a", "clue": "#000",
    "cross": "#c33", "cursor": "#f80", "hint": "#36f", "bg": "#eef",
    "style": "gbc"                    // "dmg" / "gbc": Game Boy look; "default"
  },
  "music": {                          // asset per role; "file#song" picks a song inside the file
    "menu": "sound.spcsnap#spc:68", "play": "…", "play2": "…", "clear": "…", "title": "…"
  },
  "tracks": ["…"],                    // every in-game track (random music picks from these)
  "songs": ["…"],                     // every song of the game, also unused ones (sound test)
  "off": ["…"],                       // songs the player switched off (never played)
  "edited": 1795219200000,            // when the player last changed the tags above in the sound test
  "pictures": true                    // the pack has assets/pictures.bin
}
```

## Assets

| File | Content |
|---|---|
| `sound.gbsnd` | Game Boy music: the game's sound driver and data, played by MomoGram's Game Boy sound emulation |
| `sound.spcsnap` | Super Famicom music: SPC700 / S-DSP state, played by MomoGram's emulation |
| `sound.sdat` | Nintendo DS sound archive (Picross DS) |
| `*.bcstm` | 3DS stream music, one file per track |
| `anim.pck` | Picross DS solved-picture animations |
| `pictures.bin` | coloured solved pictures, see below |

### pictures.bin

All little-endian:

```
u32 count
count times:
  u16 keyLength, key (UTF-8)       the puzzle's pattern: its rows joined with "/"
  u16 width, u16 height
  width*height*4 bytes RGBA
```

The key is the pattern rather than the puzzle id, so the picture follows the puzzle into the daily puzzles and into merged packs.

## Merging regions

When a pack arrives whose `id` already exists, the new one is the base:

1. The title and the puzzle names of both are combined.
2. Puzzles are matched by pattern.
3. Puzzles only the other version has are added, marked `exclusive`, with an id ending in `~<region>`.
4. Only the base's assets are kept, because animation indices differ between regions.
