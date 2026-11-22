// Library folders "by series": which games belong together, from their titles. Game knowledge, so it lives with
// the importers; the app only asks for a pack's series.
import { Pack, pickAny } from '../format';

/** series of a game, from its title (all Picross e games together, the Mario games, …) */
export function seriesOf(p: Pack): string {
  const n = pickAny(p.title, 'en');
  // Jupiter's other Switch games (special editions, LogiartGrimoire, Nazarick, Kemono Friends, …): a folder of their own
  if (p.source.platform === 'Nintendo Switch' && !/^picross (s\d*\+?|e\d*)$/i.test(n.trim())) return 'Picross S Specials';
  const rules: Array<[RegExp, string]> = [
    [/^picross e\d*$/i, 'Picross e'], [/^picross s/i, 'Picross S'], [/^picross np/i, 'Picross NP'], [/^picross ds/i, 'Picross DS'],
    [/mario|^picross 2$/i, 'Mario'], [/pok[eé]mon/i, 'Pokémon'], [/club nintendo|my ?nintendo/i, 'Nintendo rewards'], [/tamori/i, 'Tamori'],
    // the picture logic games of other makers (Hudson, Success, …)
    [/sanrio|hello kitty/i, 'Sanrio'], [/puzzle iro iro/i, 'Puzzle Iro Iro'],
    [/illust logic|illu-logi|ds puzzler|challenge me|oekaki|illust puzzle/i, 'Illust Logic'],
  ];
  for (const [re, name] of rules) if (re.test(n)) return name;
  return n;
}
