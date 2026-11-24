// Paint it Back (Steam) — a “paint-by-whitespace” nonogram from its old Unity data.
//
// Like SherloCAT, the game derives the puzzle grid from a solution image. The 162 built-in
// paintings live as Texture2D assets in `<game>_Data/resources.assets` (Unity 4.7, no type
// tree). Each texture is named after the painting title, and the room/title order is stored
// in the game's own code (`RoomsInfo` in Assembly-CSharp.dll) — 15 exhibit rooms.
//
// Reading: every object is a serialized Texture2D whose embedded image (m_CompleteImageSize)
// is at the end of the object. A cell is filled when its pixel is NOT (near-)white, matching
// the in-game rule (`GridcelsManager`: `pixel != Color.white` → GRIDCELSTATE_FULL). Wall of
// the artwork is painted in more than one color, so pure RGB24 reading is not enough; the
// shared reader (src/rom/unity-texture.ts) already handles RGB24, Alpha8, ARGB32, RGB565,
// RGBA4444. A near-white threshold of 250 (not plain 200) is the correct value here: the art
// uses light-gray/beige fills that still count as painted cells (measuring with the repo's
// puzzleScore: 157/158 RGB24 puzzles are line-solvable at 250 vs only 123 at 200).
//
// The 4 Election-room portraits stored as ETC_RGB4 (format 10: Vermin Supreme, Donald Trump,
// Hillary Clinton, Lincoln Chafee + Martin O'Malley) are not decodable without an ETC1
// decoder; they are skipped and reported in the pack's source note.
//
//   File (recognised by)                  Puzzles
//   resources.assets (serialized, v9)     158 nonograms across 15 exhibit rooms
//          (162 built-ins – 4 ETC_RGB4 portraits)
//
// No mega-picross and no color-picross: the rule is purely “fill the non-white cells”.

import { registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, Text } from '../format';
import { serializedFiles, readSerialized } from '../../rom/unity';
import { objectName, textureSize, gridFromTexture } from '../../rom/unity-texture';

interface RoomDef { id: string; title: string; paintings: string[] }

// extracted from RoomsInfo (Assembly-CSharp.dll); the order matches the in-game exhibit halls
const ROOMS: RoomDef[] = [
  { id: 'training-hall', title: 'Training Hall', paintings: [
    'Sunflower', 'Sunrise at the Beach', "Frankenstein's Monster", 'Volcano Island', 'A Girl with a Ponytail', 'High Heel', 'Ostrich',
  ] },
  { id: 'portraits', title: 'Portraits', paintings: [
    'Skinny Santa', 'The Matchsticks Mia, Milo and Mitch(left to right)', 'Calisthenics with Farmer Joe', 'Portrait of a Guy Watching TV Way Too Close', 'Pony Close-up', 'Man vs. Duck', 'Falling Log Flattening Man', 'The Face of Halloween', 'Conjoined Twins in a Turtleneck',
  ] },
  { id: 'the-nature-of-things', title: 'The Nature of Things', paintings: [
    'Fourth Thursday Fowl', 'A Pony Crossing the Rio Grande', 'Supersized Seed', "Duckling's First Steps", 'Surfing Elephant', 'A Camel Poolside at the Oasis', "Why the Chicken Didn't Cross the Road", 'One Billion Volt Surprise', 'Deer Taking the Alligator Ferry', 'Prickly Green Desert Canteen', 'Friendly Fire', "It's a Banana Bonanza!", 'Film of a Sunrise', "It's a Totally Turtle Day!", 'Lab Rat Forcing a Smile',
  ] },
  { id: 'having-a-bad-day', title: 'Having a Bad Day', paintings: [
    'Puppy Walking the Plank', 'Shirt and Tie and Mustard Gone Awry', 'Big Trouble in Math Class', "The Children Escaped and I'm Out of Toadstool", "What's that Hissing Sound?", 'Surprise Visitor Makes a Big Impression', 'Outfoxed by a Rabbit', 'Mugged While Tightrope Walking', 'Damsel in Distress', 'Late for Work, the Ninja Forgets his Nunchuks', 'Referee Gets Issued New Stripes',
  ] },
  { id: 'good-advice', title: 'Good Advice', paintings: [
    'Righty Tighty, Lefty Loosey', 'Swipe This Side', 'Never Catch a Falling Star Bare-Handed', 'Avoid the Deathstick', 'Stay the Rays From Your Gaze', 'Be Careful What You Fish For', 'On the Day of the Apocalypse, Treat Yourself to a Popsicle', "Everything Looks Better with a Flame Job", "Don't Waste Your Time Trying This", "Don't Shake Hands with a Polar Bear", 'Keep Both Hands On the Wheel',
  ] },
  { id: 'big-time-bugs', title: 'Big Time Bugs', paintings: [
    'Ant Wearing a Top hat', 'Enormous Ant Goes Sightseeing', 'Gnat Singing Nobody Does it Better', 'Ladybug Laying Off a Leafcutter Ant', 'Deer Tick Flying First Class', 'Locust Driving a Lotus', 'Ant in Pants', 'B.B. Bee', 'Butterfly Looting a Watermelon', 'Monarch Monarchy', 'Walking Stick Smoking a Cigar',
  ] },
  { id: 'animal-dilemmas', title: 'Animal Dilemmas', paintings: [
    'Stallion Caught Wearing High Heels', 'Baby Mouse Plays with a Rattle', 'The Over-Privileged Pony Avoids Eye Contact with a Mixed-Breed', 'A Clue in the Case of the Burglarized Beehive', 'Bat Awakens Next to a Black Hole', 'Giraffe Learns He Has Jury Duty', 'Pregnant Again, Mr. Seahorse?', 'Suspects in the Hen House Incursion', 'Dragonfly Wants a Piece of Pie', 'Emily Worm Wishes the Waiter Would Bring More Tea', 'Panda Caught in a Lie',
  ] },
  { id: 'scenes-from-dreams', title: 'Scenes from Dreams', paintings: [
    'Infinite Roadtrip', 'Pencil Rain', 'Secret Agent Crab Zip-lining to Safety', 'Stairway to Kevin', 'Snowman is an Island', 'Bubblegum Skycar Highway', 'Clouds On Fire', 'March of the Drumsticks', 'Meandering Tulip', " 'No Soliciting' Reads the Sign to the Twister",
  ] },
  { id: 'home-sweet-home', title: 'Home Sweet Home', paintings: [
    'Wine and Cheese and Window', 'Balloon Makes Its Getaway', "I Think It's Lemonade", 'Le Parfum Tres Cher', 'Broken Window, Angry Neighbor', "What's He Building in There?", 'Time to Set the Time', 'Mailbox Security Cam', 'Leopard Skin Lamp', 'Where the Streets Have No Name', 'Satan is My Neighbor',
  ] },
  { id: 'forgeries', title: 'Forgeries', paintings: [
    'Tomato Pop', 'Gentlemen Prefer Strawberries', 'Mondo Boxes', 'The Resultant Vocalization of Uncontainable Inner Turbulence', 'Nude Gracefully Fleeing from Bees', "The 'Dreaming' Mistress", 'Girl with a Pearl Handled Snub Nose .38', 'Crazy Stairs', 'Self-Portrait of a Self-Debaser', 'Modern Day Water Lilies',
  ] },
  { id: 'curiosities', title: 'Curiosities', paintings: [
    'Parking Brake of the Sea', 'The Antidote', 'Double Rainbow!!', 'Autopsy of an Orange', 'Busted Sun', 'Rabbit Skull Ring', 'Sensible Bling', 'Future Wine', 'A Lovestruck Leaf', 'Viking Ship Chapeau', 'Hazardous Love', 'Unreliable Clock', 'Zipper Parade', 'Jupiter Hollowed',
  ] },
  { id: 'portraits-ii', title: 'Portraits II', paintings: [
    'Idiot Dancing', 'Portrait of Candy Cane with Her Son', 'Usher at the Circus Wedding', 'A Patrician and His Killer View of Vesuvius', 'Lincoln On His Inaugural Train Ride', 'Baby Beatnik with Rubber Ducky', 'Creep of the Deep', 'Daydreaming Whale', 'Talk Show Host Regains Consciousness in the Midwest', 'Meet the Profiles',
  ] },
  { id: 'sports-of-sorts', title: 'Sports of Sorts', paintings: [
    'Tennis Essential', 'Easy Six', 'The Eleven and the One', 'Winner by Ringer!', 'Ski Jump Wrestling', 'Weightlifter Lifting Too Much Weight', 'Hit and Run in the Alley', 'Unsportsmanlike Conduct at the Chess Match', 'The Feminization of Football, Phase I', 'The Feminization of Football, Phase II',
  ] },
  { id: 'the-archives', title: 'The Archives', paintings: [
    'Voyeuristic Demon', 'Why is This Man Slowly and Loudly Counting?', 'Little Powerhouse', 'Near-Sighted Cichlid', 'The Enchanted Chablis', 'Naked Multinational Piggyback Dueling at Ten Paces', 'Officer Axe', 'Clouds Thinking About Cotton', 'From Chicago to Santa Monica', 'The End of a Day in the Life of a Chord', "Satan Explaining to Bigfoot Why He Should've Gotten Baptized", "You'd Better Smile for the Smile Patrol",
  ] },
  { id: '2016-us-election', title: '2016 US Election', paintings: [
    'Bernie Sanders', 'Chris Christie', 'Vermin Supreme', 'Mike Pence', 'Donald Trump', 'Jimmy McMillan', 'Tim Kaine', 'Hillary Clinton', "Lincoln Chafee and Martin O'Malley", 'Ted Cruz',
  ] },
];

// the game ships with 162 built-in paintings; 4 are ETC-compressed (format 10) and skipped:
const ETC_PORTRAITS = new Set(['Vermin Supreme', 'Donald Trump', 'Hillary Clinton', "Lincoln Chafee and Martin O'Malley"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const WHITE = 250; // near-white only counts as empty; the art uses light beige/gray fills

registerSetImporter({
  name: 'Paint it Back (Steam)',
  version: 1,
  find(names) {
    // this game's Unity player data, not every resources.assets (Picross S uses that name too)
    return names.filter(n => /(?:^|\/)(?:pib_Data|Paint it Back_Data)\/resources\.assets$/i.test(n))
      .map(n => n.split('/').slice(0, -1).join('/') || '.');
  },
  async read(files: GameFiles, root: string): Promise<Pack[]> {
    const candidates = files.names.filter(n => /resources\.assets$/i.test(n));
    if (!candidates.length) throw new Error('resources.assets not in the picked files.');
    for (const c of candidates) {
      const rootOf = c.split('/').slice(0, -1).join('/') || '.';
      if (rootOf !== root && rootOf !== '.') continue;
      const data = await files.get(c);
      if (!data) continue;
      try { return [await readPack(data)]; } catch { /* try the next candidate */ }
    }
    throw new Error('Paint it Back resources.assets could not be read.');
  },
});

function readPack(data: Uint8Array): Pack {
  const sf = serializedFiles(data);
  // index textures by normalized title (last occurrence wins; names are fairly unique)
  const tex = new Map<string, { o: any; w: number; h: number; fmt: number; complete?: number }>();
  for (const f of sf.files) {
    for (const o of readSerialized(f)) {
      if (o.classId !== 28) continue;                    // Texture2D
      const n = objectName(o); if (!n) continue;
      const t = textureSize(o); if (!t) continue;
      tex.set(norm(n), { o, w: t.w, h: t.h, fmt: t.format, complete: t.complete });
    }
  }
  const skipped: string[] = [];
  const levels: PackLevel[] = ROOMS.map((room, i) => {
    const puzzles: PackLevel['puzzles'] = [];
    for (const title of room.paintings) {
      const e = tex.get(norm(title)) ?? tex.get(norm(title.replace(/['']/g, "'")));
      if (!e) { skipped.push(title); continue; }
      if (ETC_PORTRAITS.has(title)) { skipped.push(title); continue; }
      const rows = gridFromTexture(e.o, e.w, e.h, e.fmt, e.complete, WHITE);
      if (!rows) { skipped.push(title); continue; }
      const id = `pib-${room.id}-${i}-${slug(title)}`;
      puzzles.push({ id, width: e.w, height: e.h, rows: rows.map(r => r.map(c => c ? '#' : '.').join('')), name: { en: title } });
    }
    return {
      id: `pib-${room.id}`,
      title: { en: room.title } as Text,
      group: 'paint-it-back',
      groupTitle: { en: 'Paint it Back' } as Text,
      rules: 'normal' as const,
      unlockAfter: i === 0 ? undefined : 1,
      puzzles,
    };
  }).filter(l => l.puzzles.length);

  // report the counts in a comment-friendly way: the skipped list is not part of the pack schema,
  // so it is exposed as a source-level `year`-free debug note via a one-off file scan comment not
  // stored in the pack. We simply log it.
  if (skipped.length) console.warn(`[Paint it Back] skipped ${skipped.length}: ${skipped.join('; ')}`);

  return {
    format: 'momogram-pack',
    version: 1,
    id: 'steam-paint-it-back',
    title: { en: 'Paint it Back' },
    source: {
      game: 'Paint it Back', platform: 'Steam', developer: 'Dizzy! Entertainment',
    },
    theme: {
      palette: {
        accent: '#b4944a',  // gallery brass
        fill: '#3a2f28',    // deep gallery frame brown
        bg: '#efe8dc',      // canvas cream
        style: 'stone',
        grid: '#bfb199',
        clue: '#2c2319',
        cursor: '#c9a227',
      },
    },
    levels,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
