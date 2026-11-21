// Points and PixElo: two numbers to compare players, kept separately for normal and Mega puzzles.
//
// Points only go up. Each puzzle is worth its best result once: size and difficulty (measured by the solver),
// times the medal (platinum > gold > silver > bronze), with a bonus for speed against the puzzle's par time. A
// better medal or a faster time later pays only the difference.
//
// PixElo is a chess-style rating with each puzzle as the opponent. A puzzle's rating and par time come from the
// solver and its size (the same on every device). The first solve of a puzzle under each rule set (Easy, Normal,
// Hard) is rated: the time against par gives a score between 0 and 1, which moves the rating by how much better or
// worse it is than expected against that puzzle. Replays are unrated. Leaving a puzzle costs nothing (puzzles are
// always kept and can be continued). The rating is replayed from the rated solves in order, so two devices of the
// same player always agree.
import { puzzleScore } from './difficulty';

export const RATING = {
  start: 1000, floor: 100,
  /** K: big for the first rated solves (find the level fast), then steadier */
  kNew: 40, kSettled: 20, settledAfter: 15,
  /** a puzzle's rating: 500 + perWork·ln(work/25), +notLogic when it can't be solved line by line, +mega */
  base: 500, perWork: 220, notLogic: 250, mega: 120,
  /** par time: base + work·perWork seconds, ×mega */
  parBase: 10, parPerWork: 0.35, parMega: 1.25,
  /** time counted: Easy catches mistakes for you (×1.5), logic hints (×1.2), each roulette spin +30 s */
  easyFactor: 1.5, logicFactor: 1.2, rouletteSec: 30,
  /** score curve: 1 / (1 + (time/par)^k) */
  k: 1.5,
  /** points: basePoints·(1 + ln(work/25)) (+notLogicPoints), ×medal, ×(1 + speed bonus up to speedBonus) */
  basePoints: 5, notLogicPoints: 5, megaPoints: 1.25, speedBonus: 0.5,
  medal: { bronze: 1, silver: 2, gold: 3, platinum: 4 } as Record<string, number>,
};

export type RatedRules = 'easy' | 'normal' | 'hard' | 'free';
export interface RatedSolve { at: string; pr: number; s: number }

const cache = new Map<string, { work: number; logic: boolean }>();
function workOf(rows: string[]) {
  const k = rows.join('/');
  let v = cache.get(k);
  if (!v) { const s = puzzleScore(rows); v = { work: Math.max(25, s.area * Math.sqrt(s.passes)), logic: s.solvable }; cache.set(k, v); }
  return v;
}

/** a puzzle's PixElo rating and par time (seconds) */
export function puzzleRating(rows: string[], mega: boolean): { pr: number; par: number } {
  const { work, logic } = workOf(rows);
  const pr = RATING.base + RATING.perWork * Math.log(work / 25) + (logic ? 0 : RATING.notLogic) + (mega ? RATING.mega : 0);
  const par = (RATING.parBase + work * RATING.parPerWork) * (mega ? RATING.parMega : 1);
  return { pr: Math.round(pr), par: Math.round(par) };
}

/** how well a solve went, 0 … 1 (par time: 0.5) */
export function performance(ms: number, par: number, rules: RatedRules, opts: { logic?: boolean; roulette?: number } = {}): number {
  let t = ms / 1000;
  if (rules === 'easy') t *= RATING.easyFactor;
  if (opts.logic) t *= RATING.logicFactor;
  t += (opts.roulette ?? 0) * RATING.rouletteSec;
  t = Math.max(1, t);
  return 1 / (1 + (t / par) ** RATING.k);
}

/** the expected score against a puzzle */
export const expected = (player: number, puzzle: number) => 1 / (1 + 10 ** ((puzzle - player) / 400));

/** a rating from rated solves, in the order they happened */
export function replay(solves: RatedSolve[]): { elo: number; peak: number; n: number } {
  let elo = RATING.start, peak = elo, n = 0;
  for (const r of [...solves].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const K = n < RATING.settledAfter ? RATING.kNew : RATING.kSettled;
    elo = Math.max(RATING.floor, Math.round(elo + K * (r.s - expected(elo, r.pr))));
    peak = Math.max(peak, elo); n++;
  }
  return { elo, peak, n };
}

/** what a result is worth in points */
export function points(rows: string[], mega: boolean, medal: string | undefined, ms: number | undefined, par: number): number {
  if (!medal) return 0;
  const { work, logic } = workOf(rows);
  const base = RATING.basePoints * (1 + Math.log(work / 25)) + (logic ? 0 : RATING.notLogicPoints);
  const speed = ms === undefined ? 0 : Math.max(0, Math.min(1, 1 - ms / 1000 / par)) * RATING.speedBonus;
  return Math.round(base * (RATING.medal[medal] ?? 1) * (1 + speed) * (mega ? RATING.megaPoints : 1));
}
