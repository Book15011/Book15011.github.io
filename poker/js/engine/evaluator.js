// @ts-check
/**
 * Hand evaluator for 5 to 7 cards using 13-bit per-suit rank masks.
 * Higher score = better hand; equal score = exact tie.
 *
 * score = category << 20 | r1 << 16 | r2 << 12 | r3 << 8 | r4 << 4 | r5
 *
 * Verified exhaustively against the known 7-card category counts (see tests and
 * docs/BENCHMARKS.md) and against the C++ evaluator used for training (same formula,
 * cross-checked by hash over random hands).
 */
export const HIGH_CARD = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4, FLUSH = 5, FULL_HOUSE = 6, QUADS = 7, STRAIGHT_FLUSH = 8;
export const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

const STRAIGHT_HIGH = new Int8Array(8192); // 0 = no straight, else (high rank + 1)
const TOP5 = new Int32Array(8192);         // top five ranks packed in nibbles
const HIGHBIT = new Int8Array(8192);       // index of the highest set bit
const POP = new Int8Array(8192);

for (let m = 1; m < 8192; m++) {
  let hb = 12;
  while (!((m >> hb) & 1)) hb--;
  HIGHBIT[m] = hb;
  POP[m] = POP[m >> 1] + (m & 1);
  for (let h = 12; h >= 4; h--) {
    if (((m >> (h - 4)) & 31) === 31) { STRAIGHT_HIGH[m] = h + 1; break; }
  }
  if (!STRAIGHT_HIGH[m] && (m & 0x100F) === 0x100F) STRAIGHT_HIGH[m] = 4; // wheel: five-high (rank index 3)
  let packed = 0, left = m;
  for (let i = 0; i < 5; i++) {
    if (left) { const b = HIGHBIT[left]; packed |= b << (16 - 4 * i); left &= ~(1 << b); }
  }
  TOP5[m] = packed;
}

/**
 * Score from the four suit masks. All arithmetic is 32-bit int so this stays monomorphic and fast.
 * With at most seven cards a flush cannot coexist with quads or a full house, so checking the
 * flush first is safe.
 * @param {number} c @param {number} d @param {number} h @param {number} s
 */
export function scoreFromMasks(c, d, h, s) {
  let fl = 0;
  if (POP[c] >= 5) fl = c; else if (POP[d] >= 5) fl = d; else if (POP[h] >= 5) fl = h; else if (POP[s] >= 5) fl = s;
  if (fl) {
    const sh = STRAIGHT_HIGH[fl];
    if (sh) return (STRAIGHT_FLUSH << 20) | ((sh - 1) << 16);
    return (FLUSH << 20) | TOP5[fl];
  }
  const all = c | d | h | s;
  const twoPlus = (c & d) | (c & h) | (c & s) | (d & h) | (d & s) | (h & s);
  if (!twoPlus) {
    const sh = STRAIGHT_HIGH[all];
    if (sh) return (STRAIGHT << 20) | ((sh - 1) << 16);
    return TOP5[all]; // HIGH_CARD category is zero
  }
  const threePlus = ((c & d) & (h | s)) | ((h & s) & (c | d));
  if (threePlus) {
    const quads = c & d & h & s;
    if (quads) {
      const q = HIGHBIT[quads];
      return (QUADS << 20) | (q << 16) | (HIGHBIT[all & ~(1 << q)] << 12);
    }
    const t = HIGHBIT[threePlus];
    const rest = twoPlus & ~(1 << t);
    if (rest) return (FULL_HOUSE << 20) | (t << 16) | (HIGHBIT[rest] << 12);
    const sh = STRAIGHT_HIGH[all];
    if (sh) return (STRAIGHT << 20) | ((sh - 1) << 16);
    const k = all & ~(1 << t);
    const k1 = HIGHBIT[k];
    return (TRIPS << 20) | (t << 16) | (k1 << 12) | (HIGHBIT[k & ~(1 << k1)] << 8);
  }
  const sh = STRAIGHT_HIGH[all];
  if (sh) return (STRAIGHT << 20) | ((sh - 1) << 16);
  const p1 = HIGHBIT[twoPlus];
  const others = twoPlus & ~(1 << p1);
  if (others) {
    const p2 = HIGHBIT[others];
    return (TWO_PAIR << 20) | (p1 << 16) | (p2 << 12) | (HIGHBIT[all & ~(1 << p1) & ~(1 << p2)] << 8);
  }
  const k = all & ~(1 << p1);
  const k1 = HIGHBIT[k], m2 = k & ~(1 << k1);
  const k2 = HIGHBIT[m2], m3 = m2 & ~(1 << k2);
  return (PAIR << 20) | (p1 << 16) | (k1 << 12) | (k2 << 8) | (HIGHBIT[m3] << 4);
}

const masks = new Int32Array(4);

/** Evaluate an array of 5 to 7 cards. @param {ArrayLike<number>} cards */
export function evaluate(cards) {
  masks[0] = masks[1] = masks[2] = masks[3] = 0;
  for (let i = 0; i < cards.length; i++) {
    const x = cards[i];
    masks[x & 3] |= 1 << (x >> 2);
  }
  return scoreFromMasks(masks[0], masks[1], masks[2], masks[3]);
}

export const categoryOf = (/** @type {number} */ score) => score >> 20;
export const categoryName = (/** @type {number} */ score) => CATEGORY_NAMES[score >> 20];
