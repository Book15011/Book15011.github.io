// @ts-check
/**
 * The Expert agent. Preflop and flop decisions come from the trained blueprint (see blueprint.js).
 * From the turn onward it can solve the rest of the hand in real time (see solver.js), starting
 * from the hand ranges the blueprint implies. It sees only the player observation: its own cards,
 * the public board and the betting.
 */
import { BlueprintWalker, A_FOLD, A_CHECK, A_CALL, A_RAISE, NODE_DECISION } from './blueprint.js';
import { HAND_A, HAND_B, NUM_HANDS, pairIdx } from './hands.js';
import { monteCarloEquity } from './bots.js';

/** @typedef {ReturnType<import('../engine/game.js').HandState['observation']>} Observation */

const PREFLOP = 0, TURN = 2;
const STREET_BOARD = [0, 3, 4, 5];

/** Replays real chip amounts so raises can be expressed as pot fractions. */
class RealState {
  /** @param {Observation} obs */
  constructor(obs) {
    this.inv = [0, 0];
    this.bets = [0, 0];
    this.street = 0;
    this.startStacks = obs.startStacks;
  }

  /** @param {any} h a history entry. Returns the pot fraction of a raise. */
  apply(h) {
    if (h.street !== this.street) { this.street = h.street; this.bets = [0, 0]; }
    let frac = 0;
    if (h.type === 'raise') {
      const cur = Math.max(this.bets[0], this.bets[1]);
      const owe = cur - this.bets[h.seat];
      const pot = this.inv[0] + this.inv[1];
      frac = (h.to - cur) / Math.max(1, pot + owe);
    }
    if (h.type === 'uncalled_return') {
      this.inv[h.seat] -= h.amount; this.bets[h.seat] -= h.amount;
    } else {
      this.inv[h.seat] += h.amount; this.bets[h.seat] += h.amount;
    }
    // A raise that puts the effective stack in is an all-in, whatever size it works out to.
    if (h.type === 'raise' && this.inv[h.seat] >= Math.min(this.startStacks[0], this.startStacks[1])) return Infinity;
    return frac;
  }
}

/** Choose the trained stack depth closest to the effective stack, by ratio. @param {number[]} depths @param {number} bb */
export function nearestDepth(depths, bb) {
  let best = depths[0], err = Infinity;
  for (const d of depths) {
    const e = Math.abs(Math.log(d / Math.max(1, bb)));
    if (e < err) { err = e; best = d; }
  }
  return best;
}

export class ExpertBot {
  /**
   * @param {{ name?:string,
   *   blueprintFor:(effectiveBB:number)=>import('./blueprint.js').Blueprint,
   *   bucketsFor:(street:number, board:number[], out:Int16Array)=>boolean,
   *   rng:{next:()=>number,int:(n:number)=>number},
   *   solver?:{decide:(ctx:any)=>any}|null,
   *   purifyBelow?:number, analysis?:boolean }} opts
   */
  constructor(opts) {
    this.name = opts.name ?? 'Expert';
    this.opts = opts;
    this.rng = opts.rng;
    this.purifyBelow = opts.purifyBelow ?? 0.03;
    this.solver = opts.solver ?? null;
    /** @type {BlueprintWalker|null} */
    this.walker = null;
    this.real = /** @type {RealState|null} */ (null);
    this.processed = 0;
    this.lastDecision = /** @type {any} */ (null);
  }

  /** @param {Observation} obs */
  onHandStart(obs) {
    const eff = Math.min(obs.startStacks[0], obs.startStacks[1]) / obs.bigBlind;
    const bp = this.opts.blueprintFor(eff);
    this.walker = new BlueprintWalker(bp, this.opts.bucketsFor, this.rng);
    this.real = new RealState(obs);
    this.processed = 0;
    this.solver?.startHand?.(obs);
    this.lastDecision = null;
  }

  /** @param {Observation} obs */
  #sync(obs) {
    const w = /** @type {BlueprintWalker} */ (this.walker), real = /** @type {RealState} */ (this.real);
    for (; this.processed < obs.history.length; this.processed++) {
      const h = obs.history[this.processed];
      const frac = real.apply(h);
      if (h.type === 'small_blind' || h.type === 'big_blind' || h.type === 'uncalled_return') continue;
      if (h.seat === obs.seat) continue; // own actions were applied when they were chosen
      if (h.street >= TURN && this.solver) continue; // the solver tracks ranges from the turn onward
      w.setBoard(obs.board.slice(0, STREET_BOARD[h.street]));
      if (!w.offTree && !w.leaf) w.applyReal(/** @type {any} */ (h.type), frac);
    }
    w.setBoard(obs.board);
  }

  /** Bring the range tracking up to date without choosing an action. Used by the LBR evaluator. @param {Observation} obs */
  syncTo(obs) {
    if (!this.walker) this.onHandStart(obs);
    this.#sync(obs);
    return /** @type {BlueprintWalker} */ (this.walker);
  }

  /** @param {Observation} obs */
  act(obs) {
    if (!this.walker) this.onHandStart(obs);
    this.#sync(obs);
    const w = /** @type {BlueprintWalker} */ (this.walker);
    const me = obs.seat === obs.button ? 0 : 1;

    if (obs.street >= TURN && this.solver) {
      const decision = this.solver.decide({ obs, walker: w, me, rng: this.rng });
      if (decision) {
        this.lastDecision = decision.info;
        return decision.action;
      }
    }
    if (w.offTree || w.leaf || w.bp.type[w.node] !== NODE_DECISION || w.bp.player[w.node] !== me) return this.#fallback(obs, w, me);

    const hand = pairIdx(obs.hole[0], obs.hole[1]);
    w.syncBuckets();
    if (w.offTree) return this.#fallback(obs, w, me);
    const sigma = w.strategyFor(hand);
    const a = this.#sample(sigma);
    const acts = w.actions();
    const chosen = acts[a];
    const action = this.#toReal(obs, w, chosen);
    this.lastDecision = {
      source: 'blueprint', street: obs.street, translated: w.translated,
      options: acts.map((x, i) => ({ type: x.type, frac: x.type === A_RAISE ? w.fractionOf(x.a) : 0, allIn: x.type === A_RAISE && w.isAllIn(x.a), prob: sigma[i] })),
      chosen: a,
    };
    if (this.opts.analysis) {
      const oppRange = w.reach[1 - me].slice();
      const weight = (/** @type {number} */ x, /** @type {number} */ y) => oppRange[pairIdx(x, y)];
      this.lastDecision.equity = monteCarloEquity(obs.hole, obs.board, 1200, this.rng, weight);
      this.lastDecision.oppRange = oppRange;
    }
    w.takeAction(a);
    return action;
  }

  /** Sample after dropping very rare actions, which are mostly sampling noise in a large abstraction. @param {number[]} sigma */
  #sample(sigma) {
    let total = 0;
    const p = sigma.map((x) => (x < this.purifyBelow ? 0 : x));
    for (const x of p) total += x;
    if (total <= 0) { p.splice(0, p.length, ...sigma); total = sigma.reduce((s, x) => s + x, 0) || 1; }
    let u = this.rng.next() * total;
    for (let a = 0; a < p.length; a++) { u -= p[a]; if (u <= 0 && p[a] > 0) return a; }
    for (let a = p.length - 1; a >= 0; a--) if (p[a] > 0) return a;
    return 0;
  }

  /** Convert an abstract action into a legal real one. @param {Observation} obs @param {BlueprintWalker} w @param {any} chosen */
  #toReal(obs, w, chosen) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const passive = () => (l.canCheck ? { type: 'check' } : { type: 'call' });
    if (chosen.type === A_FOLD) return l.canCheck ? { type: 'check' } : { type: 'fold' };
    if (chosen.type === A_CHECK || chosen.type === A_CALL) return passive();
    if (!l.canRaise) return passive();
    const opp = 1 - obs.seat;
    const cover = Math.min(l.maxRaiseTo, obs.stacks[opp] + obs.bets[opp]);
    if (w.isAllIn(chosen.a)) return { type: 'raise', to: Math.max(l.minRaiseTo, cover) };
    let to;
    if (obs.street === PREFLOP) {
      to = Math.round((chosen.to / 100) * obs.bigBlind);
    } else {
      const cur = Math.max(obs.bets[0], obs.bets[1]);
      to = Math.round(cur + w.fractionOf(chosen.a) * (obs.pot + l.callAmount));
    }
    to = Math.max(l.minRaiseTo, Math.min(cover, to));
    if (to >= 0.9 * cover) to = Math.max(l.minRaiseTo, cover);
    return { type: 'raise', to };
  }

  /**
   * Used when the hand has left the abstract tree. Plays pot odds against the range tracked so far.
   * This is a safe default and is labelled as a heuristic in the analysis panel.
   * @param {Observation} obs @param {BlueprintWalker} w @param {number} me
   */
  #fallback(obs, w, me) {
    const l = /** @type {NonNullable<Observation['legal']>} */ (obs.legal);
    const oppRange = w.reach[1 - me];
    const weight = (/** @type {number} */ a, /** @type {number} */ b) => oppRange[pairIdx(a, b)];
    const eq = obs.street === PREFLOP ? monteCarloEquity(obs.hole, obs.board, 400, this.rng) : monteCarloEquity(obs.hole, obs.board, 600, this.rng, weight);
    const odds = l.canCall ? l.callAmount / (obs.pot + l.callAmount) : 0;
    this.lastDecision = { source: 'fallback', street: obs.street, equity: eq, odds };
    if (l.canRaise && eq > 0.75) {
      const cur = Math.max(obs.bets[0], obs.bets[1]);
      return { type: 'raise', to: Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, Math.round(cur + 0.66 * (obs.pot + l.callAmount)))) };
    }
    if (l.canCheck) return { type: 'check' };
    return eq > odds ? { type: 'call' } : { type: 'fold' };
  }
}

export { HAND_A, HAND_B, NUM_HANDS };
