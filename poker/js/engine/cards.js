// @ts-check
/**
 * Card primitives. A card is an integer 0..51 = rank * 4 + suit.
 * rank: 0 = deuce ... 12 = ace. suit: 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades.
 */
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const DECK_SIZE = 52;

export const rankOf = (/** @type {number} */ c) => c >> 2;
export const suitOf = (/** @type {number} */ c) => c & 3;
export const makeCard = (/** @type {number} */ r, /** @type {number} */ s) => (r << 2) | s;

/** @param {number} c */
export function cardToString(c) {
  return RANKS[c >> 2] + SUITS[c & 3];
}

/** @param {string} s e.g. "As" */
export function parseCard(s) {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const su = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0 || s.length !== 2) throw new Error(`Bad card: ${s}`);
  return makeCard(r, su);
}

/** @param {string} s e.g. "As Kd 2c" or "AsKd2c" */
export function parseCards(s) {
  const t = s.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < t.length; i += 2) out.push(parseCard(t.slice(i, i + 2)));
  return out;
}

/** Unbiased integer in [0, n) from a cryptographically secure source, by rejection sampling. @param {number} n */
export function secureRandomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Fisher-Yates. `randInt(n)` must be uniform on [0, n). Defaults to the secure source. */
export function shuffledDeck(randInt = secureRandomInt) {
  const d = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

/**
 * Small, fast, seedable PRNG (mulberry32). Used only for reproducible simulation and for
 * mixing AI strategies. Never used to shuffle the deck in real play.
 * @param {number} seed
 */
export function seededRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (/** @type {number} */ n) => Math.floor(next() * n) };
}
