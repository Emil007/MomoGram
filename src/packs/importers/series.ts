// Library folders "by series": which games belong together, from their titles. Game knowledge, so it lives with
// the importers; the app only asks for a pack's series.
import { Pack, pickAny } from '../format';

/** series of a game, from its title (all Picross e games together, the Mario games, …) */
export function seriesOf(p: Pack): string {
  const n = pickAny(p.title, 'en');
  // Jupiter's other Switch games (special editions, LogiartGrimoire, Nazarick, Kemono Friends, …): a folder of their own
  if (p.source.platform === 'Nintendo Switch' && !/^picross (s\d*\+?|e\d*)$/i.test(n.trim())) return 'Picross S Specials';
  if (p.source.platform === 'Arduboy') return 'Arduboy';
  const rules: Array<[RegExp, string]> = [
    [/^picross e\d*$/i, 'Picross e'], [/^picross s/i, 'Picross S'], [/^picross np/i, 'Picross NP'], [/^picross ds/i, 'Picross DS'],
    [/mario|^picross 2$/i, 'Mario'], [/pok[eé]mon/i, 'Pokémon'], [/club nintendo|my ?nintendo/i, 'Nintendo rewards'], [/tamori/i, 'Tamori'],
    [/sanrio|hello kitty/i, 'Sanrio'], [/puzzle iro iro/i, 'Puzzle Iro Iro'],
    // Illu-Logi VOW belongs with Hudson's Illust Logic; SIMPLE DS Illust Puzzle stays its own folder
    [/illu-logi/i, 'Illust Logic'], [/illust logic/i, 'Illust Logic'], [/illust puzzle/i, 'Illust Puzzle'],
    [/oekaki/i, 'Oekaki'], [/ds puzzler|challenge me/i, 'DS Puzzler'],
  ];
  for (const [re, name] of rules) if (re.test(n)) return name;
  return n;
}
