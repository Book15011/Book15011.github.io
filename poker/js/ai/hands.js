// @ts-check
/**
 * Hand and board indexing, matching research/trainer/poker.h exactly:
 * the same pair index, starting-hand classes, colex board ranks and suit canonicalisation.
 */
export const NUM_HANDS = 1326;

export const pairIdx = (/** @type {number} */ a, /** @type {number} */ b) => (a < b ? (b * (b - 1)) / 2 + a : (a * (a - 1)) / 2 + b);

export const HAND_A = new Int8Array(NUM_HANDS);
export const HAND_B = new Int8Array(NUM_HANDS);
export const PRE169 = new Int16Array(NUM_HANDS);

for (let b = 1; b < 52; b++) {
  for (let a = 0; a < b; a++) {
    const i = pairIdx(a, b);
    HAND_A[i] = a; HAND_B[i] = b;
    const ra = a >> 2, rb = b >> 2;
    const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
    PRE169[i] = (a & 3) === (b & 3) ? hi * 13 + lo : (hi === lo ? hi * 13 + hi : lo * 13 + hi);
  }
}

const BINOM = Array.from({ length: 53 }, () => new Float64Array(8));
for (let n = 0; n <= 52; n++) {
  BINOM[n][0] = 1;
  for (let k = 1; k < 8; k++) BINOM[n][k] = n === 0 ? 0 : BINOM[n - 1][k - 1] + BINOM[n - 1][k];
}

/** @param {ArrayLike<number>} sorted @param {number} n */
export function colexRank(sorted, n) {
  let r = 0;
  for (let i = 0; i < n; i++) r += BINOM[sorted[i]][i + 1];
  return r;
}

// The 24 suit permutations in lexicographic order, the order std::next_permutation visits.
const PERMS = /** @type {number[][]} */ ([]);
(function gen(/** @type {number[]} */ cur, /** @type {number[]} */ rest) {
  if (!rest.length) { PERMS.push(cur); return; }
  for (let i = 0; i < rest.length; i++) gen([...cur, rest[i]], rest.filter((_, j) => j !== i));
})([], [0, 1, 2, 3]);

export const PERM_CARD = PERMS.map((p) => {
  const t = new Uint8Array(52);
  for (let c = 0; c < 52; c++) t[c] = (c & ~3) | p[c & 3];
  return t;
});

/** Maps each n-card board to its canonical id and the suit permutation that reaches it. */
export class BoardMap {
  /** @param {number} n */
  constructor(n) {
    this.n = n;
    const total = BINOM[52][n];
    this.id = new Int32Array(total).fill(-1);
    this.perm = new Uint8Array(total);
    this.numCanon = 0;
    const canonId = new Int32Array(total).fill(-1);
    const c = new Int32Array(n);
    const t = new Int32Array(n), best = new Int32Array(n);
    const rec = (/** @type {number} */ depth, /** @type {number} */ start) => {
      if (depth === n) {
        const rank = colexRank(c, n);
        let bestP = -1;
        for (let p = 0; p < 24; p++) {
          for (let i = 0; i < n; i++) t[i] = PERM_CARD[p][c[i]];
          t.sort();
          let less = bestP < 0;
          if (!less) for (let i = 0; i < n; i++) { if (t[i] !== best[i]) { less = t[i] < best[i]; break; } }
          if (less) { bestP = p; best.set(t); }
        }
        const cr = colexRank(best, n);
        if (canonId[cr] < 0) canonId[cr] = this.numCanon++;
        this.id[rank] = canonId[cr];
        this.perm[rank] = bestP;
        return;
      }
      for (let x = start; x < 52; x++) { c[depth] = x; rec(depth + 1, x + 1); }
    };
    rec(0, 0);
  }

  /** @param {number[]} board cards in any order */
  rowOf(board) {
    const s = board.slice(0, this.n).sort((a, b) => a - b);
    const rank = colexRank(s, this.n);
    return { row: this.id[rank], perm: PERM_CARD[this.perm[rank]] };
  }
}

/** A lazily built lookup from (board, hand) to a card-abstraction bucket. */
export class BucketTable {
  /** @param {number} boardCards @param {Uint16Array} table [canonical board][hand] */
  constructor(boardCards, table) {
    this.map = new BoardMap(boardCards);
    this.table = table;
    if (table.length !== this.map.numCanon * NUM_HANDS) throw new Error(`Bucket table size mismatch for ${boardCards}-card boards`);
  }

  /** Fill `out[h]` with the bucket of every hand on this board, or -1 where cards collide. @param {number[]} board @param {Int16Array} out */
  fill(board, out) {
    const { row, perm } = this.map.rowOf(board);
    const base = row * NUM_HANDS;
    let blocked = 0n;
    for (const c of board) blocked |= 1n << BigInt(c);
    const mask = new Uint8Array(52);
    for (const c of board) mask[c] = 1;
    for (let h = 0; h < NUM_HANDS; h++) {
      const a = HAND_A[h], b = HAND_B[h];
      out[h] = mask[a] || mask[b] ? -1 : this.table[base + pairIdx(perm[a], perm[b])];
    }
    return out;
  }
}
