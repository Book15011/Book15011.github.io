// @ts-check
/**
 * Reader for a trained blueprint (see writeExport in research/trainer/train.cpp), plus a walker that
 * follows a real hand through the abstract game tree and tracks both players' hand ranges.
 *
 * The blueprint is a set of average strategies from Monte Carlo CFR self-play, stored as bytes per
 * (betting line, card bucket, action). It is an approximate equilibrium of an abstracted game, not of real poker.
 */
import { NUM_HANDS, HAND_A, HAND_B, PRE169 } from './hands.js';

export const NODE_DECISION = 0, NODE_FOLD = 1, NODE_SHOWDOWN = 2;
export const A_FOLD = 0, A_CHECK = 1, A_CALL = 2, A_RAISE = 3;

export class Blueprint {
  /** @param {ArrayBuffer} buffer */
  constructor(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x31424B50) throw new Error('Bad blueprint file');
    this.depthBB = dv.getUint32(4, true);
    const numNodes = dv.getUint32(8, true), numKids = dv.getUint32(12, true);
    this.buckets = [dv.getUint32(16, true), dv.getUint32(20, true), dv.getUint32(24, true), dv.getUint32(28, true)];
    let o = 32;
    this.type = new Uint8Array(numNodes);
    this.player = new Uint8Array(numNodes);
    this.street = new Uint8Array(numNodes);
    this.na = new Uint8Array(numNodes);
    this.inv0 = new Int32Array(numNodes);
    this.inv1 = new Int32Array(numNodes);
    this.first = new Int32Array(numNodes);
    this.bet0 = new Int32Array(numNodes);
    this.bet1 = new Int32Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
      this.type[i] = dv.getUint8(o); this.player[i] = dv.getUint8(o + 1); this.street[i] = dv.getUint8(o + 2); this.na[i] = dv.getUint8(o + 3);
      this.inv0[i] = dv.getInt32(o + 4, true); this.inv1[i] = dv.getInt32(o + 8, true);
      this.first[i] = dv.getInt32(o + 12, true);
      this.bet0[i] = dv.getInt32(o + 20, true); this.bet1[i] = dv.getInt32(o + 24, true);
      o += 28;
    }
    this.kids = new Int32Array(numKids);
    for (let i = 0; i < numKids; i++, o += 4) this.kids[i] = dv.getInt32(o, true);
    this.actionType = new Uint8Array(buffer, o, numKids).slice();
    o += numKids;
    this.actionTo = new Int32Array(numKids);
    for (let i = 0; i < numKids; i++, o += 4) this.actionTo[i] = dv.getInt32(o, true);
    this.stratOff = new Int32Array(numNodes).fill(-1);
    let off = 0;
    for (let i = 0; i < numNodes; i++) {
      if (this.type[i] !== NODE_DECISION) continue;
      this.stratOff[i] = off;
      off += this.buckets[this.street[i]] * this.na[i];
    }
    this.strat = new Uint8Array(buffer, o, off);
  }

  /** Probability of action `a` at node `n` for card bucket `b`. @param {number} n @param {number} b @param {number} a */
  prob(n, b, a) {
    return this.strat[this.stratOff[n] + b * this.na[n] + a] / 255;
  }

  /** Size of each raise at node n as a fraction of the pot after calling. @param {number} n */
  raiseFractions(n) {
    const f = this.first[n], cur = Math.max(this.bet0[n], this.bet1[n]);
    const mine = this.player[n] === 0 ? this.bet0[n] : this.bet1[n];
    const potAfterCall = this.inv0[n] + this.inv1[n] + (cur - mine);
    const out = [];
    for (let a = 0; a < this.na[n]; a++) {
      if (this.actionType[f + a] === A_RAISE) out.push({ a, frac: (this.actionTo[f + a] - cur) / potAfterCall, to: this.actionTo[f + a], child: this.kids[f + a] });
    }
    return out;
  }
}

/** The pseudo-harmonic mapping (Ganzfried & Sandholm 2013): probability a bet x maps to the smaller size A. */
export function pseudoHarmonic(A, B, x) {
  return ((B - x) * (1 + A)) / ((B - A) * (1 + x));
}

/**
 * Follows one hand through a blueprint tree. Tracks, for each tree player (0 = button, 1 = big blind),
 * the likelihood of each of the 1326 hands given the betting so far. Only betting and public cards are
 * used, so hidden cards never enter this calculation.
 */
export class BlueprintWalker {
  /**
   * @param {Blueprint} bp
   * @param {(street:number, board:number[], out:Int16Array)=>boolean} bucketsFor fills hand buckets for a street
   * @param {{next:()=>number}} rng
   */
  constructor(bp, bucketsFor, rng) {
    this.bp = bp;
    this.bucketsFor = bucketsFor;
    this.rng = rng;
    this.node = 0;
    this.offTree = false;
    this.reach = [new Float32Array(NUM_HANDS).fill(1), new Float32Array(NUM_HANDS).fill(1)];
    this.bucket = new Int16Array(NUM_HANDS);
    this.bucketStreet = -1;
    this.board = /** @type {number[]} */ ([]);
    this.leaf = false;       // true once the light table has ended (the turn is next)
    this.translated = false; // true once a real bet had to be mapped to a different abstract size
  }

  /** Make sure `bucket[]` matches the walker's current street. */
  syncBuckets() {
    const street = this.bp.street[this.node];
    if (street === this.bucketStreet) return;
    if (street === 0) {
      for (let h = 0; h < NUM_HANDS; h++) this.bucket[h] = PRE169[h];
    } else if (this.board.length < street + 2 || !this.bucketsFor(street, this.board, this.bucket)) {
      this.offTree = true; // the real hand and the abstract line disagree about the street
      return;
    }
    this.bucketStreet = street;
    // Hands that collide with the new board are impossible for both players.
    for (let h = 0; h < NUM_HANDS; h++) {
      if (this.bucket[h] < 0) { this.reach[0][h] = 0; this.reach[1][h] = 0; }
    }
  }

  /** @param {number[]} board Call whenever public cards change. */
  setBoard(board) { this.board = board.slice(); }

  /** Remove every hand that contains a known card from the given player's range. @param {number} player @param {number[]} cards */
  removeBlocked(player, cards) {
    for (let h = 0; h < NUM_HANDS; h++) {
      if (cards.includes(HAND_A[h]) || cards.includes(HAND_B[h])) this.reach[player][h] = 0;
    }
  }

  /** Abstract action list at the current node. */
  actions() {
    const bp = this.bp, n = this.node, f = bp.first[n], out = [];
    for (let a = 0; a < bp.na[n]; a++) out.push({ a, type: bp.actionType[f + a], to: bp.actionTo[f + a], child: bp.kids[f + a] });
    return out;
  }

  /** Strategy at the current node for a real hand index. @param {number} hand */
  strategyFor(hand) {
    this.syncBuckets();
    const bp = this.bp, n = this.node, na = bp.na[n], b = this.bucket[hand];
    const out = new Array(na);
    for (let a = 0; a < na; a++) out[a] = bp.prob(n, b, a);
    return out;
  }

  /** Advance on a chosen abstract action and update that player's range. @param {number} a */
  takeAction(a) {
    this.syncBuckets();
    this.#updateReach([[a, 1]]);
    this.#moveTo(this.bp.kids[this.bp.first[this.node] + a]);
  }

  /** @param {number} child */
  #moveTo(child) {
    if (child < 0) { this.leaf = true; return; } // the betting went past what this table covers
    this.node = child;
  }

  /** @param {number[][]} mix pairs of [action, weight] */
  #updateReach(mix) {
    const bp = this.bp, n = this.node, na = bp.na[n], off = bp.stratOff[n];
    const r = this.reach[bp.player[n]];
    for (let h = 0; h < NUM_HANDS; h++) {
      if (r[h] === 0) continue;
      const b = this.bucket[h];
      let p = 0;
      for (const [a, w] of mix) p += w * bp.strat[off + b * na + a];
      r[h] *= p / 255 + 0.002; // a small floor keeps hands from being ruled out by quantisation or noise
    }
  }

  /**
   * Apply a real opponent or own action. A raise of any size is translated to the abstract sizes around it.
   * @param {'fold'|'check'|'call'|'raise'} type
   * @param {number} realFraction bet size as a fraction of the pot after calling, for raises
   * @returns {boolean} true if the walker is still on the tree
   */
  applyReal(type, realFraction = 0) {
    if (this.offTree) return false;
    const bp = this.bp, n = this.node;
    if (bp.type[n] !== NODE_DECISION) { this.offTree = true; return false; }
    this.syncBuckets();
    if (this.offTree) return false;
    const acts = this.actions();
    if (type !== 'raise') {
      const want = type === 'fold' ? A_FOLD : type === 'check' ? A_CHECK : A_CALL;
      const hit = acts.find((x) => x.type === want) ?? acts.find((x) => x.type === A_CALL || x.type === A_CHECK);
      if (!hit) { this.offTree = true; return false; }
      this.#updateReach([[hit.a, 1]]);
      this.#moveTo(hit.child);
      return !this.offTree;
    }
    const raises = bp.raiseFractions(n);
    if (!raises.length) { // the abstract tree allows no raise here, so treat it as the passive action
      const hit = acts.find((x) => x.type === A_CALL || x.type === A_CHECK);
      if (!hit) { this.offTree = true; return false; }
      this.translated = true;
      this.#updateReach([[hit.a, 1]]);
      this.#moveTo(hit.child);
      return !this.offTree;
    }
    let lo = 0;
    while (lo + 1 < raises.length && raises[lo + 1].frac <= realFraction) lo++;
    if (realFraction <= raises[0].frac || lo === raises.length - 1) {
      const pick = realFraction <= raises[0].frac ? raises[0] : raises[raises.length - 1];
      if (Math.abs(pick.frac - realFraction) > 0.03) this.translated = true;
      this.#updateReach([[pick.a, 1]]);
      this.#moveTo(pick.child);
      return !this.offTree;
    }
    const A = raises[lo].frac, B = raises[lo + 1].frac;
    const wA = Math.max(0, Math.min(1, pseudoHarmonic(A, B, realFraction)));
    if (wA > 0.02 && wA < 0.98) this.translated = true;
    this.#updateReach([[raises[lo].a, wA], [raises[lo + 1].a, 1 - wA]]);
    this.#moveTo((this.rng.next() < wA ? raises[lo] : raises[lo + 1]).child);
    return !this.offTree;
  }

  /** Raise size at the current node as a pot fraction. @param {number} a */
  fractionOf(a) {
    const hit = this.bp.raiseFractions(this.node).find((x) => x.a === a);
    return hit ? hit.frac : 0;
  }

  /** True if an abstract raise is the all-in at the current node (always the largest). @param {number} a */
  isAllIn(a) {
    const r = this.bp.raiseFractions(this.node);
    return r.length > 0 && r[r.length - 1].a === a;
  }

  /** Normalised copy of a player's range. @param {number} player */
  range(player) {
    const r = this.reach[player], out = new Float32Array(NUM_HANDS);
    let s = 0;
    for (let h = 0; h < NUM_HANDS; h++) s += r[h];
    if (s > 0) for (let h = 0; h < NUM_HANDS; h++) out[h] = r[h] / s;
    return out;
  }
}
