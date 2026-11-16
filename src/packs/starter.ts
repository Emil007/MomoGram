// MomoGram's own starter puzzles (original designs, part of MomoGram and MIT licensed), playable without any ROM.
import type { Pack } from './format';

export const STARTER: Pack = {
  format: 'momogram-pack', version: 1, id: 'momogram-starter',
  title: { en: 'MomoGram starter puzzles', de: 'MomoGram-Einstiegsrätsel' },
  source: { game: 'MomoGram', platform: 'MomoGram', developer: 'MomoGram contributors' },
  levels: [{ id: 'starter', title: { en: 'Starter', de: 'Einstieg' }, rules: 'normal', puzzles: [
    {
      "id": "heart",
      "width": 10,
      "height": 10,
      "rows": [
        ".##....##.",
        "####..####",
        "##########",
        "##########",
        "##########",
        ".########.",
        "..######..",
        "...####...",
        "....##....",
        ".........."
      ],
      "name": {
        "en": "Heart",
        "de": "Herz"
      }
    },
    {
      "id": "house",
      "width": 10,
      "height": 10,
      "rows": [
        "....##....",
        "...####...",
        "..######..",
        ".########.",
        "##########",
        ".#......#.",
        ".#.##.#.#.",
        ".#.##...#.",
        ".#.##.#.#.",
        "##########"
      ],
      "name": {
        "en": "House",
        "de": "Haus"
      }
    },
    {
      "id": "mug",
      "width": 10,
      "height": 10,
      "rows": [
        "..........",
        ".#######..",
        ".#.....###",
        ".#######.#",
        ".#######.#",
        ".#######.#",
        ".########.",
        ".#######..",
        "..#####...",
        "##########"
      ],
      "name": {
        "en": "Mug",
        "de": "Tasse"
      }
    },
    {
      "id": "tree",
      "width": 10,
      "height": 10,
      "rows": [
        "....##....",
        "...####...",
        "..######..",
        "...####...",
        "..######..",
        ".########.",
        "..######..",
        ".########.",
        "....##....",
        "..######.."
      ],
      "name": {
        "en": "Fir tree",
        "de": "Tanne"
      }
    },
    {
      "id": "fish",
      "width": 10,
      "height": 10,
      "rows": [
        "..........",
        "...####...",
        ".#######.#",
        "#.#######.",
        "#########.",
        "#.#######.",
        ".#######.#",
        "...####...",
        "..........",
        ".........."
      ],
      "name": {
        "en": "Fish",
        "de": "Fisch"
      }
    },
    {
      "id": "umbrella",
      "width": 10,
      "height": 10,
      "rows": [
        "....##....",
        "..######..",
        ".########.",
        "##########",
        "#.#.##.#.#",
        "....##....",
        "....##....",
        "....##....",
        ".##.##....",
        "..###....."
      ],
      "name": {
        "en": "Umbrella",
        "de": "Schirm"
      }
    },
    {
      "id": "sailboat",
      "width": 10,
      "height": 10,
      "rows": [
        ".....#....",
        "....##....",
        "...###....",
        "..####.#..",
        ".#####.##.",
        "######.###",
        ".....#....",
        "##########",
        ".########.",
        "..######.."
      ],
      "name": {
        "en": "Sailboat",
        "de": "Segelboot"
      }
    },
    {
      "id": "hourglass",
      "width": 10,
      "height": 10,
      "rows": [
        "##########",
        ".########.",
        "..######..",
        "...####...",
        "....##....",
        "....##....",
        "...#..#...",
        "..#.##.#..",
        ".########.",
        "##########"
      ],
      "name": {
        "en": "Hourglass",
        "de": "Sanduhr"
      }
    }
  ] }],
};
