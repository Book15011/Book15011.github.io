// One benchmark match for the Expert bot (blueprint + real-time solver) against a named opponent.
// node expert_check.js <bpDir> <dataDir> <depth> <stackBB> <opponent> <pairs> <turnIters> <riverIters> <seed>
//
// Opponents: blueprint | random | station | casual | tight | lag | equity | strong
// bpDir holds bp_<depth>.bin (preflop and flop only) and bp_<depth>_full.bin (all streets).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RandomBot, TightPassiveBot, LooseAggressiveBot, EquityBot, StrongHeuristicBot, CasualBot, CallStationBot } from '../../poker/js/ai/bots.js';
import { ExpertBot } from '../../poker/js/ai/expert.js';
import { RealtimeSolver } from '../../poker/js/ai/realtime.js';
import { loadSolverCore } from '../../poker/js/ai/solver.js';
import { seededRng } from '../../poker/js/engine/cards.js';
import { loadBlueprint, loadBuckets } from './node_models.js';
import { runMatch } from './arena.js';

const [bpDir, dataDir, depthArg, stackArg, oppName, pairsArg, turnArg, riverArg, seedArg] = process.argv.slice(2);
const depth = Number(depthArg), stackBB = Number(stackArg), pairs = Number(pairsArg), seed = Number(seedArg || 1);
const turnIters = Number(turnArg), riverIters = Number(riverArg);

const wasm = readFileSync(fileURLToPath(new URL('../../poker/js/ai/solver.wasm', import.meta.url)));
const core = await loadSolverCore(wasm);
const light = loadBlueprint(`${bpDir}/bp_${depth}${process.env.LIGHT_SUFFIX ?? ''}.bin`);
const full = oppName === 'blueprint' ? loadBlueprint(`${bpDir}/bp_${depth}_full.bin`) : null;
const buckets = loadBuckets(dataDir, full ? 3 : 1);

const expert = () => new ExpertBot({
  name: 'Expert',
  blueprintFor: () => light,
  bucketsFor: buckets,
  rng: seededRng(seed * 7 + 1),
  solver: new RealtimeSolver(core, { turn: { iterations: turnIters }, river: { iterations: riverIters } }),
});
const opponents = {
  blueprint: () => new ExpertBot({ name: 'Blueprint only', blueprintFor: () => full, bucketsFor: buckets, rng: seededRng(seed * 11 + 3) }),
  random: () => new RandomBot(seededRng(seed + 5)),
  station: () => new CallStationBot(),
  casual: () => new CasualBot(seededRng(seed + 6)),
  tight: () => new TightPassiveBot(seededRng(seed + 7)),
  lag: () => new LooseAggressiveBot(seededRng(seed + 8)),
  equity: () => new EquityBot(seededRng(seed + 9), 300),
  strong: () => new StrongHeuristicBot(seededRng(seed + 10), 300),
};
const t0 = Date.now();
const r = await runMatch(expert, opponents[oppName], { pairs, seed: 1000 + seed, stackBB });
console.log(JSON.stringify({ ...r, depth, turnIters, riverIters, seconds: (Date.now() - t0) / 1000 }));
