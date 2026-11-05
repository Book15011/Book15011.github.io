// Round robin of the hand-written bots, to confirm they form a sensible ladder before any training.
import { RandomBot, TightPassiveBot, LooseAggressiveBot, EquityBot, StrongHeuristicBot, CasualBot, CallStationBot } from '../../poker/js/ai/bots.js';
import { seededRng } from '../../poker/js/engine/cards.js';
import { runMatch } from './arena.js';

const pairs = Number(process.argv[2] || 2000);
const stackBB = Number(process.argv[3] || 100);
const makers = {
  Random: (s) => new RandomBot(seededRng(s)),
  CallStation: () => new CallStationBot(),
  Casual: (s) => new CasualBot(seededRng(s)),
  TightPassive: (s) => new TightPassiveBot(seededRng(s)),
  LAG: (s) => new LooseAggressiveBot(seededRng(s)),
  Equity: (s) => new EquityBot(seededRng(s), 200),
  Strong: (s) => new StrongHeuristicBot(seededRng(s), 200),
};
const names = Object.keys(makers);
console.log(`stack ${stackBB}bb, ${pairs * 2} hands per match. Row's win rate against column, in bb/100 (+-95% CI).`);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const r = await runMatch(() => makers[names[i]](11 + i), () => makers[names[j]](77 + j), { pairs, seed: 5000 + i * 100 + j, stackBB });
    console.log(`${names[i].padEnd(13)} vs ${names[j].padEnd(13)} ${r.bb100.toFixed(1).padStart(8)} +- ${r.ci95.toFixed(1)}`);
  }
}
