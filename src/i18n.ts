// UI strings. Puzzle names come from the user's ROM / packs; these are MomoGram's own words.
import type { Lang } from './packs/format';

type Dict = Record<string, string>;

const en: Dict = {
  tagline: 'A nonogram player for your Picross DS',
  addRom: 'Add your Picross DS ROM', starter: 'Starter puzzles',
  romHelp: 'MomoGram contains no game data. Try the starter puzzles, or add Picross games you own: Picross DS (all its modes and music), the 3DS games, Game Boy, Super Famicom … Your files stay on this device.',
  addGames: 'Add your Picross games', mainGame: 'main game (modes on the home screen)',
  romLoaded: 'Picross DS ({region}) loaded',
  puzzleNo: 'Puzzle', play: 'Play', continue: 'Continue', packs: 'Puzzle packs', options: 'Options', back: 'Back',
  easy: 'Easy', normal: 'Normal', free: 'Free', daily: 'Daily Picross', extra: 'Extra',
  level: 'Level', locked: 'Locked', unlockHint: 'Clear {n} puzzles to unlock',
  extraHint: 'Clear all levels in under 60 minutes each to unlock',
  fill: 'Fill', cross: 'Mark', zoom: 'Zoom', undo: 'Undo', menu: 'Menu', tryIt: 'Try it out', keep: 'Keep', discard: 'Discard',
  quit: 'Quit', stopSave: 'Stop & save', resume: 'Resume', restart: 'Restart',
  useHints: 'Use the hint roulette?', yes: 'Yes', no: 'No',
  cleared: 'Cleared!', time: 'Time', best: 'Best', mistakes: 'Mistakes', penalty: 'Penalty',
  overLimit: 'Over 60 minutes: no picture this time.',
  next: 'Next puzzle', toList: 'Puzzle list',
  music: 'Music', volume: 'Volume', sfx: 'Sound effects', hints: 'Hint roulette', ask: 'Ask', always: 'Always', never: 'Never',
  language: 'Language', packMusic: 'Original music of packs', packColors: 'Original colours of packs', musicNote: 'Packs created from your games can bring their own music (3DS, DS). It stays on this device and in your own exports. Do not share packs that contain music.', unlockAll: 'Unlock all levels', normalMusic: 'Normal mode music', freeMusic: 'Free mode music',
  resetProgress: 'Reset progress', removeRom: 'Remove ROM', confirmReset: 'Really reset all progress for this pack?',
  importPacks: 'Import packs', exportAll: 'Export all as .zip', createPacks: 'Create packs from your games',
  createHelp: 'Choose game files you own (Game Boy, Super Famicom, DS, decrypted 3DS; raw or zipped). MomoGram reads the puzzles and makes one pack file per game. Keep the files: you only need to do this once.',
  noPacks: 'No packs yet.', puzzles: 'puzzles', delete: 'Delete', download: 'Download',
  unsupported: 'Not supported', encrypted: 'Encrypted 3DS file: please use a decrypted copy.',
  done: 'Done', analyzing: 'Reading…', solvedCount: '{a} / {b} cleared',
  controls: 'Controls: tap or drag to fill, right-click / Mark to cross out, two fingers or mouse wheel to zoom and pan. Keyboard / gamepad: arrows, A/Z = fill, B/X = mark, Y/C = zoom, Start = menu.',
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum',
  toolsRight: 'Landscape: tools on the right',
  musicMode: 'Music while playing', musicRandomPack: 'Random from this game', musicRandomAll: 'Random from all games', musicFixed: 'Fixed choice',
  saveData: 'Save file', saveName: 'Save name', saveExport: 'Export save', saveImport: 'Import save', puzzlesSolved: 'puzzles solved',
  saveWaiting: 'progress for {n} pack(s) you have not imported here is kept for them', notASave: 'This is not a MomoGram save file.',
  saveReplace: 'Replace this device\'s progress', saveMerge: 'Merge (keep the best of both)',
  hard: 'Hard', logic: 'Hints', logicHints: 'Logic hints (blue numbers)', difficulty: 'Difficulty',
  rulesEasy: 'Easy: mistakes are caught without costing time. Bronze medal.',
  rulesHard: 'Hard: no hint roulette and no mistake checks. Gold medal, platinum without logic hints.',
  rulesNormal: 'Normal: mistakes are caught and cost time (2, 4, then 8 minutes). Silver medal.',
  rulesFree: 'Free rules: no mistake checks. Use "Try it out" to test an idea and keep or drop it.',
};

const de: Dict = {
  tagline: 'Ein Nonogramm-Spieler für dein Picross DS',
  addRom: 'Picross-DS-ROM hinzufügen', starter: 'Einstiegsrätsel',
  romHelp: 'MomoGram enthält keine Spieldaten. Probier die Einstiegsrätsel, oder füge Picross-Spiele hinzu, die du besitzt: Picross DS (alle Modi und die Musik), die 3DS-Spiele, Game Boy, Super Famicom … Deine Dateien bleiben auf diesem Gerät.',
  addGames: 'Deine Picross-Spiele hinzufügen', mainGame: 'Hauptspiel (Modi auf dem Startbildschirm)',
  romLoaded: 'Picross DS ({region}) geladen',
  puzzleNo: 'Rätsel', play: 'Spielen', continue: 'Fortsetzen', packs: 'Rätselpakete', options: 'Optionen', back: 'Zurück',
  easy: 'Leicht', normal: 'Normal', free: 'Frei', daily: 'Picross des Tages', extra: 'Extra',
  level: 'Level', locked: 'Gesperrt', unlockHint: 'Löse {n} Rätsel zum Freischalten',
  extraHint: 'Löse alle Level jeweils in unter 60 Minuten',
  fill: 'Füllen', cross: 'Kreuz', zoom: 'Zoom', undo: 'Zurück', menu: 'Menü', tryIt: 'Ausprobieren', keep: 'Behalten', discard: 'Verwerfen',
  quit: 'Beenden', stopSave: 'Pause & speichern', resume: 'Weiter', restart: 'Neu starten',
  useHints: 'Hinweis-Roulette benutzen?', yes: 'Ja', no: 'Nein',
  cleared: 'Gelöst!', time: 'Zeit', best: 'Bestzeit', mistakes: 'Fehler', penalty: 'Strafzeit',
  overLimit: 'Über 60 Minuten: diesmal kein Bild.',
  next: 'Nächstes Rätsel', toList: 'Rätselliste',
  music: 'Musik', volume: 'Lautstärke', sfx: 'Soundeffekte', hints: 'Hinweis-Roulette', ask: 'Fragen', always: 'Immer', never: 'Nie',
  language: 'Sprache', packMusic: 'Originalmusik der Packs', packColors: 'Originalfarben der Packs', musicNote: 'Aus deinen Spielen erstellte Packs können ihre eigene Musik mitbringen (3DS, DS). Sie bleibt auf diesem Gerät und in deinen eigenen Exporten. Packs mit Musik bitte nicht weitergeben.', unlockAll: 'Alle Level freischalten', normalMusic: 'Musik Normal-Modus', freeMusic: 'Musik Frei-Modus',
  resetProgress: 'Fortschritt zurücksetzen', removeRom: 'ROM entfernen', confirmReset: 'Wirklich den gesamten Fortschritt dieses Pakets löschen?',
  importPacks: 'Pakete importieren', exportAll: 'Alle als .zip exportieren', createPacks: 'Pakete aus deinen Spielen erstellen',
  createHelp: 'Wähle Spieldateien, die du besitzt (Game Boy, Super Famicom, DS, entschlüsselte 3DS; roh oder gezippt). MomoGram liest die Rätsel aus und erstellt pro Spiel eine Paketdatei. Behalte die Dateien: Das musst du nur einmal machen.',
  noPacks: 'Noch keine Pakete.', puzzles: 'Rätsel', delete: 'Löschen', download: 'Herunterladen',
  unsupported: 'Nicht unterstützt', encrypted: 'Verschlüsselte 3DS-Datei: bitte eine entschlüsselte Kopie verwenden.',
  done: 'Fertig', analyzing: 'Lese…', solvedCount: '{a} / {b} gelöst',
  controls: 'Steuerung: tippen oder ziehen zum Füllen, Rechtsklick / Kreuz zum Markieren, zwei Finger oder Mausrad zum Zoomen und Verschieben. Tastatur / Gamepad: Pfeile, A/Z = füllen, B/X = Kreuz, Y/C = Zoom, Start = Menü.',
  bronze: 'Bronze', silver: 'Silber', gold: 'Gold', platinum: 'Platin',
  toolsRight: 'Querformat: Werkzeuge rechts',
  musicMode: 'Musik beim Spielen', musicRandomPack: 'Zufällig aus diesem Spiel', musicRandomAll: 'Zufällig aus allen Spielen', musicFixed: 'Feste Auswahl',
  saveData: 'Spielstand', saveName: 'Name des Spielstands', saveExport: 'Spielstand exportieren', saveImport: 'Spielstand importieren', puzzlesSolved: 'Rätsel gelöst',
  saveWaiting: 'der Fortschritt für {n} Paket(e), die hier nicht importiert sind, bleibt für sie erhalten', notASave: 'Das ist kein MomoGram-Spielstand.',
  saveReplace: 'Fortschritt dieses Geräts ersetzen', saveMerge: 'Zusammenführen (das Beste aus beiden)',
  hard: 'Schwer', logic: 'Tipps', logicHints: 'Logik-Tipps (blaue Zahlen)', difficulty: 'Schwierigkeit',
  rulesEasy: 'Leicht: Fehler werden erkannt, kosten aber keine Zeit. Bronzemedaille.',
  rulesHard: 'Schwer: kein Tipp-Roulette und keine Fehlerprüfung. Goldmedaille, Platin ohne Logik-Tipps.',
  rulesNormal: 'Normal: Fehler werden erkannt und kosten Zeit (2, 4, dann 8 Minuten). Silbermedaille.',
  rulesFree: 'Frei-Regeln: keine Fehlerprüfung. Mit „Ausprobieren“ testest du eine Idee und behältst oder verwirfst sie.',
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
