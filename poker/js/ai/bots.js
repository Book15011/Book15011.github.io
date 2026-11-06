// @ts-check
/**
 * Baseline bots, hand-written heuristics rather than anything trained. They serve two purposes:
 * benchmark opponents, and the weaker difficulty levels in the game.
 *
 * Every bot implements `act(obs) -> Action` and sees only the player observation.
 */
import { evaluate, categoryOf } from '../engine/evaluator.js';
import { FLOP, RIVER, PREFLOP } from '../engine/game.js';

/** @typedef {import('../engine/game.js').Action} Action */
/** @typedef {ReturnType<import('../engine/game.js').HandState['observation']>} Observation */

/** Chen-style preflop score scaled to 0..1 via a table of equities vs a random hand would be heavier; this is cheap. */
export function preflopStrength(hole) {
  const [a, b] = hole;
  const ra = a >> 2, rb = b >> 2;
  const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  const suited = (a & 3) === (b & 3);
  const base = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10][hi];
  let s = base;
  if (hi === lo) s = Math.max(5, base * 2);
  if (suited) s += 2;
  const gap = hi - lo - 1;
  if (hi !== lo) {
    if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
    if (gap <= 1 && hi < 10) s += 1;
  }
  return Math.max(0, Math.min(1, (s + 1.5) / 21.5));
}

/**
 * Monte Carlo equity of `hole` on `board` against a uniformly random opposing hand, or against
 * a weighted one if `oppWeight(c1, c2)` is given.
 * @param {number[]} hole @param {number[]} board @param {number} trials @param {{next:()=>number,int:(n:number)=>number}} rng
 * @param {((a:number,b:number)=>number)|null} [oppWeight]
 */
export function monteCarloEquity(hole, board, trials, rng, oppWeight = null) {
  const used = new Uint8Array(52);
  for (const c of hole) used[c] = 1;
  for (const c of board) used[c] = 1;
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
  const need = 7 - board.length; // two for the opponent plus the remaining board cards
  const my = [hole[0], hole[1], ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const opp = [0, 0, ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const n = deck.length;
  let wins = 0, total = 0;
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < need; i++) {
      const j = i + rng.int(n - i);
      const x = deck[i]; deck[i] = deck[j]; deck[j] = x;
    }
    const weight = oppWeight ? oppWeight(deck[0], deck[1]) : 1;
    if (weight <= 0) continue;
    opp[0] = deck[0]; opp[1] = deck[1];
    for (let i = 2; i < need; i++) {
      const pos = 2 + board.length + (i - 2);
      my[pos] = deck[i]; opp[pos] = deck[i];
    }
    const a = evaluate(my), b = evaluate(opp);
    total += weight;
    if (a > b) wins += weight; else if (a === b) wins += weight / 2;
  }
  return total > 0 ? wins / total : 0.5;
}

/** Snap a target raise size to a legal integer. @param {Observation} obs @param {number} to @returns {Action} */
export function raiseTo(obs, to) {
  const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
  if (!l.canRaise) return l.canCheck ? { type: 'check' } : { type: 'call' };
  const x = Math.round(Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, to)));
  return { type: 'raise', to: x };
}

/** Pot-fraction raise target: fraction of the pot after calling. @param {Observation} obs @param {number} f */
export function potRaise(obs, f) {
  const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
  const cur = Math.max(obs.bets[0], obs.bets[1]);
  return raiseTo(obs, cur + f * (obs.pot + l.callAmount));
}

const passive = (/** @type {Observation} */ obs) => (/** @type {any} */ (obs.legal).canCheck ? { type: 'check' } : { type: 'call' });
const giveUp = (/** @type {Observation} */ obs) => (/** @type {any} */ (obs.legal).canCheck ? { type: 'check' } : { type: 'fold' });

/** Uniformly random legal action. A sanity floor, nothing more. */
export class RandomBot {
  name = 'Random';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng) { this.rng = rng; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const opts = /** @type {Action[]} */ ([]);
    if (l.canFold) opts.push({ type: 'fold' });
    if (l.canCheck) opts.push({ type: 'check' });
    if (l.canCall) opts.push({ type: 'call' });
    if (l.canRaise) opts.push({ type: 'raise', to: l.minRaiseTo + this.rng.int(l.maxRaiseTo - l.minRaiseTo + 1) });
    return opts[this.rng.int(opts.length)];
  }
}

/** Plays few hands, calls rather than raises, and folds to aggression without a strong hand. */
export class TightPassiveBot {
  name = 'Tight-Passive';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng) { this.rng = rng; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    if (obs.street === PREFLOP) {
      const s = preflopStrength(obs.hole);
      if (s > 0.78 && l.canRaise) return potRaise(obs, 0.8);
      if (s > 0.45) return passive(obs);
      if (s > 0.3 && l.callAmount <= obs.bigBlind) return passive(obs);
      return giveUp(obs);
    }
    const eq = monteCarloEquity(obs.hole, obs.board, 200, this.rng);
    if (eq > 0.9 && l.canRaise) return potRaise(obs, 0.6);
    if (l.canCheck) return { type: 'check' };
    const odds = l.callAmount / (obs.pot + l.callAmount);
    return eq > odds + 0.2 ? { type: 'call' } : { type: 'fold' };
  }
}

/** Plays many hands and bets often with little regard for how strong the hand is. */
export class LooseAggressiveBot {
  name = 'Loose-Aggressive';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng) { this.rng = rng; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const r = this.rng.next();
    if (obs.street === PREFLOP) {
      const s = preflopStrength(obs.hole);
      if (s < 0.12 && !l.canCheck && r < 0.5) return { type: 'fold' };
      if (l.canRaise && r < 0.45 + s * 0.4) return potRaise(obs, 0.75 + r * 0.5);
      return passive(obs);
    }
    const eq = monteCarloEquity(obs.hole, obs.board, 150, this.rng);
    if (l.canRaise && (eq > 0.62 || r < 0.42)) return potRaise(obs, eq > 0.8 ? 1.0 : 0.66);
    if (l.canCheck) return { type: 'check' };
    const odds = l.callAmount / (obs.pot + l.callAmount);
    return eq + 0.08 > odds ? { type: 'call' } : { type: 'fold' };
  }
}

/** Straight probability play: compares equity against a random hand to the pot odds. */
export class EquityBot {
  name = 'Equity / Pot-Odds';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng, trials = 400) { this.rng = rng; this.trials = trials; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const eq = monteCarloEquity(obs.hole, obs.board, this.trials, this.rng);
    if (l.canRaise && eq > 0.72) return potRaise(obs, 0.75);
    if (l.canCheck) return { type: 'check' };
    const odds = l.callAmount / (obs.pot + l.callAmount);
    return eq > odds ? { type: 'call' } : { type: 'fold' };
  }
}

function boardTexture(/** @type {number[]} */ board) {
  const ranks = board.map((c) => c >> 2).sort((a, b) => a - b);
  const suits = [0, 0, 0, 0];
  for (const c of board) suits[c & 3]++;
  const flushy = Math.max(...suits);
  let span = 0;
  for (let i = 0; i + 2 < ranks.length; i++) if (ranks[i + 2] - ranks[i] <= 4) span++;
  const paired = new Set(ranks).size < ranks.length;
  return { wet: (flushy >= 3 ? 0.5 : flushy === 2 ? 0.15 : 0) + (span > 0 ? 0.3 : 0), paired, flushy };
}

/**
 * A careful hand-written player. It discounts its equity against an opponent who has shown
 * strength, adjusts for position and board texture, semi-bluffs with mixing, and sizes by street.
 * This is the benchmark to beat, and it has no game-theoretic guarantee of any kind.
 */
export class StrongHeuristicBot {
  name = 'Strong Heuristic';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng, trials = 500) { this.rng = rng; this.trials = trials; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const r = this.rng.next();
    const onButton = obs.button === obs.seat;
    const effective = Math.min(obs.stacks[0] + obs.bets[0], obs.stacks[1] + obs.bets[1]);
    const bbs = effective / obs.bigBlind;

    if (obs.street === PREFLOP) return this.#preflop(obs, l, r, onButton, bbs);

    const oppRaises = obs.history.filter((h) => h.seat !== obs.seat && h.type === 'raise').length;
    const thisStreet = obs.history.filter((h) => h.seat !== obs.seat && h.type === 'raise' && h.street === obs.street).length;
    const raw = monteCarloEquity(obs.hole, obs.board, this.trials, this.rng);
    const tex = boardTexture(obs.board);
    // Opponents who bet usually hold better than a random hand, so discount accordingly.
    const eq = Math.max(0, raw - 0.06 * oppRaises - 0.06 * thisStreet);
    const cur = Math.max(obs.bets[0], obs.bets[1]);
    const unopened = cur === 0;

    if (unopened) {
      const made = categoryOf(evaluate([...obs.hole, ...obs.board]));
      const betFreq = eq > 0.8 ? 0.9 : eq > 0.65 ? 0.75 : eq > 0.5 ? 0.3 : (onButton ? 0.28 : 0.15);
      const drawy = eq > 0.38 && eq < 0.55 && obs.street < RIVER && made < 2;
      const f = drawy ? betFreq + 0.25 : betFreq;
      if (l.canRaise && r < f) return potRaise(obs, eq > 0.8 || tex.wet > 0.4 ? 0.75 : 0.5);
      return { type: 'check' };
    }
    const odds = l.callAmount / (obs.pot + l.callAmount);
    if (l.canRaise && eq > 0.82 && r < 0.65) return potRaise(obs, 0.8);
    if (l.canRaise && obs.street < RIVER && eq > 0.4 && eq < 0.55 && r < 0.08) return potRaise(obs, 0.75);
    return eq > odds + (obs.street === RIVER ? 0.04 : 0) ? { type: 'call' } : { type: 'fold' };
  }

  #preflop(/** @type {Observation} */ obs, /** @type {any} */ l, /** @type {number} */ r, /** @type {boolean} */ onButton, /** @type {number} */ bbs) {
    const s = preflopStrength(obs.hole);
    const raises = obs.history.filter((h) => h.type === 'raise').length;
    if (bbs <= 10) { // short stack: simple shove-or-fold ranges
      const jam = onButton ? 0.32 : 0.42;
      if (raises === 0 && l.canRaise && s > jam) return raiseTo(obs, l.maxRaiseTo);
      if (s > 0.55) return l.canCall ? { type: 'call' } : passive(obs);
      return giveUp(obs);
    }
    if (raises === 0) {
      if (onButton) {
        if (s > 0.24 && l.canRaise) return raiseTo(obs, 2.5 * obs.bigBlind);
        return s > 0.14 && r < 0.5 ? { type: 'call' } : { type: 'fold' };
      }
      if (s > 0.6 && l.canRaise) return raiseTo(obs, 3.5 * obs.bigBlind);
      return { type: 'check' };
    }
    const cur = Math.max(obs.bets[0], obs.bets[1]);
    if (raises === 1) {
      if (s > 0.7 && l.canRaise) return raiseTo(obs, 3 * cur);
      if (s > 0.6 && r < 0.18 && l.canRaise) return raiseTo(obs, 3 * cur);
      return s > (l.callAmount > 2.5 * obs.bigBlind ? 0.34 : 0.24) ? { type: 'call' } : { type: 'fold' };
    }
    if (s > 0.85 && l.canRaise) return raiseTo(obs, l.maxRaiseTo);
    return s > 0.62 ? { type: 'call' } : { type: 'fold' };
  }
}

/**
 * Casual difficulty: friendly and beatable. It over-calls, under-bluffs and makes visible mistakes,
 * and always plays legally. Weaker on purpose.
 */
export class CasualBot {
  name = 'Casual';
  constructor(/** @type {{next:()=>number,int:(n:number)=>number}} */ rng) { this.rng = rng; }
  act(/** @type {Observation} */ obs) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const r = this.rng.next();
    if (obs.street === PREFLOP) {
      const s = preflopStrength(obs.hole);
      if (s > 0.8 && l.canRaise && r < 0.8) return potRaise(obs, 0.6);
      if (s < 0.1 && !l.canCheck && r < 0.6) return { type: 'fold' };
      if (l.callAmount > 8 * obs.bigBlind && s < 0.5) return { type: 'fold' };
      return passive(obs);
    }
    const eq = monteCarloEquity(obs.hole, obs.board, 80, this.rng);
    if (l.canRaise && eq > 0.78 && r < 0.6) return potRaise(obs, r < 0.3 ? 0.4 : 0.7);
    if (l.canRaise && l.canCheck && r < 0.06) return potRaise(obs, 0.35); // an occasional cheap stab
    if (l.canCheck) return { type: 'check' };
    const odds = l.callAmount / (obs.pot + l.callAmount);
    return eq + 0.1 > odds ? { type: 'call' } : { type: 'fold' };
  }
}

/** Checks whenever it can, calls otherwise. Useful for a smoke test of value betting. */
export class CallStationBot {
  name = 'Call Station';
  act(/** @type {Observation} */ obs) { return passive(obs); }
}

export { FLOP };
