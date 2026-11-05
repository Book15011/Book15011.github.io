// One benchmark job. Every bot here is the same code the browser runs.
//
//   node expert_check.js <bpDir> <dataDir> <a> <b> <format> <count> <seed> [turnIters] [riverIters]
//
// a, b:   expert | blueprint | random | station | casual | tight | lag | equity | strong | maniac | minraiser | shover
// format: a stack depth in big blinds (duplicate hands, count = pairs of hands), or "quick" (count = matches)
//
// blueprint means the trained tables on every street with no live solving. It needs bp_<d>_full.bin.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RandomBot, TightPassiveBot, LooseAggressiveBot, EquityBot, StrongHeuristicBot, CasualBot, CallStationBot, potRaise, raiseTo } from '../../poker/js/ai/bots.js';
import { ExpertBot, nearestDepth } from '../../poker/js/ai/expert.js';
import { RealtimeSolver } from '../../poker/js/ai/realtime.js';
import { loadSolverCore } from '../../poker/js/ai/solver.js';
import { seededRng } from '../../poker/js/engine/cards.js';
import { loadBlueprint, loadBuckets } from './node_models.js';
import { runMatch, runQuickMatches } from './arena.js';

const [bpDir, dataDir, nameA, nameB, format, countArg, seedArg, turnArg, riverArg] = process.argv.slice(2);
const count = Number(countArg), seed = Number(seedArg || 1);
const turnIters = Number(turnArg || 30), riverIters = Number(riverArg || 200);
const wasm = readFileSync(fileURLToPath(new URL('../../poker/js/ai/solver.wasm', import.meta.url)));

const files = readdirSync(bpDir);
const lightDepths = files.filter((f) => /^bp_\d+\.bin$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const fullDepths = files.filter((f) => /^bp_\d+_full\.bin$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const needFull = nameA === 'blueprint' || nameB === 'blueprint';
const light = new Map(lightDepths.map((d) => [d, loadBlueprint(`${bpDir}/bp_${d}.bin`)]));
const full = needFull ? new Map(fullDepths.map((d) => [d, loadBlueprint(`${bpDir}/bp_${d}_full.bin`)])) : new Map();
const buckets = loadBuckets(dataDir, needFull ? 3 : 1);

/** Bets the pot on every street it can, whatever it holds. */
class ManiacBot {
  name = 'Maniac';
  act(obs) { return obs.legal.canRaise ? potRaise(obs, 1) : (obs.legal.canCheck ? { type: 'check' } : { type: 'call' }); }
}
/** Stress test for bet-size translation: tiny raises whenever it has any equity signal, chosen at random. */
class MinRaiserBot {
  name = 'Min-raiser';
  constructor(rng) { this.rng = rng; }
  act(obs) {
    const l = obs.legal;
    if (l.canRaise && this.rng.next() < 0.45) return raiseTo(obs, l.minRaiseTo);
    return l.canCheck ? { type: 'check' } : (this.rng.next() < 0.75 ? { type: 'call' } : { type: 'fold' });
  }
}
/** Moves all-in with a random 40% of hands and folds the rest. */
class ShoverBot {
  name = 'Shover';
  constructor(rng) { this.rng = rng; }
  act(obs) {
    const l = obs.legal;
    if (this.rng.next() < 0.4 && l.canRaise) return raiseTo(obs, l.maxRaiseTo);
    return l.canCheck ? { type: 'check' } : { type: 'fold' };
  }
}

const expert = async (s) => new ExpertBot({
  name: 'Expert',
  blueprintFor: (bb) => light.get(nearestDepth(lightDepths, bb)),
  bucketsFor: buckets,
  rng: seededRng(s * 7 + 1),
  solver: new RealtimeSolver(await loadSolverCore(wasm), { turn: { iterations: turnIters }, river: { iterations: riverIters }, riverStride: 4 }),
});
const makers = {
  expert,
  blueprint: async (s) => new ExpertBot({ name: 'Blueprint only', blueprintFor: (bb) => full.get(nearestDepth(fullDepths, bb)), bucketsFor: buckets, rng: seededRng(s * 11 + 3) }),
  random: async (s) => new RandomBot(seededRng(s + 5)),
  station: async () => new CallStationBot(),
  casual: async (s) => new CasualBot(seededRng(s + 6)),
  tight: async (s) => new TightPassiveBot(seededRng(s + 7)),
  lag: async (s) => new LooseAggressiveBot(seededRng(s + 8)),
  equity: async (s) => new EquityBot(seededRng(s + 9), 300),
  strong: async (s) => new StrongHeuristicBot(seededRng(s + 10), 300),
  maniac: async () => new ManiacBot(),
  minraiser: async (s) => new MinRaiserBot(seededRng(s + 12)),
  shover: async (s) => new ShoverBot(seededRng(s + 13)),
};
const a = await makers[nameA](seed), b = await makers[nameB](seed + 100);
const t0 = Date.now();
const r = format === 'quick'
  ? await runQuickMatches(() => a, () => b, { matches: count, seed: 5000 + seed })
  : await runMatch(() => a, () => b, { pairs: count, seed: 1000 + seed, stackBB: Number(format) });
console.log(JSON.stringify({ ...r, nameA, nameB, format, turnIters, riverIters, seconds: (Date.now() - t0) / 1000 }));
