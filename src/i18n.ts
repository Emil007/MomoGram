// UI strings. Puzzle names come from the user's ROM / packs; these are MomoGram's own words.
import type { Lang } from './packs/format';

type Dict = Record<string, string>;

const en: Dict = {
  // home
  tagline: 'All your nonograms in one place. Careful, it eats time.',
  library: 'Your games', starter: 'MomoGram starters',
  noGameData: 'MomoGram ships without any game data. Everything it reads from your games stays on this device.',
  addGames: 'Add games', addGamesHelp: 'DS, 3DS, Game Boy, Super Famicom …',
  daily: 'Daily nonogram', dailyHelp: '15 fresh puzzles every day, 5 per difficulty',
  random: 'Surprise me', randomHelp: 'A random puzzle from your library', randomFrom: 'Pick a difficulty',
  continue: 'Continue', packs: 'Puzzle packs', options: 'Options', back: 'Back', play: 'Play',
  solvedCount: '{a} / {b} solved',
  // levels & puzzles
  puzzleNo: 'Puzzle', puzzles: 'puzzles', level: 'Difficulty', extra: 'Extra', locked: 'Locked',
  unlockHint: 'Solve {n} puzzles to open this one', extraHint: 'Finish every level in under 60 minutes each to unlock',
  easy: 'Easy', normal: 'Normal', hard: 'Hard', free: 'Free', difficulty: 'Rules',
  diff1: 'Relaxed', diff2: 'Tricky', diff3: 'Tough', size: 'Size', medal: 'Medal', start: 'Start',
  prev: 'Previous puzzle', nextPuzzle: 'Next puzzle', resetProgress: 'Reset progress',
  confirmReset: 'Start this game from scratch? Your times and medals for it will be gone.',
  rulesEasy: 'Easy rules: mistakes are caught and cost no time. Earns bronze.',
  rulesNormal: 'Normal rules: mistakes are caught but cost time (2, 4, then 8 minutes). Earns silver.',
  rulesHard: 'Hard rules: no hint roulette, no safety net. Earns gold, or platinum without logic hints.',
  // playing
  fill: 'Fill', cross: 'Cross out', zoom: 'Zoom', undo: 'Undo', menu: 'Menu', logic: 'Hints', logicHints: 'Logic hints (blue numbers)',
  tryIt: 'Try it', keep: 'Keep', discard: 'Discard',
  quit: 'Quit', stopSave: 'Pause & save', resume: 'Keep playing', restart: 'Start over',
  useHints: 'Spin the hint roulette?', yes: 'Spin it', no: 'No thanks',
  cleared: 'Solved!', time: 'Time', best: 'Best', mistakes: 'Mistakes', penalty: 'Penalty',
  overLimit: 'Over 60 minutes: the picture stays hidden this time.',
  next: 'Next puzzle', toList: 'Back to the list',
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum',
  // options
  secSound: 'Sound', secPlay: 'Playing', secLook: 'Look & language', secSave: 'Profile & save', secAbout: 'About',
  music: 'Music', volume: 'Music volume', sfx: 'Sound effects',
  musicMode: 'While playing', musicRandomPack: 'This game', musicRandomAll: 'All games', musicFixed: 'Main theme',
  hints: 'Hint roulette', ask: 'Ask', always: 'Always', never: 'Never',
  logicDefault: 'Logic hints on by default', unlockAll: 'Unlock every level',
  packColors: 'Colours of the original games', toolsRight: 'Landscape: tools on the right', language: 'Language',
  packMusic: 'Music of the original games',
  musicNote: 'Packs keep the music of the game they came from. It stays on this device and in your own exports, so please don\'t share packs that contain music.',
  controls: 'Tap or drag to fill, the tool button switches to crossing out (right-click works too). Pinch, Ctrl + wheel or the zoom button zooms; drag the clues to move around. Keyboard and gamepad: arrows, A/Z fill, B/X cross out, Y/C zoom, Start menu.',
  // profiles & saves
  saveData: 'Profile & save', profile: 'Profile', newProfile: 'New profile', renameProfile: 'Rename', deleteProfile: 'Delete {name}', profileName: 'Name',
  saveExport: 'Export save', saveImport: 'Import save', puzzlesSolved: 'puzzles solved',
  saveWaiting: 'progress for {n} game(s) not added on this device is kept safe for later', notASave: 'That isn\'t a MomoGram save file.',
  saveHelp: 'Saves belong to the active profile. Importing your own save from another device only takes over the games you played there more recently.',
  saveNewProfile: 'Welcome, {name}! The profile was added and is now active.', saveMerged: '{name}: {a} game(s) updated from the save, {b} kept because they\'re newer here.',
  // packs
  importPacks: 'Import packs', exportAll: 'Export all as .zip', createPacks: 'Add games',
  createHelp: 'Pick game files you own (Game Boy, Super Famicom, DS, decrypted 3DS; loose, zipped, 7z or rar). MomoGram reads the puzzles once and turns every game into a pack: keep the pack files and you never need the games again.',
  noPacks: 'No games yet. Add one and the fun begins.', delete: 'Delete', download: 'Download',
  unsupported: 'not a supported game', encrypted: 'encrypted 3DS file, please use a decrypted copy',
  done: 'Done', analyzing: 'Reading…',
};

const de: Dict = {
  tagline: 'All deine Nonogramme an einem Ort. Vorsicht, frisst Zeit.',
  library: 'Deine Spiele', starter: 'MomoGram-Starter',
  noGameData: 'MomoGram kommt ohne Spieldaten. Alles, was es aus deinen Spielen liest, bleibt auf diesem Gerät.',
  addGames: 'Spiele hinzufügen', addGamesHelp: 'DS, 3DS, Game Boy, Super Famicom …',
  daily: 'Nonogramm des Tages', dailyHelp: 'Jeden Tag 15 neue Rätsel, 5 pro Schwierigkeit',
  random: 'Überrasch mich', randomHelp: 'Ein zufälliges Rätsel aus deiner Sammlung', randomFrom: 'Wähle eine Schwierigkeit',
  continue: 'Weiterspielen', packs: 'Rätselpakete', options: 'Optionen', back: 'Zurück', play: 'Spielen',
  solvedCount: '{a} / {b} gelöst',
  puzzleNo: 'Rätsel', puzzles: 'Rätsel', level: 'Schwierigkeit', extra: 'Extra', locked: 'Gesperrt',
  unlockHint: 'Löse {n} Rätsel, um dieses zu öffnen', extraHint: 'Schaffe jedes Level in jeweils unter 60 Minuten',
  easy: 'Leicht', normal: 'Normal', hard: 'Schwer', free: 'Frei', difficulty: 'Regeln',
  diff1: 'Entspannt', diff2: 'Knifflig', diff3: 'Harte Nuss', size: 'Größe', medal: 'Medaille', start: 'Los geht\'s',
  prev: 'Voriges Rätsel', nextPuzzle: 'Nächstes Rätsel', resetProgress: 'Fortschritt zurücksetzen',
  confirmReset: 'Dieses Spiel neu beginnen? Deine Zeiten und Medaillen dafür sind dann weg.',
  rulesEasy: 'Leichte Regeln: Fehler werden erkannt und kosten keine Zeit. Gibt Bronze.',
  rulesNormal: 'Normale Regeln: Fehler werden erkannt, kosten aber Zeit (2, 4, dann 8 Minuten). Gibt Silber.',
  rulesHard: 'Schwere Regeln: kein Tipp-Roulette, kein Sicherheitsnetz. Gibt Gold, ohne Logik-Tipps sogar Platin.',
  fill: 'Füllen', cross: 'Ankreuzen', zoom: 'Zoom', undo: 'Zurück', menu: 'Menü', logic: 'Tipps', logicHints: 'Logik-Tipps (blaue Zahlen)',
  tryIt: 'Probieren', keep: 'Behalten', discard: 'Verwerfen',
  quit: 'Beenden', stopSave: 'Pause & speichern', resume: 'Weiterspielen', restart: 'Neu anfangen',
  useHints: 'Tipp-Roulette drehen?', yes: 'Dreh es', no: 'Nein danke',
  cleared: 'Gelöst!', time: 'Zeit', best: 'Bestzeit', mistakes: 'Fehler', penalty: 'Strafzeit',
  overLimit: 'Über 60 Minuten: Das Bild bleibt diesmal verborgen.',
  next: 'Nächstes Rätsel', toList: 'Zurück zur Liste',
  bronze: 'Bronze', silver: 'Silber', gold: 'Gold', platinum: 'Platin',
  secSound: 'Ton', secPlay: 'Spielen', secLook: 'Aussehen & Sprache', secSave: 'Profil & Spielstand', secAbout: 'Über MomoGram',
  music: 'Musik', volume: 'Musiklautstärke', sfx: 'Soundeffekte',
  musicMode: 'Beim Spielen', musicRandomPack: 'Dieses Spiel', musicRandomAll: 'Alle Spiele', musicFixed: 'Hauptthema',
  hints: 'Tipp-Roulette', ask: 'Fragen', always: 'Immer', never: 'Nie',
  logicDefault: 'Logik-Tipps standardmäßig an', unlockAll: 'Alle Level freischalten',
  packColors: 'Farben der Originalspiele', toolsRight: 'Querformat: Werkzeuge rechts', language: 'Sprache',
  packMusic: 'Musik der Originalspiele',
  musicNote: 'Pakete behalten die Musik des Spiels, aus dem sie stammen. Sie bleibt auf diesem Gerät und in deinen eigenen Exporten, also gib Pakete mit Musik bitte nicht weiter.',
  controls: 'Tippen oder ziehen zum Füllen, der Werkzeugknopf wechselt zum Ankreuzen (Rechtsklick geht auch). Zoomen mit zwei Fingern, Strg + Mausrad oder dem Zoom-Knopf; zum Verschieben an den Zahlen ziehen. Tastatur und Gamepad: Pfeile, A/Z füllen, B/X ankreuzen, Y/C zoomen, Start Menü.',
  saveData: 'Profil & Spielstand', profile: 'Profil', newProfile: 'Neues Profil', renameProfile: 'Umbenennen', deleteProfile: '{name} löschen', profileName: 'Name',
  saveExport: 'Spielstand exportieren', saveImport: 'Spielstand importieren', puzzlesSolved: 'Rätsel gelöst',
  saveWaiting: 'der Fortschritt für {n} Spiel(e), die hier noch fehlen, wird für später aufgehoben', notASave: 'Das ist kein MomoGram-Spielstand.',
  saveHelp: 'Spielstände gehören zum aktiven Profil. Dein eigener Spielstand von einem anderen Gerät übernimmt nur die Spiele, die du dort zuletzt gespielt hast.',
  saveNewProfile: 'Willkommen, {name}! Das Profil wurde hinzugefügt und ist jetzt aktiv.', saveMerged: '{name}: {a} Spiel(e) aus dem Spielstand übernommen, {b} behalten, weil sie hier neuer sind.',
  importPacks: 'Pakete importieren', exportAll: 'Alle als .zip exportieren', createPacks: 'Spiele hinzufügen',
  createHelp: 'Wähle Spieldateien, die dir gehören (Game Boy, Super Famicom, DS, entschlüsselte 3DS; einzeln, gezippt, 7z oder rar). MomoGram liest die Rätsel einmal aus und macht aus jedem Spiel ein Paket: Heb die Pakete auf, dann brauchst du die Spiele nie wieder.',
  noPacks: 'Noch keine Spiele. Füge eins hinzu, dann geht\'s los.', delete: 'Löschen', download: 'Herunterladen',
  unsupported: 'kein unterstütztes Spiel', encrypted: 'verschlüsselte 3DS-Datei, bitte eine entschlüsselte Kopie verwenden',
  done: 'Fertig', analyzing: 'Lese…',
};

const tables: Partial<Record<Lang, Dict>> = { en, de };
let current: Lang = 'en';

export function setLang(l: Lang) { current = l; }
export function lang(): Lang { return current; }
export function t(key: string, vars: Record<string, string | number> = {}): string {
  let s = tables[current]?.[key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', String(v));
  return s;
}

export const LANG_NAMES: Record<Lang, string> = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español', ja: '日本語', ko: '한국어' };
