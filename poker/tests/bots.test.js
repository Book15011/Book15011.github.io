import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HandState, Match } from '../js/engine/game.js';
import { seededRng, parseCards } from '../js/engine/cards.js';
import { RandomBot, TightPassiveBot, LooseAggressiveBot, EquityBot, StrongHeuristicBot, CasualBot, CallStationBot, monteCarloEquity } from '../js/ai/bots.js';
import { ExpertBot, nearestDepth } from '../js/ai/expert.js';
import { Blueprint } from '../js/ai/blueprint.js';
import { BucketTable, BoardMap, pairIdx, PRE169, NUM_HANDS } from '../js/ai/hands.js';
import { RealtimeSolver, equityVsRange } from '../js/ai/realtime.js';
import { loadSolverCore } from '../js/ai/solver.js';

const models = fileURLToPath(new URL('../models/', import.meta.url));
const hasModels = existsSync(`${models}manifest.json`);

/** Play one hand with two bots, asserting that every action is legal. Illegal actions throw inside apply(). */
function play(a, b, cfg) {
  const h = new HandState(cfg);
  const bots = [a, b];
  bots[0].onHandStart?.(h.observation(0));
  bots[1].onHandStart?.(h.observation(1));
  let guard = 0;
  while (!h.finished) {
    assert.ok(++guard < 300, 'hand terminates');
    const obs = h.observation(h.toAct);
    h.apply(bots[h.toAct].act(obs));
  }
  return h;
}

const makers = {
  Random: (r) => new RandomBot(r), Tight: (r) => new TightPassiveBot(r), LAG: (r) => new LooseAggressiveBot(r),
  Equity: (r) => new EquityBot(r, 50), Strong: (r) => new StrongHeuristicBot(r, 50), Casual: (r) => new CasualBot(r), Station: () => new CallStationBot(),
};

test('fuzz: baseline bots always act legally across random stacks and blinds', () => {
  const rng = seededRng(2024);
  const names = Object.keys(makers);
  for (let i = 0; i < 3000; i++) {
    const a = makers[names[rng.int(names.length)]](rng), b = makers[names[rng.int(names.length)]](rng);
    const bb = [2, 10, 100, 400][rng.int(4)];
    const h = play(a, b, {
      stacks: [1 + rng.int(40 * bb), 1 + rng.int(40 * bb)], smallBlind: Math.floor(bb / 2), bigBlind: bb, button: rng.int(2), randInt: rng.int,
    });
    assert.equal(h.result.net[0] + h.result.net[1], 0);
  }
});

test('equity sanity: known matchups', () => {
  const rng = seededRng(5);
  const aa = monteCarloEquity(parseCards('As Ad'), [], 40000, rng);
  assert.ok(Math.abs(aa - 0.852) < 0.012, `AA vs a random hand is about 85.2%, got ${aa}`);
  const seven = monteCarloEquity(parseCards('7c 2d'), [], 40000, rng);
  assert.ok(Math.abs(seven - 0.346) < 0.012, `72o vs a random hand is about 34.6%, got ${seven}`);
  const nuts = monteCarloEquity(parseCards('As Ks'), parseCards('Qs Js Ts'), 3000, rng);
  assert.ok(nuts > 0.999, 'a made royal flush cannot lose');
});

test('exact equity against a range agrees with Monte Carlo', () => {
  const board = parseCards('2s 7h 8d Tc');
  const hand = pairIdx(...parseCards('As Kd'));
  const range = new Float32Array(NUM_HANDS).fill(1);
  const exact = equityVsRange(hand, board, range);
  const mc = monteCarloEquity(parseCards('As Kd'), board, 60000, seededRng(9));
  assert.ok(Math.abs(exact - mc) < 0.01, `${exact} vs ${mc}`);
});

test('preflop classes: 169 starting hands, with the right number of combos each', () => {
  const counts = new Map();
  for (let h = 0; h < NUM_HANDS; h++) counts.set(PRE169[h], (counts.get(PRE169[h]) ?? 0) + 1);
  assert.equal(counts.size, 169);
  const sizes = [...counts.values()].sort((a, b) => a - b);
  assert.equal(sizes.filter((x) => x === 4).length, 78, 'suited');
  assert.equal(sizes.filter((x) => x === 6).length, 13, 'pairs');
  assert.equal(sizes.filter((x) => x === 12).length, 78, 'offsuit');
});

test('canonical board counts match the known suit-isomorphism numbers', () => {
  assert.equal(new BoardMap(3).numCanon, 1755);
});

test('nearest depth picks by ratio', () => {
  assert.equal(nearestDepth([5, 8, 12, 20, 30, 50, 100], 22), 20);
  assert.equal(nearestDepth([5, 8, 12, 20, 30, 50, 100], 1), 5);
  assert.equal(nearestDepth([5, 8, 12, 20, 30, 50, 100], 500), 100);
  assert.equal(nearestDepth([5, 8, 12, 20, 30, 50, 100], 75), 100);
});

test('expert plays legally, including short stacks and odd bet sizes', { skip: !hasModels && 'models are not in poker/models yet' }, async () => {
  const manifest = JSON.parse(readFileSync(`${models}manifest.json`, 'utf8'));
  const load = (f) => { const b = gunzipSync(readFileSync(`${models}${f}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const bps = new Map(manifest.depths.map((d) => [d, new Blueprint(load(`bp_${d}.bin.gz`))]));
  const table = new BucketTable(3, new Uint16Array(load('flop_buckets.bin.gz')));
  const core = await loadSolverCore(readFileSync(new URL('../js/ai/solver.wasm', import.meta.url)));
  const rng = seededRng(77);
  const bot = new ExpertBot({
    blueprintFor: (bb) => bps.get(nearestDepth(manifest.depths, bb)),
    bucketsFor: (s, b, o) => { if (s !== 1) return false; table.fill(b, o); return true; },
    rng,
    analysis: true,
    solver: new RealtimeSolver(core, { turn: { iterations: 4 }, river: { iterations: 20 }, analysis: true }),
  });
  const rand = new RandomBot(rng);
  for (let i = 0; i < 400; i++) {
    const bb = [2, 100, 150][rng.int(3)];
    const seat = rng.int(2);
    const stacks = [1 + rng.int(100 * bb), 1 + rng.int(100 * bb)];
    const players = seat === 0 ? [bot, rand] : [rand, bot];
    const h = play(players[0], players[1], { stacks, smallBlind: Math.floor(bb / 2), bigBlind: bb, button: rng.int(2), randInt: rng.int });
    assert.equal(h.result.net[0] + h.result.net[1], 0);
  }
});

test('a whole quick match always finishes with one player over the goal or out of chips', () => {
  const rng = seededRng(404);
  const blinds = [[50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000]].map(([small, big]) => ({ small, big }));
  const lengths = [];
  for (let g = 0; g < 400; g++) {
    const m = new Match({ startingStack: 2000, blinds, handsPerLevel: 5, goalStack: 3000, randInt: rng.int });
    const bots = [new StrongHeuristicBot(rng, 30), new TightPassiveBot(rng)];
    let guard = 0;
    while (m.winner() === null) {
      assert.ok(++guard < 500, 'match ends');
      const h = m.nextHand();
      while (!h.finished) m.act(bots[h.toAct].act(h.observation(h.toAct)));
      assert.equal(m.stacks[0] + m.stacks[1], 4000, 'chips conserved across the match');
    }
    lengths.push(m.handNumber);
  }
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  console.log(`average quick match length: ${avg.toFixed(1)} hands, longest ${Math.max(...lengths)}`);
  assert.ok(avg < 25, 'a quick match stays quick');
});
