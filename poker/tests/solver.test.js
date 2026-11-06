import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCards } from '../js/engine/cards.js';
import { NUM_HANDS, pairIdx } from '../js/ai/hands.js';
import { loadSolverCore, Subgame, ACT_RAISE, ACT_CALL } from '../js/ai/solver.js';

const core = await loadSolverCore(readFileSync(new URL('../js/ai/solver.wasm', import.meta.url)));

function rangeOf(hands) {
  const r = new Float32Array(NUM_HANDS);
  for (const s of hands) {
    const [a, b] = parseCards(s);
    r[pairIdx(a, b)] = 1;
  }
  return r;
}

// The classic river toy game with a known exact answer. The big blind checks (all it can sensibly do),
// the button holds either the nuts or air, and the other player holds a pure bluff-catcher.
// For a pot-sized bet: bet all value, bluff with half as many combos as value, and call 50% of the time.
test('river toy game converges to the known equilibrium', () => {
  const board = parseCards('2s 7h 8d Tc Kh');
  const button = rangeOf(['As Ac', 'Ah Ad', 'As Ad', 'Ac Ad', '3c 4d', '3c 4h', '3d 4c', '3h 4c']); // nut pair class vs air
  const bigBlind = rangeOf(['Jc Jd', 'Jh Js', 'Jc Jh', 'Jd Js']);                                   // bluff-catchers beat air, lose to aces
  const sg = new Subgame(core, {
    board, inv: [500, 500], behind: 1000, minBet: 100, ranges: [button, bigBlind],
    sizes: { river: { first: [], raise: [], maxRaises: 0 }, turn: {}, riverInTurn: {} },
  });
  // With an empty menu the only bet is all-in, here exactly pot-sized (1000 into 1000).
  sg.run({ iterations: 4000 });
  const expl = sg.exploitability();
  assert.ok(expl < 2, `exploitability ${expl} should be tiny against a 1000 pot`);

  const root = sg.rootNode;                 // big blind to act
  const bbStrat = sg.handStrategy(root, pairIdx(...parseCards('Jc Jd')));
  const bbBet = sg.nodes[root].opts.findIndex((o) => o.type === ACT_RAISE);
  assert.ok(bbStrat[bbBet] < 0.05, 'a bluff-catcher should not bet');

  const afterCheck = sg.kids[sg.nodes[root].first + 0];
  const opts = sg.nodes[afterCheck].opts;
  const betIdx = opts.findIndex((o) => o.type === ACT_RAISE);
  const aces = sg.handStrategy(afterCheck, pairIdx(...parseCards('As Ac')));
  const air = sg.handStrategy(afterCheck, pairIdx(...parseCards('3c 4d')));
  assert.ok(aces[betIdx] > 0.97, `value always bets, got ${aces[betIdx]}`);
  assert.ok(Math.abs(air[betIdx] - 0.5) < 0.04, `bluff frequency should be 0.5, got ${air[betIdx]}`);

  const facing = sg.kids[sg.nodes[afterCheck].first + betIdx];
  const callIdx = sg.nodes[facing].opts.findIndex((o) => o.type === ACT_CALL);
  const jj = sg.handStrategy(facing, pairIdx(...parseCards('Jc Jd')));
  assert.ok(Math.abs(jj[callIdx] - 0.5) < 0.04, `call frequency should be 0.5, got ${jj[callIdx]}`);
});

test('card removal: blocked combos never contribute', () => {
  const board = parseCards('2s 7h 8d Tc Kh');
  const uniform = new Float32Array(NUM_HANDS).fill(1);
  const sg = new Subgame(core, { board, inv: [100, 100], behind: 500, minBet: 100, ranges: [uniform, uniform] });
  assert.equal(sg.H, 1081, 'C(47,2) hands remain on a five-card board');
  sg.run({ iterations: 40 });
  assert.ok(Number.isFinite(sg.exploitability()));
});

test('a full-range river solve converges quickly and strategies are normalised', () => {
  const board = parseCards('2s 7h 8d Tc Kh');
  const uniform = new Float32Array(NUM_HANDS).fill(1);
  const sg = new Subgame(core, { board, inv: [300, 300], behind: 2000, minBet: 100, ranges: [uniform, uniform] });
  const pot = 600;
  sg.run({ iterations: 10 });
  const e10 = sg.exploitability();
  sg.run({ iterations: 290 });
  const e300 = sg.exploitability();
  assert.ok(e300 < e10, 'more iterations reduce exploitability');
  assert.ok(e300 / pot < 0.02, `exploitability after 300 iterations is ${(100 * e300 / pot).toFixed(2)}% of the pot`);
  const n = sg.nodes[sg.rootNode], s = sg.strategy(sg.rootNode);
  for (let h = 0; h < sg.H; h += 37) {
    let t = 0;
    for (let a = 0; a < n.na; a++) { t += s[a * sg.H + h]; assert.ok(s[a * sg.H + h] >= -1e-6); }
    assert.ok(Math.abs(t - 1) < 1e-3);
  }
});

test('an off-tree bet is added to the tree as an exact option', () => {
  const board = parseCards('2s 7h 8d Tc Kh');
  const uniform = new Float32Array(NUM_HANDS).fill(1);
  const sg = new Subgame(core, {
    board, inv: [300, 300], behind: 2000, minBet: 100, ranges: [uniform, uniform],
    path: [{ player: 1, type: ACT_RAISE, to: 217 }],
  });
  const root = sg.nodes[sg.rootNode];
  assert.ok(root.opts.some((o) => o.type === ACT_RAISE && o.to === 217), 'the exact size exists');
  sg.run({ iterations: 50 });
  const { node } = sg.pathReach();
  assert.equal(sg.nodes[node].player, 0, 'the walk reaches the button facing that bet');
});

test('a turn subgame deals every river and runs', () => {
  const board = parseCards('2s 7h 8d Tc');
  const uniform = new Float32Array(NUM_HANDS).fill(1);
  const sg = new Subgame(core, { board, inv: [300, 300], behind: 2000, minBet: 100, ranges: [uniform, uniform], handFloor: 0 });
  assert.equal(sg.rivers.length, 48);
  assert.equal(sg.H, 1128);
  const t0 = performance.now();
  sg.run({ iterations: 10 });
  const perIter = (performance.now() - t0) / 10;
  const e = sg.exploitability();
  console.log(`full-range turn solve: ${sg.nodes.length} nodes, ${perIter.toFixed(1)} ms/iter, exploitability ${(100 * e / 600).toFixed(1)}% of pot after 10`);
  assert.ok(Number.isFinite(e));
});

test('locked strategies are respected', () => {
  const board = parseCards('2s 7h 8d Tc Kh');
  const uniform = new Float32Array(NUM_HANDS).fill(1);
  const sg = new Subgame(core, { board, inv: [300, 300], behind: 2000, minBet: 100, ranges: [uniform, uniform] });
  const n = sg.nodes[sg.rootNode];
  const pinned = new Float32Array(n.na * sg.H);
  for (let h = 0; h < sg.H; h++) pinned[h] = 1; // always the first action (check)
  sg.lockNode(sg.rootNode, pinned);
  sg.run({ iterations: 30 });
  const s = sg.strategy(sg.rootNode);
  assert.equal(s[0], 1);
  assert.equal(s[sg.H], 0);
});
