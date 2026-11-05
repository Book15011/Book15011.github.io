// Local Best Response (Lisy & Bowling 2017): a lower bound on how exploitable an agent is.
//
// LBR is told the agent's strategy, so it knows the agent's range and how often it folds to each bet. At each
// decision it picks the action with the best value, assuming the hand checks down afterwards.
//
// fromStreet sets where LBR starts responding. Before that it calls everything.
//   2 = calls through preflop and flop, responds on turn and river (the setting in the ReBeL table)
//   1 = calls preflop only, responds from the flop onward
//   0 = responds from the first decision (the hardest test here, and the fair one at short stacks,
//       where calling every preflop shove would cost LBR far more than it could ever win back)
// It may bet only the sizes in the agent's tree, so it costs no extra solves.
//
// node lbr.js <mode:expert|blueprint> <bpDir> <dataDir> <depth> <stackBB> <hands> <turnIters> <riverIters> <seed> <fromStreet>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HandState } from '../../poker/js/engine/game.js';
import { seededRng, shuffledDeck } from '../../poker/js/engine/cards.js';
import { ExpertBot } from '../../poker/js/ai/expert.js';
import { RealtimeSolver, equityVsRange } from '../../poker/js/ai/realtime.js';
import { monteCarloEquity } from '../../poker/js/ai/bots.js';
import { loadSolverCore, ACT_FOLD, ACT_RAISE } from '../../poker/js/ai/solver.js';
import { NUM_HANDS, HAND_A, HAND_B, pairIdx } from '../../poker/js/ai/hands.js';
import { A_FOLD } from '../../poker/js/ai/blueprint.js';
import { loadBlueprint, loadBuckets } from './node_models.js';

const [mode, bpDir, dataDir, depthArg, stackArg, handsArg, turnArg, riverArg, seedArg, fromArg] = process.argv.slice(2);
const fromStreet = Number(fromArg ?? 2);
const depth = Number(depthArg), stackBB = Number(stackArg), hands = Number(handsArg), seed = Number(seedArg || 1);
const BB = 100;
const core = await loadSolverCore(readFileSync(fileURLToPath(new URL('../../poker/js/ai/solver.wasm', import.meta.url))));
const isExpert = mode === 'expert';
const bp = loadBlueprint(`${bpDir}/bp_${depth}${isExpert ? '' : '_full'}.bin`);
const buckets = loadBuckets(dataDir, isExpert ? 1 : 3);
const agent = new ExpertBot({
  name: mode, blueprintFor: () => bp, bucketsFor: buckets, rng: seededRng(seed * 3 + 1),
  solver: isExpert ? new RealtimeSolver(core, { turn: { iterations: Number(turnArg) }, river: { iterations: Number(riverArg) }, riverStride: 4 }) : null,
});

/** The agent's range and its fold probability after each candidate bet at the current state. */
function optionsFromExpert(agentObs, lbrHole) {
  const w = agent.syncTo(agentObs);
  const ready = agent.solver.prepare(agentObs, w, pairIdx(agentObs.hole[0], agentObs.hole[1]));
  if (!ready) return null;
  const { sg } = ready;
  const { reach, node } = sg.pathReach();
  const n = sg.nodes[node];
  if (n.type !== 0) return null;
  const agentTree = n.player === 0 ? 1 : 0;
  const range = new Float32Array(NUM_HANDS);
  for (let i = 0; i < sg.H; i++) range[sg.handList[i]] = reach[agentTree][i];
  const opts = [];
  n.opts.forEach((o, a) => {
    if (o.type !== ACT_RAISE) return;
    const child = sg.kids[n.first + a];
    const c = sg.nodes[child];
    const fi = c.opts ? c.opts.findIndex((x) => x.type === ACT_FOLD) : -1;
    let fold = 0, tot = 0;
    if (fi >= 0) {
      const s = sg.strategy(child);
      for (let i = 0; i < sg.H; i++) {
        const h = sg.handList[i];
        if (HAND_A[h] === lbrHole[0] || HAND_B[h] === lbrHole[0] || HAND_A[h] === lbrHole[1] || HAND_B[h] === lbrHole[1]) continue;
        tot += reach[agentTree][i];
        fold += reach[agentTree][i] * s[fi * sg.H + i];
      }
    }
    opts.push({ to: o.to, fold: tot > 0 ? fold / tot : 0 });
  });
  return { range, opts };
}

function optionsFromBlueprint(agentObs, lbrHole, lbrObs) {
  const w = agent.syncTo(agentObs);
  if (w.offTree || w.leaf || w.bp.type[w.node] !== 0) return null;
  w.syncBuckets();
  if (w.offTree) return null;
  const me = agentObs.seat === agentObs.button ? 0 : 1;
  const range = w.reach[me].slice();
  const b = w.bp;
  const opts = [];
  const l = lbrObs.legal;
  const cur = Math.max(lbrObs.bets[0], lbrObs.bets[1]);
  for (const r of b.raiseFractions(w.node)) {
    const child = r.child;
    let fold = 0, tot = 0;
    if (child >= 0 && b.type[child] === 0) {
      const f = b.first[child];
      let fi = -1;
      for (let a = 0; a < b.na[child]; a++) if (b.actionType[f + a] === A_FOLD) fi = a;
      if (fi >= 0) {
        for (let h = 0; h < NUM_HANDS; h++) {
          if (range[h] <= 0 || w.bucket[h] < 0) continue;
          if (HAND_A[h] === lbrHole[0] || HAND_B[h] === lbrHole[0] || HAND_A[h] === lbrHole[1] || HAND_B[h] === lbrHole[1]) continue;
          tot += range[h];
          fold += range[h] * b.prob(child, w.bucket[h], fi);
        }
      }
    }
    const to = Math.round(cur + r.frac * (lbrObs.pot + l.callAmount));
    opts.push({ to: Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, to)), fold: tot > 0 ? fold / tot : 0 });
  }
  return { range, opts };
}

function lbrAct(obs, agentObs) {
  const l = obs.legal;
  const passive = l.canCheck ? { type: 'check' } : { type: 'call' };
  if (obs.street < fromStreet) return passive;
  // The Expert's flop comes from its table, the same as the blueprint-only bot's. Later streets come from its solver.
  const view = isExpert && obs.street >= 2 ? optionsFromExpert(agentObs, obs.hole) : optionsFromBlueprint(agentObs, obs.hole, obs);
  if (!view) return passive;
  const hand = pairIdx(obs.hole[0], obs.hole[1]);
  // Exact on the turn and river. Earlier streets have too many runouts to enumerate per decision.
  const wp = obs.board.length >= 4
    ? equityVsRange(hand, obs.board, view.range)
    : monteCarloEquity(obs.hole, obs.board, 1500, equityRng, (a, b) => view.range[pairIdx(a, b)]);
  const pot = obs.pot, owe = l.callAmount;
  const myBet = obs.bets[obs.seat], oppBet = obs.bets[1 - obs.seat];
  const uCall = wp * pot - (1 - wp) * owe;
  let best = l.canCheck ? { type: 'check' } : (uCall >= 0 ? { type: 'call' } : { type: 'fold' });
  let bestU = l.canCheck ? wp * pot : Math.max(uCall, 0);
  if (l.canRaise) {
    for (const o of view.opts) {
      if (o.to < l.minRaiseTo || o.to > l.maxRaiseTo) continue;
      const x = o.to - myBet, y = o.to - oppBet;
      const u = o.fold * pot + (1 - o.fold) * (wp * (pot + y) - (1 - wp) * x);
      if (u > bestU) { bestU = u; best = { type: 'raise', to: o.to }; }
    }
  }
  return best;
}

const deckRng = seededRng(seed + 1000);
const equityRng = seededRng(seed + 2000);
let sum = 0, sq = 0, n = 0;
const t0 = Date.now();
for (let i = 0; i < hands; i++) {
  const lbrSeat = i % 2; // LBR alternates between button and big blind on a fresh deck each hand
  const button = (i >> 1) % 2;
  const stack = stackBB * BB;
  const hand = new HandState({ stacks: [stack, stack], smallBlind: BB / 2, bigBlind: BB, button, deck: shuffledDeck(deckRng.int) });
  agent.onHandStart(hand.observation(1 - lbrSeat));
  let guard = 0;
  while (!hand.finished) {
    if (++guard > 300) throw new Error('hand did not terminate');
    const s = hand.toAct;
    if (s === lbrSeat) hand.apply(lbrAct(hand.observation(s), hand.observation(1 - lbrSeat)));
    else hand.apply(agent.act(hand.observation(s)));
  }
  const net = hand.result.net[lbrSeat];
  sum += net; sq += net * net; n++;
  if (n % 500 === 0) {
    const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean);
    console.error(`${n} hands: LBR ${((mean / BB) * 1000).toFixed(0)} +- ${((1.96 * sd / Math.sqrt(n) / BB) * 1000).toFixed(0)} mbb/hand, ${(n / ((Date.now() - t0) / 1000)).toFixed(1)} hands/s`);
  }
}
const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean);
console.log(JSON.stringify({ mode, fromStreet, depth, stackBB, hands: n, lbrMbb: (mean / BB) * 1000, ci95: (1.96 * sd / Math.sqrt(n) / BB) * 1000, seconds: (Date.now() - t0) / 1000, seed }));
