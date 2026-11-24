// High scores: the fastest times on a puzzle, the ranking and the players' cards.
import { formatTime } from '../game/board';
import { t } from '../i18n';
import { pickAny } from '../packs/format';
import { Medal, Mode, activeProfile, getProgress, localStats, practiceBests } from '../store';
import { PRACTICE_GAMES, PracticeGame, practiceScoreText } from './practice';
import * as Sync from '../sync';
import { panel } from './dialog';
import { PlayRules, RULES_OF, allPacks, countPack, curMode, h, header, home, medalEl, modeSwitchButton, packLang, rulesName, screen } from '../app';

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
    .map(([n, ms, r, m, pts]) => [n, ms, r || (m ? RULES_OF[m] ?? '' : ''), m, pts] as typeof sc.best[string][number]);
  const myProgress = getProgress(packId, puzzleId), mine = strictestTime(myProgress);
  if (mine) list.push([me.name, mine[0], mine[1], myProgress.medal ?? '', myProgress.pts ?? 0]);
  if (!list.length) return null;
  // points already include the medal (harder rules score more). The same points: the shorter time ranks higher.
  // an older server sends no points: then the stricter rules still come first, and time breaks the tie.
  const byPoints = list.every(e => typeof e[4] === 'number');
  list.sort((a, b) => byPoints ? (b[4] ?? 0) - (a[4] ?? 0) || a[1] - b[1] : (RULE_RANK[a[2] ?? ''] ?? 3) - (RULE_RANK[b[2] ?? ''] ?? 3) || a[1] - b[1]);
  return h('p', { class: 'fastest' }, '🏆 ' + t('puzzleBest') + ': ',
    ...list.slice(0, 3).map(([n, ms, r, m, pts], k) => h('span', { class: n === me.name ? 'me' : '', title: (r ? rulesName(r as PlayRules) + ' · ' : '') + formatTime(ms) },
      `${k + 1}. ${n} ${byPoints ? pts : formatTime(ms)}`,
      byPoints ? h('small', {}, ' ' + formatTime(ms)) : null,
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
 * points, PixELO or puzzles solved; medals; and per game.
 */
let scoreSort: 'elo' | 'points' = 'elo';
let scoreMode: Mode | null = null;
/**
 * High scores: a ranking (PixELO or points) for Normal or Mega, then one card per player with everything at a
 * glance (PixELO and peak, points, solved, medals, this week, records); a card opens that player's games.
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

    const seg = <T extends string>(cur: T, opts: Array<[T, string]>, set: (v: T) => void) => h('div', { class: 'seg mini' }, ...opts.map(([v, l]) =>
      h('button', { class: 'segbtn' + (cur === v ? ' on' : ''), onClick: () => { set(v); draw(); } }, l)));
    body.append(h('div', { class: 'score-switches' },
      modeSwitchButton(mode, next => { scoreMode = next; draw(); }),
      seg<'elo' | 'points'>(scoreSort, [['elo', 'PixELO'], ['points', t('pointsTab')]], v => { scoreSort = v; })));
    if (!users.some(u => u.solved)) { body.append(h('p', { class: 'fine' }, t('noScores'))); if (note) body.append(h('p', { class: 'fine' }, note)); return; }

    const main = (u: Row) => scoreSort === 'points' ? String(u.points ?? 0) : u.rated ? String(u.elo) + (u.rated < 15 ? '?' : '') : '–';
    const other = (u: Row) => scoreSort === 'points'
      ? (u.rated ? 'PixELO ' + u.elo + (u.rated < 15 ? '?' : '') : '')
      : String(u.points ?? 0) + ' ' + t('pointsShort');
    const medalCount = (m: Medal, n: number | undefined) => h('span', { class: 'mcount' + (n ? '' : ' none') }, medalEl(m, false), String(n ?? 0));
    body.append(h('ol', { class: 'ranking' }, ...users.map((u, k) => h('li', { class: (u.name === me ? 'me ' : '') + (k < 3 ? 'top' + (k + 1) : '') },
      h('button', { class: 'rank-line', onClick: () => playerGames(u, mode) },
        h('span', { class: 'rank' }, k < 3 ? ['🥇', '🥈', '🥉'][k] : String(k + 1)),
        h('b', { class: 'who-name' }, u.name),
        h('b', { class: 'num' }, main(u), h('small', {}, scoreSort === 'points' ? ' ' + t('pointsShort') : ''))),
      h('div', { class: 'rank-sub' },
        other(u) ? h('span', {}, other(u)) : null,
        h('span', {}, t('solvedTab') + ' ' + u.solved),
        u.week ? h('span', {}, t('thisWeek', { n: u.week })) : null,
        medalCount('platinum', u.medals.platinum), medalCount('gold', u.medals.gold), medalCount('silver', u.medals.silver), medalCount('bronze', u.medals.bronze),
        u.records ? h('span', {}, t('recordsN', { n: u.records })) : null)))));
    // practice: per game the best results of everyone (this mode), the best first
    const pracOf = (name: string) => (name === mine.name ? practiceBests() : sc?.users.find(x => x.name === name)?.practice ?? {});
    const slot = (g: PracticeGame) => (mode === 'normal' ? g : g + '@' + mode);
    const rows = PRACTICE_GAMES.map(g => {
      const list = users.map(u => [u.name, pracOf(u.name)[slot(g.id)]] as [string, number | undefined]).filter((x): x is [string, number] => x[1] !== undefined)
        .sort((a, b) => (g.higher ? b[1] - a[1] : a[1] - b[1]));
      return list.length ? h('div', { class: 'prac-row' }, h('b', {}, g.icon + ' ' + t('p_' + g.id)),
        h('span', { class: 'prac-list' }, ...list.slice(0, 3).map(([n, v], k) => h('span', { class: n === me ? 'me' : '' }, `${k + 1}. ${n} ${practiceScoreText(g.id, v)}`)))) : null;
    }).filter((x): x is HTMLDivElement => !!x);
    if (rows.length) body.append(h('h2', { class: 'section-title' }, t('practice')), h('div', { class: 'prac-scores card' }, ...rows));
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
          const you = u.name !== mine.name;
          return h('div', { class: 'pg-row' + (you ? ' with-you' : '') }, h('b', {}, pickAny(p.title, packLang())),
            h('div', { class: 'pg-bars' },
              h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${total ? (n / total) * 100 : 0}%` })),
              you ? h('div', { class: 'bar-outer slim you' }, h('div', { class: 'bar-inner', style: `width:${total ? (mineN / total) * 100 : 0}%` })) : null),
            h('small', { class: 'pg-n' }, `${n}/${total}`),
            you ? h('small', { class: 'pg-you' }, t('you') + ' ' + mineN) : null);
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
