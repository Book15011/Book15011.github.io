// How often does each bot bet or raise on each street, and how much does it win? Used to check whether
// short live solves leave the Expert over-aggressive (an under-converged average strategy keeps some of
// the uniform starting strategy, and most of the actions in a tree are bets and raises).
//
//   node turn_profile.js <bpDir> <dataDir> <depthBB> <pairs> <seed> <turnIters> <riverIters> [purifyBelow]
//
// The Expert plays the blueprint alone (trained tables on every street) with duplicate deals.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExpertBot, nearestDepth } from '../../poker/js/ai/expert.js';
import { RealtimeSolver } from '../../poker/js/ai/realtime.js';
import { loadSolverCore } from '../../poker/js/ai/solver.js';
import { seededRng } from '../../poker/js/engine/cards.js';
import { loadBlueprint, loadBuckets } from './node_models.js';
import { runMatch } from './arena.js';

const [bpDir, dataDir, depthArg, pairsArg, seedArg, turnArg, riverArg, purifyArg] = process.argv.slice(2);
const depth = Number(depthArg), pairs = Number(pairsArg), seed = Number(seedArg);
const turnIters = Number(turnArg), riverIters = Number(riverArg), purifyBelow = Number(purifyArg ?? 0.02);
const wasm = readFileSync(fileURLToPath(new URL('../../poker/js/ai/solver.wasm', import.meta.url)));
const files = readdirSync(bpDir);
const depths = (re) => files.filter((f) => re.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const lightDepths = depths(/^bp_\d+\.bin$/), fullDepths = depths(/^bp_\d+_full\.bin$/);
const light = new Map([[nearestDepth(lightDepths, depth), loadBlueprint(`${bpDir}/bp_${nearestDepth(lightDepths, depth)}.bin`)]]);
const full = new Map([[nearestDepth(fullDepths, depth), loadBlueprint(`${bpDir}/bp_${nearestDepth(fullDepths, depth)}_full.bin`)]]);
const buckets = loadBuckets(dataDir, 3);

/** Counts each action by street. @param {any} bot */
function profiled(bot) {
  const stats = [0, 1, 2, 3].map(() => ({ n: 0, aggr: 0, allIn: 0 }));
  const inner = bot.act.bind(bot);
  bot.act = async (obs) => {
    const a = await inner(obs);
    const s = stats[{ 0: 0, 3: 1, 4: 2, 5: 3 }[obs.board.length]];
    s.n++;
    if (a.type === 'raise') { s.aggr++; if (a.to >= obs.legal.maxRaiseTo) s.allIn++; }
    return a;
  };
  bot.stats = stats;
  return bot;
}

const expert = profiled(new ExpertBot({
  name: 'Expert',
  blueprintFor: (bb) => light.get(nearestDepth([...light.keys()], bb)),
  bucketsFor: buckets,
  rng: seededRng(seed * 7 + 1),
  solver: new RealtimeSolver(await loadSolverCore(wasm), { turn: { iterations: turnIters }, river: { iterations: riverIters }, riverStride: 4, purifyBelow }),
}));
const bp = profiled(new ExpertBot({ name: 'Blueprint only', blueprintFor: (bb) => full.get(nearestDepth([...full.keys()], bb)), bucketsFor: buckets, rng: seededRng(seed * 11 + 3) }));
const t0 = Date.now();
const r = await runMatch(() => expert, () => bp, { pairs, seed: 1000 + seed, stackBB: depth });
const fmt = (st) => st.map((s) => ({ n: s.n, aggr: +(s.aggr / Math.max(1, s.n)).toFixed(3), allIn: +(s.allIn / Math.max(1, s.n)).toFixed(3) }));
console.log(JSON.stringify({ depth, pairs, seed, turnIters, riverIters, purifyBelow, bb100: r.bb100, ci95: r.ci95, hands: r.hands, expert: fmt(expert.stats), blueprint: fmt(bp.stats), seconds: (Date.now() - t0) / 1000 }));
