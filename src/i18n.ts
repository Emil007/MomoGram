// MomoGram's own words. Every language is one file in src/i18n/ (en.json, de.json, …): a new language is just a
// new file with the same keys (and "_name", the language's own name); the build picks it up. Keys a file doesn't
// have fall back to English. "_textOrder" says in which languages the games' own texts (puzzle names, level and game
// titles) are looked for when they don't exist in this language, e.g. "de,en,ja". Puzzle names come from the games, in every language they have.
import { Lang, setTextOrder } from './packs/format';
import { LANGS } from './i18n/all';

type Dict = Record<string, string>;
const tables: Record<string, Dict> = LANGS;
const en = tables.en;
let current: Lang = 'en';

export function setLang(l: Lang) {
  current = l;
  // "_textOrder" in a language file: which languages the games' own texts (puzzle names …) are shown in, in order
  setTextOrder((tables[l]?._textOrder ?? 'en,ja').split(',').map(x => x.trim()).filter(Boolean));
}
export function lang(): Lang { return current; }
export function t(key: string, vars: Record<string, string | number> = {}): string {
  let s = tables[current]?.[key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', String(v));
  return s;
}

/** the languages with all of MomoGram's own texts */
export const hasTexts = (l: string) => !!tables[l];
/** languages to choose from: every text file, plus languages only the games' puzzle names come in */
export const LANG_NAMES: Record<string, string> = { en: en._name, ...Object.fromEntries(Object.entries(tables).map(([k, d]) => [k, d._name ?? k])), ...(tables.ko ? {} : { ko: '한국어' }) };
