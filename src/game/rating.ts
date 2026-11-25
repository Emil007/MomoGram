// Points and PixELO: two numbers to compare players, kept separately for normal and Mega puzzles.
//
// Points only go up. Each puzzle is worth its best result once: size and difficulty (measured by the solver),
// times the medal (platinum > gold > silver > bronze), with a bonus for speed against the puzzle's par time. A
// better medal or a faster time later pays only the difference.
//
// PixELO is a chess-style rating with each puzzle as the opponent. A puzzle's rating and par time come from the
// solver and its size (the same on every device). The first solve under each rule set (Bronze / Silver / Gold /
// Platinum) is rated: the time against par gives a score between 0 and 1. New players start at 500. Replays are
// unrated. The rating is replayed from the rated solves in order, so two devices of the same player always agree.
//
// v2: effective area from density (sparse demos stop farming), split pr / par / pointsWork, start at 500.
import { puzzleScore } from './difficulty';
import { guessDepth } from './unique';

export const RATING = {
  version: 2,
  start: 500, floor: 100,
  /** K: big for the first rated solves (find the level fast), then steadier */
  kNew: 40, kSettled: 20, settledAfter: 15,
  /** puzzle rating anchors (v2) */
  prBase: 500, prPass: 150, prArea: 85, mega: 120,
  notLogicBase: 100, notLogicPerDepth: 35, notLogicMid: 160, notLogicCap: 6,
  /** density → effective area (kills sparse farms); also scales notLogic */
  densRef: 0.45, densFloor: 0.12, densSpan: 0.88,
  /** par time: marking + thinking (empty cells cost little; passes×√effArea carries size) */
  parBase: 8, parFilled: 0.55, parEmpty: 0.06, parPass: 14, parMega: 1.25,
  /** time counted: Easy catches mistakes for you (×1.5), logic hints (×1.2), each roulette spin +30 s */
  easyFactor: 1.5, logicFactor: 1.2, rouletteSec: 30,
  /** score curve: 1 / (1 + (time/par)^k) */
  k: 1.5,
  /** points */
  basePoints: 5, notLogicPoints: 5, megaPoints: 1.25, speedBonus: 0.5,
  pointsArea: 0.65, pointsPass: 8,
  medal: { bronze: 1, silver: 2, gold: 3, platinum: 4 } as Record<string, number>,
};

export type RatedRules = 'easy' | 'normal' | 'hard' | 'free' | 'platinum';
export interface RatedSolve { at: string; pr: number; s: number; firstMs?: number }

type Metrics = {
  passes: number; area: number; filled: number; density: number; logic: boolean;
  effArea: number; pointsWork: number; guessDepth: number;
};

const cache = new Map<string, Metrics>();

function clamp01(x: number) { return Math.min(1, Math.max(0, x)); }

function metricsOf(rows: string[]): Metrics {
  const k = rows.join('/');
  let v = cache.get(k);
  if (!v) {
    const s = puzzleScore(rows);
    const density = s.area ? s.filled / s.area : 0;
    const effArea = s.area * (RATING.densFloor + RATING.densSpan * clamp01(density / RATING.densRef));
    const pointsWork = Math.max(25, RATING.pointsArea * effArea * Math.sqrt(s.passes) + RATING.pointsPass * s.passes);
    const depth = s.solvable ? 0 : guessDepth(rows);
    v = { passes: s.passes, area: s.area, filled: s.filled, density, logic: s.solvable, effArea, pointsWork, guessDepth: depth };
    cache.set(k, v);
  }
  return v;
}

function notLogicBonus(m: Metrics): number {
  if (m.logic) return 0;
  const raw = m.guessDepth <= 0
    ? RATING.notLogicMid
    : RATING.notLogicBase + RATING.notLogicPerDepth * Math.min(RATING.notLogicCap, m.guessDepth);
  // sparse canvases are not "deep" just because line logic fails — scale by density
  return Math.round(raw * (0.25 + 0.75 * clamp01(m.density / 0.35)));
}

/** a puzzle's PixELO rating and par time (seconds) */
export function puzzleRating(rows: string[], mega: boolean): { pr: number; par: number } {
  const m = metricsOf(rows);
  const pr = RATING.prBase
    + RATING.prPass * Math.log(Math.max(2, m.passes))
    + RATING.prArea * Math.log(Math.max(1, m.effArea / 25))
    + notLogicBonus(m)
    + (mega ? RATING.mega : 0);
  const par = (RATING.parBase
    + RATING.parFilled * m.filled
    + RATING.parEmpty * Math.max(0, m.area - m.filled)
    + RATING.parPass * Math.max(0, m.passes - 1) * Math.sqrt(m.effArea) / 10)
    * (mega ? RATING.parMega : 1);
  return { pr: Math.round(pr), par: Math.round(par) };
}

/** how well a solve went, 0 … 1 (par time: 0.5) */
export function performance(ms: number, par: number, rules: RatedRules, opts: { logic?: boolean; roulette?: number } = {}): number {
  let t = ms / 1000;
  if (rules === 'easy') t *= RATING.easyFactor;
  if (opts.logic) t *= RATING.logicFactor;
  t += (opts.roulette ?? 0) * RATING.rouletteSec;
  t = Math.max(1, t);
  return 1 / (1 + (t / Math.max(1, par)) ** RATING.k);
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
  const m = metricsOf(rows);
  const base = RATING.basePoints * (1 + Math.log(m.pointsWork / 25)) + (m.logic ? 0 : RATING.notLogicPoints);
  const speed = ms === undefined ? 0 : Math.max(0, Math.min(1, 1 - ms / 1000 / Math.max(1, par))) * RATING.speedBonus;
  return Math.round(base * (RATING.medal[medal] ?? 1) * (1 + speed) * (mega ? RATING.megaPoints : 1));
}

/** clear metric cache (tests / recalibration) */
export function clearRatingCache() { cache.clear(); }
