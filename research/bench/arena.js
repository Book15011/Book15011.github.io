// Duplicate-deal benchmark harness. Runs the exact JS code that ships to the browser.
//
// Each deck is played twice with the seats swapped, which cancels most of the card luck.
// Results are reported per hand with a 95% confidence interval computed over duplicate pairs.
import { HandState } from '../../poker/js/engine/game.js';
import { seededRng, shuffledDeck } from '../../poker/js/engine/cards.js';

/**
 * @typedef {{name:string, act:(obs:any)=>any|Promise<any>, onHandStart?:(obs:any)=>void, onHandEnd?:(info:any)=>void}} Bot
 */

/** Plays one hand. @param {Bot} seat0 @param {Bot} seat1 */
export async function playHand(seat0, seat1, { stacks, smallBlind, bigBlind, button, deck, timing }) {
  const hand = new HandState({ stacks, smallBlind, bigBlind, button, deck });
  const bots = [seat0, seat1];
  for (let s = 0; s < 2; s++) bots[s].onHandStart?.(hand.observation(s));
  let guard = 0;
  while (!hand.finished) {
    const s = hand.toAct;
    const obs = hand.observation(s);
    const t0 = performance.now();
    const a = await bots[s].act(obs);
    if (timing) timing(s, performance.now() - t0, obs.street);
    hand.apply(a); // throws on any illegal action, which fails the benchmark loudly
    if (++guard > 400) throw new Error('hand did not terminate');
  }
  for (let s = 0; s < 2; s++) bots[s].onHandEnd?.({ result: hand.result, observation: hand.observation(s) });
  return hand;
}

/**
 * @param {() => Bot} makeA @param {() => Bot} makeB
 * @param {{pairs:number, seed:number, stackBB:number, bigBlind?:number, onProgress?:(n:number)=>void}} opts
 */
export async function runMatch(makeA, makeB, opts) {
  const { pairs, seed, stackBB } = opts;
  const bigBlind = opts.bigBlind ?? 100;
  const smallBlind = bigBlind / 2;
  const stack = stackBB * bigBlind;
  const a = makeA(), b = makeB();
  const deckRng = seededRng(seed);
  let sum = 0, sq = 0;
  const latency = { a: [], b: [] };
  const seat = { button: { sum: 0, n: 0 }, bb: { sum: 0, n: 0 } };
  for (let i = 0; i < pairs; i++) {
    const deck = shuffledDeck(deckRng.int);
    let pairNet = 0;
    for (const aSeat of [0, 1]) {
      const button = (i + aSeat) % 2;
      const players = aSeat === 0 ? [a, b] : [b, a];
      const hand = await playHand(players[0], players[1], {
        stacks: [stack, stack], smallBlind, bigBlind, button, deck,
        timing: (s, ms) => (s === aSeat ? latency.a : latency.b).push(ms),
      });
      const net = hand.result.net[aSeat];
      pairNet += net;
      const role = button === aSeat ? seat.button : seat.bb;
      role.sum += net; role.n++;
    }
    const perHand = pairNet / 2;
    sum += perHand; sq += perHand * perHand;
    opts.onProgress?.(i + 1);
  }
  const mean = sum / pairs;
  const variance = Math.max(0, sq / pairs - mean * mean);
  const se = Math.sqrt(variance / pairs);
  const toBB100 = (/** @type {number} */ x) => (x / bigBlind) * 100;
  const pct = (/** @type {number[]} */ arr, /** @type {number} */ p) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return {
    a: a.name, b: b.name, hands: pairs * 2, pairs, stackBB, seed,
    bb100: toBB100(mean), ci95: toBB100(1.96 * se),
    asButton: role(seat.button, toBB100), asBigBlind: role(seat.bb, toBB100),
    latencyMsA: { mean: avg(latency.a), p50: pct(latency.a, 0.5), p95: pct(latency.a, 0.95), max: pct(latency.a, 1) },
    latencyMsB: { mean: avg(latency.b), p50: pct(latency.b, 0.5), p95: pct(latency.b, 0.95), max: pct(latency.b, 1) },
  };
}

const role = (/** @type {{sum:number,n:number}} */ r, /** @type {(x:number)=>number} */ f) => (r.n ? f(r.sum / r.n) : 0);
const avg = (/** @type {number[]} */ a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
