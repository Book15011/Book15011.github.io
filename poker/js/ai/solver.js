// @ts-check
/**
 * JavaScript front end of the real-time solver. It builds a betting tree for the rest of the
 * current street (and the river, when solving the turn), hands it to the WebAssembly core
 * (research/solver/solver.c), runs Discounted CFR, and reads back a strategy for every hand.
 *
 * What this computes: an approximate equilibrium of the subgame that starts at the current street,
 * given estimated hand ranges and a limited set of bet sizes. It is not a solution of full poker.
 */
import { scoreFromMasks } from '../engine/evaluator.js';
import { NUM_HANDS, HAND_A, HAND_B } from './hands.js';

const N_DECISION = 0, N_FOLD = 1, N_SHOWDOWN = 2, N_CHANCE = 3;
export const ACT_FOLD = 0, ACT_CHECK = 1, ACT_CALL = 2, ACT_RAISE = 3;
const NODE_BYTES = 36;

/** Default bet menus: fractions of the pot after calling. */
export const SIZES = {
  river: { first: [0.33, 0.66, 1.0, 1.5], raise: [0.7], maxRaises: 3 },
  turn: { first: [0.5, 1.0], raise: [0.7], maxRaises: 2 },
  riverInTurn: { first: [0.66], raise: [], maxRaises: 2 },
};

/** Load the WebAssembly core. @param {ArrayBuffer|Uint8Array} bytes */
export async function loadSolverCore(bytes) {
  const { instance } = await WebAssembly.instantiate(/** @type {any} */ (bytes), {});
  return /** @type {any} */ (instance.exports);
}

export class Subgame {
  /**
   * @param {any} core wasm exports
   * @param {{ board:number[], inv:number[], behind:number, ranges:Float32Array[], path?:{player:number,type:number,to:number}[],
   *           minBet:number, sizes?:any, handFloor?:number, keep?:number[] }} p
   *   inv: chips each tree player has invested at the start of this street. behind: chips each player can still bet.
   *   ranges: per tree player (0 = button, 1 = big blind), 1326 weights. path: real actions so far on this street.
   */
  constructor(core, p) {
    this.core = core;
    this.board = p.board.slice();
    this.isRiver = p.board.length === 5;
    this.inv = p.inv;
    this.behind = p.behind;
    this.minBet = p.minBet;
    this.path = p.path ?? [];
    this.sizes = p.sizes ?? SIZES;

    // Hands in play: not blocked by the board and with non-trivial weight for at least one player.
    const blocked = new Uint8Array(52);
    for (const c of p.board) blocked[c] = 1;
    // Hands far below the most likely ones barely affect the result, and dropping them speeds up every pass.
    const floor = p.handFloor ?? 1e-3;
    const keep = new Set(p.keep ?? []);
    const norm = [0, 1].map((i) => { let m = 0; for (let h = 0; h < NUM_HANDS; h++) if (p.ranges[i][h] > m) m = p.ranges[i][h]; return m || 1; });
    this.handList = /** @type {number[]} */ ([]);
    this.handIndex = new Int16Array(NUM_HANDS).fill(-1);
    for (let h = 0; h < NUM_HANDS; h++) {
      if (blocked[HAND_A[h]] || blocked[HAND_B[h]]) continue;
      if (!keep.has(h) && p.ranges[0][h] / norm[0] < floor && p.ranges[1][h] / norm[1] < floor) continue;
      this.handIndex[h] = this.handList.length;
      this.handList.push(h);
    }
    this.H = this.handList.length;

    // Tree, in depth-first order.
    this.nodes = /** @type {any[]} */ ([]);
    this.kids = /** @type {number[]} */ ([]);
    this.kidCard = /** @type {number[]} */ ([]);
    this.floats = 0;
    this.pathNodes = /** @type {number[]} */ ([]); // node index along the actual path
    this.rivers = /** @type {number[]} */ ([]);    // showdown contexts: river card, or -1 at a river root
    this.riverOf = new Map();
    this.#buildRoot();
    this.#writeToWasm(p.ranges);
    this.iterations = 0;
  }

  // ---------- tree ----------
  #buildRoot() {
    const blank = [0, 0];
    this.rootNode = this.#decision({
      river: this.isRiver, card: -1, player: 1, bets: blank, inv: this.inv.slice(), raises: 0, lastRaise: this.minBet, pathPos: 0,
    });
  }

  #menu(/** @type {any} */ st) {
    if (this.isRiver) return this.sizes.river;
    return st.river ? this.sizes.riverInTurn : this.sizes.turn;
  }

  /** @param {{river:boolean, card:number, player:number, bets:number[], inv:number[], raises:number, lastRaise:number, pathPos:number}} st */
  #decision(st) {
    const { player, bets, inv } = st;
    const cur = Math.max(bets[0], bets[1]);
    const owe = cur - bets[player];
    const pot = inv[0] + inv[1] + bets[0] + bets[1];
    const maxTo = this.behind;
    const onPath = st.pathPos >= 0 && st.pathPos < this.path.length && this.path[st.pathPos].player === player;
    const pathAct = onPath ? this.path[st.pathPos] : null;

    const opts = /** @type {{type:number,to:number}[]} */ ([]);
    if (owe > 0) { opts.push({ type: ACT_FOLD, to: 0 }); opts.push({ type: ACT_CALL, to: 0 }); }
    else opts.push({ type: ACT_CHECK, to: 0 });

    const oppBehind = this.behind - bets[1 - player];
    if (oppBehind > 0 && maxTo > cur) {
      const menu = this.#menu(st);
      const minTo = Math.min(maxTo, cur + Math.max(st.lastRaise, this.minBet));
      const cands = /** @type {number[]} */ ([]);
      if (st.raises < menu.maxRaises) {
        for (const f of st.raises === 0 ? menu.first : menu.raise) cands.push(Math.round(cur + f * (pot + owe)));
      }
      if (pathAct && pathAct.type === ACT_RAISE) cands.push(pathAct.to);
      cands.sort((x, y) => x - y);
      let prev = cur;
      for (let to of cands) {
        const isPath = !!pathAct && pathAct.type === ACT_RAISE && to === pathAct.to;
        if (to < minTo) to = minTo;
        if (!isPath && (to >= 0.8 * maxTo || to <= prev)) continue;
        if (to >= maxTo) break;
        if (to > prev) { opts.push({ type: ACT_RAISE, to }); prev = to; }
      }
      opts.push({ type: ACT_RAISE, to: maxTo });
    }
    if (opts.length > 8) throw new Error('Too many actions at a solver node');

    const idx = this.nodes.length;
    const node = { type: N_DECISION, player, na: opts.length, first: this.kids.length, off: this.floats, opts, river: 0 };
    this.nodes.push(node);
    this.floats += opts.length * this.H;
    if (onPath) this.pathNodes[st.pathPos] = idx;
    const base = this.kids.length;
    for (let i = 0; i < opts.length; i++) { this.kids.push(-1); this.kidCard.push(0); }

    for (let a = 0; a < opts.length; a++) {
      const o = opts[a];
      let nextPos = -1;
      if (onPath && pathAct) {
        const same = pathAct.type === o.type && (o.type !== ACT_RAISE || pathAct.to === o.to);
        if (same) nextPos = st.pathPos + 1;
      }
      let child;
      if (o.type === ACT_FOLD) {
        child = this.#foldNode(st, 1 - player);
      } else if (o.type === ACT_CHECK) {
        child = player === 0 ? this.#endStreet(st, bets) : this.#decision({ ...st, player: 0, pathPos: nextPos });
      } else if (o.type === ACT_CALL) {
        const nb = player === 0 ? [cur, bets[1]] : [bets[0], cur];
        child = this.#endStreet(st, nb);
      } else {
        const nb = player === 0 ? [o.to, bets[1]] : [bets[0], o.to];
        child = this.#decision({ ...st, player: 1 - player, bets: nb, raises: st.raises + 1, lastRaise: o.to - cur, pathPos: nextPos });
      }
      this.kids[base + a] = child;
    }
    return idx;
  }

  #foldNode(/** @type {any} */ st, /** @type {number} */ winner) {
    const i0 = st.inv[0] + st.bets[0], i1 = st.inv[1] + st.bets[1];
    const win = [winner === 0 ? i1 : -i0, winner === 1 ? i0 : -i1];
    this.nodes.push({ type: N_FOLD, player: 0, na: 0, first: 0, off: 0, win, lose: [0, 0], tie: [0, 0], river: 0 });
    return this.nodes.length - 1;
  }

  /** @param {number} card */
  #riverCtx(card) {
    if (!this.riverOf.has(card)) { this.riverOf.set(card, this.rivers.length); this.rivers.push(card); }
    return this.riverOf.get(card);
  }

  #showdownNode(/** @type {number[]} */ inv, /** @type {number} */ card) {
    this.nodes.push({ type: N_SHOWDOWN, player: 0, na: 0, first: 0, off: 0, win: [inv[1], inv[0]], lose: [inv[0], inv[1]], tie: [0, 0], river: this.#riverCtx(card) });
    return this.nodes.length - 1;
  }

  /** Everyone has acted on this street. @param {any} st @param {number[]} bets */
  #endStreet(st, bets) {
    const inv = [st.inv[0] + bets[0], st.inv[1] + bets[1]];
    const allIn = Math.max(bets[0], bets[1]) >= this.behind;
    if (st.river) return this.#showdownNode(inv, st.card);
    // Turn street ended: deal each possible river.
    const idx = this.nodes.length;
    const seen = new Uint8Array(52);
    for (const c of this.board) seen[c] = 1;
    const cards = [];
    for (let c = 0; c < 52; c++) if (!seen[c]) cards.push(c);
    this.nodes.push({ type: N_CHANCE, player: 0, na: cards.length, first: this.kids.length, off: 0, river: 0 });
    const base = this.kids.length;
    for (const c of cards) { this.kids.push(-1); this.kidCard.push(c); }
    const leftBehind = this.behind - Math.max(bets[0], bets[1]);
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      this.kids[base + i] = allIn
        ? this.#showdownNode(inv, c)
        : new RiverBuilder(this).build(inv, leftBehind, c);
    }
    return idx;
  }

  /** Internal: build a river decision in the turn subgame. */
  _riverDecision(/** @type {number[]} */ inv, /** @type {number} */ card, /** @type {number} */ behindBefore) {
    const saved = this.behind;
    this.behind = behindBefore;
    const out = this.#decision({ river: true, card, player: 1, bets: [0, 0], inv, raises: 0, lastRaise: this.minBet, pathPos: -1 });
    this.behind = saved;
    return out;
  }

  // ---------- WebAssembly ----------
  #writeToWasm(/** @type {Float32Array[]} */ ranges) {
    const c = this.core;
    c.sv_reset();
    c.sv_setup(this.H, this.nodes.length, this.kids.length, this.floats, this.rivers.length, this.isRiver ? 1 : 44);
    const mem = () => c.memory.buffer;
    // Node records.
    const dv = new DataView(mem());
    const np = c.sv_nodes();
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i], o = np + i * NODE_BYTES;
      dv.setUint8(o, n.type); dv.setUint8(o + 1, n.player); dv.setUint8(o + 2, n.na); dv.setUint8(o + 3, n.river);
      dv.setInt32(o + 4, n.first, true); dv.setInt32(o + 8, n.off, true);
      const w = n.win ?? [0, 0], l = n.lose ?? [0, 0], t = n.tie ?? [0, 0];
      dv.setFloat32(o + 12, w[0], true); dv.setFloat32(o + 16, w[1], true);
      dv.setFloat32(o + 20, l[0], true); dv.setFloat32(o + 24, l[1], true);
      dv.setFloat32(o + 28, t[0], true); dv.setFloat32(o + 32, t[1], true);
    }
    new Int32Array(mem(), c.sv_kids(), this.kids.length).set(this.kids);
    new Uint8Array(mem(), c.sv_kid_card(), this.kids.length).set(this.kidCard);
    const ha = new Int8Array(mem(), c.sv_hand_a(), this.H), hb = new Int8Array(mem(), c.sv_hand_b(), this.H);
    for (let i = 0; i < this.H; i++) { ha[i] = HAND_A[this.handList[i]]; hb[i] = HAND_B[this.handList[i]]; }
    for (let p = 0; p < 2; p++) {
      const r = new Float32Array(mem(), c.sv_reach(p), this.H);
      let s = 0;
      for (let i = 0; i < this.H; i++) s += ranges[p][this.handList[i]];
      const k = s > 0 ? this.H / s : 1;
      for (let i = 0; i < this.H; i++) r[i] = ranges[p][this.handList[i]] * k;
    }
    // Showdown contexts: hands sorted by strength with tie-group ends.
    const m = [0, 0, 0, 0];
    for (const x of this.board) m[x & 3] |= 1 << (x >> 2);
    const keys = new Float64Array(this.H);
    for (let r = 0; r < this.rivers.length; r++) {
      const card = this.rivers[r];
      const bm = m.slice();
      if (card >= 0) bm[card & 3] |= 1 << (card >> 2);
      let n = 0;
      for (let i = 0; i < this.H; i++) {
        const a = ha[i], b = hb[i];
        if (a === card || b === card) continue;
        const s = [bm[0], bm[1], bm[2], bm[3]];
        s[a & 3] |= 1 << (a >> 2);
        s[b & 3] |= 1 << (b >> 2);
        keys[n++] = scoreFromMasks(s[0], s[1], s[2], s[3]) * 4096 + i;
      }
      const sorted = keys.subarray(0, n).sort();
      const ordPtr = c.sv_set_showdown(r, n);
      const endPtr = c.sv_group_end(r);
      const ord = new Int16Array(mem(), ordPtr, n), gend = new Int16Array(mem(), endPtr, n);
      for (let i = 0; i < n; i++) ord[i] = sorted[i] % 4096;
      for (let i = 0; i < n;) {
        const sc = Math.floor(sorted[i] / 4096);
        let j = i + 1;
        while (j < n && Math.floor(sorted[j] / 4096) === sc) j++;
        for (let k = i; k < j; k++) gend[k] = j;
        i = j;
      }
    }
  }

  /** Pin a past decision by the agent so the solve treats it as a fact. @param {number} node @param {Float32Array} sigma */
  lockNode(node, sigma) {
    const p = this.core.sv_lock_node(node);
    new Float32Array(this.core.memory.buffer, p, this.nodes[node].na * this.H).set(sigma);
  }

  /** Run DCFR for a number of iterations or until a time budget ends. @param {{iterations?:number, budgetMs?:number, minIterations?:number}} b */
  run(b) {
    const t0 = performance.now();
    const maxIters = b.iterations ?? 100000;
    const budget = b.budgetMs ?? Infinity;
    const minI = b.minIterations ?? 1;
    let i = 0;
    while (i < maxIters) {
      this.core.sv_iterate(++this.iterations);
      i++;
      if (i >= minI && performance.now() - t0 > budget) break;
    }
    this.lastRunMs = performance.now() - t0;
    return i;
  }

  /** Exploitability of the current average strategy in chips per hand (for the modelled ranges). */
  exploitability() { return this.core.sv_exploitability(); }

  /** Average strategy over all hands at a node: Float32Array(na*H). @param {number} node */
  strategy(node) {
    const n = this.nodes[node];
    const need = n.na * this.H;
    if (!this.scratchPtr || this.scratchCap < need) {
      this.scratchPtr = this.core.sv_alloc(need * 4);
      this.scratchCap = need;
    }
    this.core.sv_avg_strategy(node, this.scratchPtr);
    return new Float32Array(this.core.memory.buffer, this.scratchPtr, need).slice();
  }

  /** Strategy for one specific hand. @param {number} node @param {number} hand */
  handStrategy(node, hand) {
    const n = this.nodes[node], s = this.strategy(node), i = this.handIndex[hand], out = [];
    if (i < 0) { for (let a = 0; a < n.na; a++) out.push(1 / n.na); return out; }
    for (let a = 0; a < n.na; a++) out.push(s[a * this.H + i]);
    return out;
  }

  /**
   * Expected value of each action for one hand, against the opposing range reaching this node.
   * Under the model only: estimated ranges and this tree's bet sizes.
   * @param {number} node @param {number} me @param {number} hand @param {Float32Array} oppReach length H
   */
  actionValues(node, me, hand, oppReach) {
    const c = this.core, n = this.nodes[node], i = this.handIndex[hand];
    if (i < 0) return null;
    const oppPtr = c.sv_alloc(this.H * 4);
    new Float32Array(c.memory.buffer, oppPtr, this.H).set(oppReach);
    const dst = c.sv_alloc(n.na * this.H * 4);
    c.sv_action_values(node, me, oppPtr, dst);
    const vals = new Float32Array(c.memory.buffer, dst, n.na * this.H);
    const a = HAND_A[hand], b = HAND_B[hand];
    let w = 0;
    for (let j = 0; j < this.H; j++) {
      const h = this.handList[j];
      if (HAND_A[h] === a || HAND_B[h] === a || HAND_A[h] === b || HAND_B[h] === b) continue;
      w += oppReach[j];
    }
    const out = [];
    for (let x = 0; x < n.na; x++) out.push(w > 0 ? vals[x * this.H + i] / w : 0);
    return out;
  }

  /** Reach of each player along the actual path from the root, as H-length vectors. @param {number} upTo actions to include */
  pathReach(upTo = this.path.length) {
    const c = this.core;
    const reach = [0, 1].map((p) => new Float32Array(c.memory.buffer, c.sv_reach(p), this.H).slice());
    let node = this.rootNode;
    for (let i = 0; i < upTo; i++) {
      const act = this.path[i];
      const n = this.nodes[node];
      const a = this.#findAction(n, act);
      const s = this.strategy(node);
      const r = reach[n.player];
      for (let h = 0; h < this.H; h++) r[h] *= s[a * this.H + h];
      node = this.kids[n.first + a];
    }
    return { reach, node };
  }

  /** @param {any} n @param {{type:number,to:number}} act */
  #findAction(n, act) {
    const a = n.opts.findIndex((/** @type {any} */ o) => o.type === act.type && (o.type !== ACT_RAISE || o.to === act.to));
    if (a < 0) throw new Error('Path action is not in the tree');
    return a;
  }
}

class RiverBuilder {
  constructor(/** @type {Subgame} */ sg) { this.sg = sg; }
  build(/** @type {number[]} */ inv, /** @type {number} */ behind, /** @type {number} */ card) {
    return this.sg._riverDecision(inv, card, behind);
  }
}
