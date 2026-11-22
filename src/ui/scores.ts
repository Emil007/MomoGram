// High scores: the fastest times on a puzzle, the ranking and the players' cards.
import { formatTime } from '../game/board';
import { t } from '../i18n';
import { pickAny } from '../packs/format';
import { Medal, Mode, activeProfile, getProgress, localStats } from '../store';
import * as Sync from '../sync';
import { panel } from './dialog';
import { PlayRules, RULES_OF, allPacks, countPack, curMode, h, header, home, medalEl, packLang, rulesName, screen } from '../app';

/**
 * The three fastest players on a puzzle. Shown at once from the scores kept on the device, then redrawn when fresh
 * ones arrive from the server (fetched at most once a minute), so others' new times show without opening the scores.
 */
export function fastestRow(packId: string, puzzleId: string): HTMLElement | null {
  if (!Sync.account()) return null;
  const box = h('div', { class: 'fastest-box' });
  const draw = () => box.replaceChildren(...[fastestList(packId, puzzleId)].filter((x): x is HTMLElement => !!x));
  draw();
  if (Date.now() - scoresFetched > 60_000) {
    scoresFetched = Date.now();
    Sync.refreshScores().then(() => { if (box.isConnected) draw(); }).catch(() => { scoresFetched = 0; });
  }
  return box;
}
let scoresFetched = 0;
/** the best times of everyone on the server for one puzzle (this profile's own time from here, it may be newer) */
function fastestList(packId: string, puzzleId: string): HTMLElement | null {
  const sc = Sync.scores(), me = Sync.account();
  if (!sc || !me) return null;
  // older progress (and an older server) gives no rules with a time: the medal tells which rules it was played with
  const list = (sc.best[packId + '/' + puzzleId] ?? []).filter(([n]) => n !== me.name)
    .map(([n, ms, r, m]) => [n, ms, r || (m ? RULES_OF[m] ?? '' : ''), m] as typeof sc.best[string][number]);
  const myProgress = getProgress(packId, puzzleId), mine = strictestTime(myProgress);
  if (mine) list.push([me.name, mine[0], mine[1], myProgress.medal ?? '']);
  if (!list.length) return null;
  // times under stricter rules come first: a fast Easy time doesn't beat a Hard one
  list.sort((a, b) => (RULE_RANK[a[2] ?? ''] ?? 3) - (RULE_RANK[b[2] ?? ''] ?? 3) || a[1] - b[1]);
  return h('p', { class: 'fastest' }, '🏆 ' + t('fastest') + ': ',
    // the medal says how it was played (bronze Easy, silver Normal, gold and platinum Hard)
    ...list.slice(0, 3).map(([n, ms, r, m], k) => h('span', { class: n === me.name ? 'me' : '', title: r ? rulesName(r as PlayRules) : '' }, `${k + 1}. ${n} ${formatTime(ms)}`,
      m ? medalEl(m as Medal) : r ? h('i', { class: 'rule-tag r-' + r }, rulesName(r as PlayRules).slice(0, 1)) : null)));
}
const RULE_RANK: Record<string, number> = { free: 0, hard: 0, normal: 1, easy: 2 };
/** a puzzle's best time under the strictest rules it was solved with (older progress: its best time, rules unknown) */
function strictestTime(p: { best?: number; times?: Partial<Record<string, number>> }): [number, string] | null {
  let pick: [number, string] | null = null;
  for (const [r, ms] of Object.entries(p.times ?? {})) if (ms !== undefined && (!pick || (RULE_RANK[r] ?? 3) < (RULE_RANK[pick[1]] ?? 3) || ((RULE_RANK[r] ?? 3) === (RULE_RANK[pick[1]] ?? 3) && ms < pick[0]))) pick = [ms, r];
  // older progress has no times per rules: its medal tells which rules it was played with
  const medal = (p as { medal?: string }).medal;
  return pick ?? (p.best !== undefined ? [p.best, medal ? RULES_OF[medal] ?? '' : ''] : null);
}

/**
 * Everyone on the server (up to 10 players), for the mode that is on (normal and Mega are two games): ranked by
 * points, PixElo or puzzles solved; medals; and per game.
 */
let scoreSort: 'elo' | 'points' = 'elo';
let scoreMode: Mode | null = null;
/**
 * High scores: a ranking (PixElo or points) for Normal or Mega, then one card per player with everything at a
 * glance (PixElo and peak, points, solved, medals, this week, records); a card opens that player's games.
 */
export async function scoresScreen() {
  const body = h('div', { class: 'scores' });
  screen(header(t('scores'), home), body);
  let sc = Sync.scores(), note = '';
  const draw = () => {
    const mode: Mode = scoreMode ?? curMode();
    body.replaceChildren();
    const me = Sync.account()?.name;
    type Row = Sync.ScoreStats & { name: string };
    const of = (u: NonNullable<typeof sc>['users'][0]): Row => ({ name: u.name, ...(u.modes?.[mode] ?? (mode === 'normal' ? u : { solved: 0, medals: {}, packs: {}, time: 0 })) });
    let users: Row[] = sc ? sc.users.map(of) : [];
    // this profile's own numbers come from this device: they may be newer than the server's
    const mine: Row = { ...(users.find(u => u.name === me) ?? { medals: {}, packs: {}, time: 0 }), ...localStats(mode), name: me ?? activeProfile().name };
    users = [...users.filter(u => u.name !== mine.name), mine];
    const elo = (u: Row) => (u.rated ? u.elo ?? 1000 : -1);
    const key = (u: Row) => scoreSort === 'points' ? [u.points ?? 0, u.solved] : [elo(u), u.rated ?? 0, u.points ?? 0];
    users.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });

    // switches: Normal / Mega, PixElo / points
    const seg = <T extends string>(cur: T, opts: Array<[T, string]>, set: (v: T) => void) => h('div', { class: 'seg mini' }, ...opts.map(([v, l]) =>
      h('button', { class: 'segbtn' + (cur === v ? ' on' : ''), onClick: () => { set(v); draw(); } }, l)));
    body.append(h('div', { class: 'score-switches' },
      seg<Mode>(mode, [['normal', t('normalMode')], ['mega', 'Mega'], ['color', t('colorOn')]], v => { scoreMode = v; }),
      seg<'elo' | 'points'>(scoreSort, [['elo', 'PixElo'], ['points', t('pointsTab')]], v => { scoreSort = v; })));
    if (!users.some(u => u.solved)) { body.append(h('p', { class: 'fine' }, t('noScores'))); if (note) body.append(h('p', { class: 'fine' }, note)); return; }

    // the ranking: one line per player, the number that's ranked big
    const main = (u: Row) => scoreSort === 'points' ? String(u.points ?? 0) : u.rated ? String(u.elo) + (u.rated < 15 ? '?' : '') : '–';
    body.append(h('ol', { class: 'ranking' }, ...users.map((u, k) => h('li', { class: (u.name === me ? 'me ' : '') + (k < 3 ? 'top' + (k + 1) : '') },
      h('span', { class: 'rank' }, k < 3 ? ['🥇', '🥈', '🥉'][k] : String(k + 1)),
      h('b', { class: 'who-name' }, u.name),
      h('b', { class: 'num' }, main(u), h('small', {}, scoreSort === 'points' ? ' ' + t('pointsShort') : ''))))));
    body.append(h('p', { class: 'fine center' }, scoreSort === 'elo' ? t('eloExplain') : t('pointsExplain')));

    // a card per player
    const medalCount = (m: Medal, n: number | undefined) => h('span', { class: 'mcount' + (n ? '' : ' none') }, medalEl(m, false), String(n ?? 0));
    const fact = (label: string, value: string) => h('div', { class: 'fact' }, h('b', {}, value), h('small', {}, label));
    body.append(h('h2', { class: 'section-title' }, t('players')), h('div', { class: 'player-cards' }, ...users.map(u =>
      h('button', { class: 'player-card' + (u.name === me ? ' me' : ''), onClick: () => playerGames(u, mode) },
        h('div', { class: 'pc-head' }, h('b', {}, '👤 ' + u.name), u.week ? h('small', { class: 'pc-week' }, t('thisWeek', { n: u.week })) : null),
        h('div', { class: 'pc-facts' },
          fact('PixElo' + (u.rated && u.rated < 15 ? ' (' + t('provisional') + ')' : ''), u.rated ? String(u.elo) : '–'),
          fact(t('peak'), u.rated ? String(u.peak ?? u.elo) : '–'),
          fact(t('pointsTab'), String(u.points ?? 0)),
          fact(t('solvedTab'), String(u.solved))),
        h('div', { class: 'pc-medals' }, medalCount('platinum', u.medals.platinum), medalCount('gold', u.medals.gold), medalCount('silver', u.medals.silver), medalCount('bronze', u.medals.bronze),
          u.records ? h('small', { class: 'pc-rec' }, t('recordsN', { n: u.records })) : null)))));
    if (note) body.append(h('p', { class: 'fine' }, note));

    /** one player's games: solved per game, compared with you */
    function playerGames(u: Row, m: Mode) {
      const packs = allPacks().filter(p => u.packs?.[p.id]).sort((a, b) => (u.packs[b.id] ?? 0) - (u.packs[a.id] ?? 0));
      const mineRow = users.find(x => x.name === mine.name)!;
      panel((box, close) => {
        box.append(h('h3', {}, u.name + (m === 'mega' ? ' · Mega' : '')));
        if (!packs.length) box.append(h('p', { class: 'fine' }, t('noScores')));
        box.append(h('div', { class: 'pg-list' }, ...packs.map(p => {
          const total = countPack(p)[1], n = u.packs[p.id] ?? 0, mineN = mineRow.packs?.[p.id] ?? 0;
          return h('div', { class: 'pg-row' }, h('b', {}, pickAny(p.title, packLang())),
            h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${total ? (n / total) * 100 : 0}%` })),
            h('small', {}, `${n}/${total}` + (u.name !== mine.name ? ` · ${t('you')} ${mineN}` : '')));
        })));
        box.append(h('button', { class: 'btn primary', onClick: close }, t('ok')));
      });
    }
  };
  draw();
  if (!Sync.account()) return;
  try { await Sync.sync(); sc = await Sync.refreshScores(); scoresFetched = Date.now(); note = ''; } catch { note = t('scoresOffline'); }
  if (body.isConnected) draw();
}
