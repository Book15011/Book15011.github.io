// @ts-check
/**
 * Turn and river decision-making by real-time subgame solving, following the structure used by
 * Pluribus and Modicum: start from the beginning of the current street, keep the agent's own past
 * decisions on this street pinned, include the opponent's actual bet sizes as exact options, solve,
 * then play the strategy for the agent's real hand.
 *
 * Inputs are public: the board, the betting and estimated ranges. The opposing hole cards are never known here.
 */
import { NUM_HANDS, HAND_A, HAND_B, pairIdx } from './hands.js';
import { Subgame, ACT_FOLD, ACT_CHECK, ACT_CALL, ACT_RAISE } from './solver.js';
import { scoreFromMasks } from '../engine/evaluator.js';

const TYPE = { check: ACT_CHECK, call: ACT_CALL, raise: ACT_RAISE };

/** Equity of `hand` against a weighted range on a turn or river board (4 or 5 cards), enumerating any remaining card. */
export function equityVsRange(hand, board, range) {
  const a = HAND_A[hand], b = HAND_B[hand];
  const m = [0, 0, 0, 0];
  for (const c of board) m[c & 3] |= 1 << (c >> 2);
  const used = new Uint8Array(52);
  for (const c of board) used[c] = 1;
  used[a] = 1; used[b] = 1;
  const rivers = [];
  if (board.length === 5) rivers.push(-1);
  else for (let c = 0; c < 52; c++) if (!used[c]) rivers.push(c);
  let win = 0, total = 0;
  for (const r of rivers) {
    const bm = m.slice();
    if (r >= 0) bm[r & 3] |= 1 << (r >> 2);
    const s = bm.slice();
    s[a & 3] |= 1 << (a >> 2);
    s[b & 3] |= 1 << (b >> 2);
    const mine = scoreFromMasks(s[0], s[1], s[2], s[3]);
    for (let h = 0; h < NUM_HANDS; h++) {
      const w = range[h];
      if (w <= 0) continue;
      const x = HAND_A[h], y = HAND_B[h];
      if (used[x] || used[y] || x === r || y === r) continue;
      const o = bm.slice();
      o[x & 3] |= 1 << (x >> 2);
      o[y & 3] |= 1 << (y >> 2);
      const theirs = scoreFromMasks(o[0], o[1], o[2], o[3]);
      total += w;
      if (mine > theirs) win += w; else if (mine === theirs) win += w / 2;
    }
  }
  return total > 0 ? win / total : 0.5;
}

export class RealtimeSolver {
  /**
   * @param {any} core wasm exports
   * @param {{turn:{iterations?:number,budgetMs?:number,minIterations?:number},
   *          river:{iterations?:number,budgetMs?:number,minIterations?:number},
   *          sizes?:any, purifyBelow?:number, rangeFloor?:number, analysis?:boolean, riverStride?:number, adaptive?:boolean}} cfg
   */
  constructor(core, cfg) {
    this.core = core;
    this.cfg = cfg;
    this.purifyBelow = cfg.purifyBelow ?? 0.02;
    this.rangeFloor = cfg.rangeFloor ?? 0.01;
    this.startHand();
  }

  startHand() {
    /** @type {Subgame|null} */
    this.sg = null;
    this.sgStreet = -1;
    this.ranges = /** @type {Float32Array[]|null} */ (null);
    this.locks = new Map();
    this.prevStreetDone = -1;
  }

  /** Actions on one street, in tree-player terms. */
  #pathFor(obs, street, behind) {
    const path = [];
    for (const h of obs.history) {
      if (h.street !== street) continue;
      if (h.type !== 'check' && h.type !== 'call' && h.type !== 'raise') continue;
      path.push({
        player: h.seat === obs.button ? 0 : 1,
        type: TYPE[h.type],
        to: h.type === 'raise' ? Math.min(h.to, behind) : 0,
      });
    }
    return path;
  }

  /** Chips each tree player had in the pot when `street` began, and the betting room left. */
  #streetStart(obs, street) {
    const inv = [0, 0];
    for (const h of obs.history) {
      if (h.street >= street) break;
      if (h.type === 'uncalled_return') inv[h.seat] -= h.amount;
      else inv[h.seat] += h.amount;
    }
    const treeInv = obs.button === 0 ? [inv[0], inv[1]] : [inv[1], inv[0]];
    const behind = Math.min(obs.startStacks[0] - inv[0], obs.startStacks[1] - inv[1]);
    return { inv: treeInv, behind };
  }

  /** Carry the ranges across a street using the last solve's strategy along the real betting line. */
  #rangesAfter(obs, walker) {
    if (obs.street === 2 || !this.sg || this.sgStreet !== obs.street - 1) {
      return [walker.reach[0].slice(), walker.reach[1].slice()];
    }
    const prev = this.sg;
    const start = this.#streetStart(obs, obs.street - 1);
    prev.path = this.#pathFor(obs, obs.street - 1, start.behind);
    try {
      const { reach } = prev.pathReach();
      const out = [new Float32Array(NUM_HANDS), new Float32Array(NUM_HANDS)];
      const root = this.ranges ?? [walker.reach[0], walker.reach[1]];
      for (let p = 0; p < 2; p++) {
        let rs = 0, os = 0;
        for (let i = 0; i < prev.H; i++) { rs += reach[p][i]; os += root[p][prev.handList[i]]; }
        const k = rs > 0 ? os / rs : 1;
        for (let i = 0; i < prev.H; i++) {
          const h = prev.handList[i];
          // A small share of the earlier range survives, so an unexpected line never empties the range.
          out[p][h] = reach[p][i] * k + this.rangeFloor * root[p][h];
        }
      }
      return out;
    } catch {
      return [walker.reach[0].slice(), walker.reach[1].slice()];
    }
  }

  /**
   * Make sure a solved tree exists for the current street and betting line. Reuses the last solve when the
   * line is still on its tree, so a follow-up decision on the same street is instant.
   * @param {any} obs @param {any} walker @param {number} keepHand a hand that must stay in the solve
   */
  prepare(obs, walker, keepHand) {
    const street = obs.street;
    const start = this.#streetStart(obs, street);
    if (start.behind <= 0) return null;
    const path = this.#pathFor(obs, street, start.behind);
    const budget = street === 2 ? this.cfg.turn : this.cfg.river;
    const usable = this.sg && this.sgStreet === street && this.#onTree(this.sg, path) && this.sg.handIndex[keepHand] >= 0;
    let reused = false;
    if (usable) {
      /** @type {Subgame} */ (this.sg).path = path;
      reused = true;
    } else {
      if (this.sgStreet !== street) {
        this.ranges = this.#rangesAfter(obs, walker);
        this.locks = new Map();
      }
      const ranges = /** @type {Float32Array[]} */ (this.ranges);
      this.sg = new Subgame(this.core, {
        board: obs.board, inv: start.inv, behind: start.behind, ranges, path,
        minBet: obs.bigBlind, sizes: this.cfg.sizes, keep: [keepHand], riverStride: street === 2 ? (this.cfg.riverStride ?? 4) : 1,
      });
      this.sgStreet = street;
      for (const [pos, sigma] of this.locks) {
        const nodeIdx = this.sg.pathNodes[pos];
        if (nodeIdx !== undefined && this.sg.nodes[nodeIdx].na * this.sg.H === sigma.length) this.sg.lockNode(nodeIdx, sigma);
      }
      this.sg.run(budget);
      // On a slow device, fewer modelled rivers gives a better answer inside the time budget (see BENCHMARKS.md).
      if (this.cfg.adaptive && street === 2 && (this.sg.lastRunMs ?? 0) / Math.max(1, this.sg.iterations) > 45) this.cfg.riverStride = 6;
    }
    return { sg: /** @type {Subgame} */ (this.sg), path, reused };
  }

  /**
   * Decide one turn or river action.
   * @param {{obs:any, walker:any, me:number, rng:{next:()=>number}}} ctx
   */
  decide({ obs, walker, me, rng }) {
    const street = obs.street;
    const hand = pairIdx(obs.hole[0], obs.hole[1]);
    const ready = this.prepare(obs, walker, hand);
    if (!ready) return null;
    const { path, reused } = ready;
    const sg = /** @type {Subgame} */ (this.sg);
    const { reach, node } = sg.pathReach();
    const n = sg.nodes[node];
    if (n.type !== 0 || n.player !== me) return null;

    const sigma = sg.handStrategy(node, hand);
    const a = this.#sample(sigma, rng);
    const opt = n.opts[a];
    this.locks.set(path.length, sg.strategy(node));

    const l = obs.legal;
    let action;
    if (opt.type === ACT_FOLD) action = l.canCheck ? { type: 'check' } : { type: 'fold' };
    else if (opt.type === ACT_CHECK) action = l.canCheck ? { type: 'check' } : { type: 'fold' };
    else if (opt.type === ACT_CALL) action = l.canCall ? { type: 'call' } : { type: 'check' };
    else if (!l.canRaise) action = l.canCall ? { type: 'call' } : { type: 'check' };
    else action = { type: 'raise', to: Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, opt.to)) };

    const info = {
      source: 'solver', street, reused,
      iterations: sg.iterations, ms: sg.lastRunMs ?? 0, hands: sg.H,
      options: n.opts.map((o, i) => ({ type: o.type, to: o.to, allIn: o.type === ACT_RAISE && o.to >= sg.behind, prob: sigma[i] })),
      chosen: a,
    };
    if (this.cfg.analysis) {
      const oppFull = new Float32Array(NUM_HANDS);
      for (let i = 0; i < sg.H; i++) oppFull[sg.handList[i]] = reach[1 - me][i];
      info.equity = equityVsRange(hand, obs.board, oppFull);
      info.oppRange = oppFull;
      const ev = sg.actionValues(node, me, hand, reach[1 - me]);
      if (ev) info.options.forEach((o, i) => { o.ev = ev[i]; });
    }
    return { action, info };
  }

  /** @param {Subgame} sg @param {{player:number,type:number,to:number}[]} path */
  #onTree(sg, path) {
    let node = sg.rootNode;
    for (const act of path) {
      const n = sg.nodes[node];
      if (n.type !== 0 || n.player !== act.player) return false;
      const a = n.opts.findIndex((o) => o.type === act.type && (o.type !== ACT_RAISE || o.to === act.to));
      if (a < 0) return false;
      node = sg.kids[n.first + a];
    }
    return true;
  }

  /** @param {number[]} sigma @param {{next:()=>number}} rng */
  #sample(sigma, rng) {
    const p = sigma.map((x) => (x < this.purifyBelow ? 0 : x));
    let total = p.reduce((s, x) => s + x, 0);
    if (total <= 0) { p.splice(0, p.length, ...sigma); total = sigma.reduce((s, x) => s + x, 0) || 1; }
    let u = rng.next() * total;
    for (let a = 0; a < p.length; a++) { u -= p[a]; if (u <= 0 && p[a] > 0) return a; }
    for (let a = p.length - 1; a >= 0; a--) if (p[a] > 0) return a;
    return 0;
  }
}
