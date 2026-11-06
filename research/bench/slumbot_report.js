// Summarises Slumbot match logs. Reports the raw result and an all-in adjusted one: when both players are all-in
// before the river, the hand is scored at its expected value over the remaining cards instead of the actual
// runout (the variance reduction used in the Supremus paper). Both use exactly the same hands.
//
// node slumbot_report.js <out.json> <log.jsonl> [...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCards } from '../../poker/js/engine/cards.js';
import { evaluate } from '../../poker/js/engine/evaluator.js';

const [out, ...files] = process.argv.slice(2);
const STACK = 20000;

/** Each street's actions, and the street on which both players were all-in (or -1). */
function allInStreet(action) {
  const streets = action.split('/');
  let total = [0, 0];
  for (let s = 0; s < streets.length; s++) {
    const str = streets[s];
    let i = 0, bets = [0, 0];
    if (s === 0) bets = [50, 100];
    let cur = s === 0 ? 100 : 0;
    const order = s === 0 ? [0, 1] : [1, 0]; // first actor preflop is the small blind
    let k = 0;
    while (i < str.length) {
      const p = order[k % 2];
      const c = str[i++];
      if (c === 'b') {
        let num = '';
        while (i < str.length && /[0-9]/.test(str[i])) num += str[i++];
        bets[p] = Number(num); cur = bets[p];
      } else if (c === 'c') bets[p] = cur;
      k++;
    }
    total = [total[0] + bets[0], total[1] + bets[1]];

    if (total[0] >= STACK && total[1] >= STACK) return s;
  }
  return -1;
}

function equity(mine, theirs, board) {
  const known = new Set([...mine, ...theirs, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const need = 5 - board.length;
  let win = 0, n = 0;
  const rec = (start, picked) => {
    if (picked.length === need) {
      const b = [...board, ...picked];
      const a = evaluate([...mine, ...b]), o = evaluate([...theirs, ...b]);
      win += a > o ? 1 : a === o ? 0.5 : 0;
      n++;
      return;
    }
    for (let i = start; i < deck.length; i++) rec(i + 1, [...picked, deck[i]]);
  };
  rec(0, []);
  return win / n;
}

const raw = [], adj = [];
let adjusted = 0;
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
    if (!line.startsWith('{')) continue;
    const r = JSON.parse(line);
    raw.push(r.winnings);
    const s = allInStreet(r.action);
    if (s >= 0 && s < 3 && r.bot && r.bot.length === 2) {
      const boardAtAllIn = (r.board ?? []).slice(0, [0, 3, 4][s]);
      const eq = equity(parseCards(r.hole.join('')), parseCards(r.bot.join('')), parseCards(boardAtAllIn.join('')));
      adj.push(STACK * (2 * eq - 1));
      adjusted++;
    } else {
      adj.push(r.winnings);
    }
  }
}
const summary = (xs) => {
  const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(Math.max(0, xs.reduce((a, b) => a + b * b, 0) / n - mean * mean));
  return { hands: n, bb100: mean, ci95: (1.96 * sd) / Math.sqrt(n) };
};
const result = { raw: summary(raw), allInAdjusted: summary(adj), handsAdjusted: adjusted };
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
