// Sanity check for a full blueprint export: print a few preflop strategies, then play it against baselines.
// node blueprint_check.js <blueprint.bin> <dataDir> <stackBB> <pairs>
import { RandomBot, TightPassiveBot, LooseAggressiveBot, EquityBot, StrongHeuristicBot, CasualBot, CallStationBot } from '../../poker/js/ai/bots.js';
import { ExpertBot } from '../../poker/js/ai/expert.js';
import { PRE169, pairIdx } from '../../poker/js/ai/hands.js';
import { parseCards, seededRng } from '../../poker/js/engine/cards.js';
import { loadBlueprint, loadBuckets } from './node_models.js';
import { runMatch } from './arena.js';

const [bpPath, dataDir, stackArg, pairsArg] = process.argv.slice(2);
const stackBB = Number(stackArg || 20), pairs = Number(pairsArg || 3000);
const bp = loadBlueprint(bpPath);
const bucketsFor = loadBuckets(dataDir, 3);
console.log(`blueprint depth=${bp.depthBB}bb buckets=${bp.buckets} decision nodes=${bp.type.filter((x) => x === 0).length}`);

const names = ['fold', 'check', 'call', 'raise'];
const f = bp.first[0];
const labels = [];
for (let a = 0; a < bp.na[0]; a++) labels.push(bp.actionType[f + a] === 3 ? `r${bp.actionTo[f + a]}` : names[bp.actionType[f + a]]);
console.log(`button first action: ${labels.join('  ')}`);
for (const h of ['As Ad', 'Ks Kd', 'Ah Kh', 'Jc Td', '7c 2d', '5h 4h', '9s 9d', 'Qh 3c', 'Ac 5d']) {
  const [x, y] = parseCards(h);
  const b = PRE169[pairIdx(x, y)];
  const p = [];
  for (let a = 0; a < bp.na[0]; a++) p.push(bp.prob(0, b, a).toFixed(2));
  console.log(`  ${h}: ${p.join('  ')}`);
}

const bot = (seed) => new ExpertBot({ name: 'Blueprint', blueprintFor: () => bp, bucketsFor, rng: seededRng(seed) });
const opponents = {
  Random: (s) => new RandomBot(seededRng(s)),
  CallStation: () => new CallStationBot(),
  Casual: (s) => new CasualBot(seededRng(s)),
  TightPassive: (s) => new TightPassiveBot(seededRng(s)),
  LAG: (s) => new LooseAggressiveBot(seededRng(s)),
  Equity: (s) => new EquityBot(seededRng(s), 200),
  Strong: (s) => new StrongHeuristicBot(seededRng(s), 200),
};
let i = 0;
for (const [name, mk] of Object.entries(opponents)) {
  const t0 = Date.now();
  const r = await runMatch(() => bot(100 + i), () => mk(200 + i), { pairs, seed: 9000 + i, stackBB });
  console.log(`vs ${name.padEnd(13)} ${r.bb100.toFixed(1).padStart(8)} +- ${r.ci95.toFixed(1).padStart(6)} bb/100 | button ${r.asButton.toFixed(0)} bb ${r.asBigBlind.toFixed(0)} | ${(r.hands / ((Date.now() - t0) / 1000)).toFixed(0)} hands/s`);
  i++;
}
// A mirror match must come out at about zero, with no seat or code asymmetry.
const mirror = await runMatch(() => bot(1), () => bot(2), { pairs, seed: 77, stackBB });
console.log(`mirror match: ${mirror.bb100.toFixed(1)} +- ${mirror.ci95.toFixed(1)} bb/100 (should include 0)`);
