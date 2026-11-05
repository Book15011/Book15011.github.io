// How good is a turn solve for a given time budget, with and without the reduced river set?
//
// Exploitability measured on the reduced tree would flatter it, so strategies are judged on the full game:
// the turn strategy from the candidate solve is pinned in a full 48-river tree, river play is solved to near
// convergence given that, and exploitability is then measured there. That isolates the quality of the turn
// decisions, which is all the live turn solve is used for, because the river gets its own solve when it is dealt.
//
// node solver_quality.js <wasm> [budgetsMs]
import { readFileSync } from 'node:fs';
import { parseCards } from '../../poker/js/engine/cards.js';
import { NUM_HANDS, HAND_A, HAND_B } from '../../poker/js/ai/hands.js';
import { loadSolverCore, Subgame } from '../../poker/js/ai/solver.js';
import { preflopStrength } from '../../poker/js/ai/bots.js';

const core = await loadSolverCore(readFileSync(process.argv[2]));
const budgets = (process.argv[3] ?? '250,500,1000,2000').split(',').map(Number);
const strides = (process.argv[4] ?? '1,2,4').split(',').map(Number);

// Smooth, plausible ranges: a calling range against an opening range.
const r0 = new Float32Array(NUM_HANDS), r1 = new Float32Array(NUM_HANDS);
for (let h = 0; h < NUM_HANDS; h++) {
  const s = preflopStrength([HAND_A[h], HAND_B[h]]);
  r0[h] = s > 0.3 ? 1 : 0.01;
  r1[h] = s > 0.2 ? Math.min(1, s * 1.4) : 0.01;
}
const boards = { rainbow: 'Ks 7h 2d 9c', 'two-tone': 'Jh 8h 3c 5d', paired: '9d 9s 4c Kh', connected: 'Tc 9d 8s 6h' };
const pot = 600;
const problem = (board, stride) => ({ board: parseCards(board), inv: [300, 300], behind: 1700, minBet: 100, ranges: [r0, r1], riverStride: stride });

/** All decisions on the turn, keyed by the betting line. Stops at chance nodes. */
function turnStrategies(sg) {
  const out = new Map();
  const visit = (idx, key) => {
    const n = sg.nodes[idx];
    if (n.type !== 0) return;
    out.set(key, sg.strategy(idx));
    n.opts.forEach((o, a) => visit(sg.kids[n.first + a], `${key}/${o.type}:${o.to}`));
  };
  visit(sg.rootNode, '');
  return out;
}

/** Pin those decisions in a full tree, solve the rivers, and return exploitability as a percentage of the pot. */
function judge(board, strategies) {
  const sg = new Subgame(core, problem(board, 1));
  const visit = (idx, key) => {
    const n = sg.nodes[idx];
    if (n.type !== 0) return;
    const s = strategies.get(key);
    if (!s) throw new Error(`missing ${key}`);
    sg.lockNode(idx, s);
    n.opts.forEach((o, a) => visit(sg.kids[n.first + a], `${key}/${o.type}:${o.to}`));
  };
  visit(sg.rootNode, '');
  sg.run({ iterations: 60 });
  return (sg.exploitability() / pot) * 100;
}

console.log('board       stride  nodes  ms/iter |  ' + budgets.map((b) => `${b}ms`.padStart(14)).join(' '));
for (const [name, board] of Object.entries(boards)) {
  for (const stride of strides) {
    const cells = [];
    let nodes = 0, msIter = 0, h = 0;
    for (const budget of budgets) {
      const sg = new Subgame(core, problem(board, stride));
      sg.run({ budgetMs: budget, minIterations: 1 });
      nodes = sg.nodes.length; msIter = budget / sg.iterations; h = sg.H;
      const its = sg.iterations;
      const strategies = turnStrategies(sg);
      cells.push(`${judge(board, strategies).toFixed(2).padStart(6)}% (${String(its).padStart(3)}it)`);
    }
    console.log(`${name.padEnd(11)} ${String(stride).padStart(4)} ${String(nodes).padStart(7)} ${msIter.toFixed(1).padStart(8)} |  ${cells.join(' ')}   H=${h}`);
  }
}
