// Plays the Expert bot against Slumbot through its public API (https://slumbot.com), a fully independent
// opponent: winner of the 2018 Annual Computer Poker Competition. Blinds 50/100, stacks reset to 20,000 (200bb).
//
//   node slumbot.js <bpDir> <dataDir> <hands> <turnIters> <riverIters> <outFile> [seed]
//
// Requests are made one at a time. Slumbot never sees anything except our actions.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HandState } from '../../poker/js/engine/game.js';
import { parseCards, seededRng } from '../../poker/js/engine/cards.js';
import { ExpertBot, nearestDepth } from '../../poker/js/ai/expert.js';
import { RealtimeSolver } from '../../poker/js/ai/realtime.js';
import { loadSolverCore } from '../../poker/js/ai/solver.js';
import { loadBlueprint, loadBuckets } from './node_models.js';

const [bpDir, dataDir, handsArg, turnArg, riverArg, outFile, seedArg] = process.argv.slice(2);
const HOST = 'https://slumbot.com/slumbot/api';
const SB = 50, BB = 100, STACK = 20000;
const seed = Number(seedArg || 1);

const core = await loadSolverCore(readFileSync(fileURLToPath(new URL('../../poker/js/ai/solver.wasm', import.meta.url))));
const depths = [100, 200].filter((d) => existsSync(`${bpDir}/bp_${d}.bin`));
const blueprints = new Map(depths.map((d) => [d, loadBlueprint(`${bpDir}/bp_${d}.bin`)]));
const buckets = loadBuckets(dataDir, 1);
const bot = new ExpertBot({
  name: 'Expert',
  blueprintFor: (bb) => blueprints.get(nearestDepth(depths, bb)),
  bucketsFor: buckets,
  rng: seededRng(seed),
  solver: new RealtimeSolver(core, { turn: { iterations: Number(turnArg) }, river: { iterations: Number(riverArg) } }),
});

async function post(path, body, attempt = 0) {
  try {
    const res = await fetch(`${HOST}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error_msg) throw new Error(j.error_msg);
    return j;
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return post(path, body, attempt + 1);
  }
}

/** Turn "b200c/kb400" into per-street action lists. */
function parseActions(s) {
  const out = [];
  const streets = s.split('/');
  streets.forEach((str, street) => {
    let i = 0;
    while (i < str.length) {
      const c = str[i++];
      if (c === 'b') {
        let num = '';
        while (i < str.length && /[0-9]/.test(str[i])) num += str[i++];
        out.push({ street, type: 'raise', to: Number(num) });
      } else if (c === 'k') out.push({ street, type: 'check' });
      else if (c === 'c') out.push({ street, type: 'call' });
      else if (c === 'f') out.push({ street, type: 'fold' });
      else throw new Error(`Unknown action char ${c} in ${s}`);
    }
  });
  return out;
}

/** Rebuild the hand in our rules engine from what we know, then read the observation. Opposing cards are filler. */
function observationFrom(state) {
  const hole = parseCards(state.hole_cards.join(''));
  const board = parseCards((state.board ?? []).join(''));
  const mySeat = 0;
  const button = state.client_pos === 1 ? mySeat : 1; // client_pos 1 = we are the small blind (button)
  const known = new Set([...hole, ...board]);
  const filler = [];
  for (let c = 51; c >= 0; c--) if (!known.has(c)) filler.push(c);
  const f = () => filler.shift();
  // Deal order: d[0], d[2] to the non-button player, d[1], d[3] to the button.
  const opp = [f(), f()];
  const nonBtn = button === mySeat ? opp : hole;
  const btn = button === mySeat ? hole : opp;
  const b = [...board];
  while (b.length < 5) b.push(f());
  const deck = [nonBtn[0], btn[0], nonBtn[1], btn[1], f(), b[0], b[1], b[2], f(), b[3], f(), b[4], ...filler];
  const hand = new HandState({ stacks: [STACK, STACK], smallBlind: SB, bigBlind: BB, button, deck });
  for (const a of parseActions(state.action)) hand.apply(a);
  return { hand, obs: hand.observation(mySeat) };
}

const totalHands = Number(handsArg);
let token, played = 0, sum = 0, sq = 0;
if (existsSync(outFile)) { // resume a partly finished run
  for (const line of readFileSync(outFile, 'utf8').trim().split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    played++; sum += r.winnings; sq += r.winnings * r.winnings;
  }
}

while (played < totalHands) {
  let state = await post('new_hand', token ? { token } : {});
  token = state.token ?? token;
  let started = false, guard = 0;
  while (state.winnings === undefined || state.winnings === null) {
    if (++guard > 40) throw new Error(`Hand did not finish: ${JSON.stringify(state)}`);
    const { hand, obs } = observationFrom(state);
    if (!started) {
      const blindObs = { ...obs, history: obs.history.filter((h) => h.type === 'small_blind' || h.type === 'big_blind') };
      bot.onHandStart(blindObs);
      started = true;
    }
    if (hand.finished || hand.toAct !== 0) throw new Error(`Not our turn: ${JSON.stringify(state)}`);
    const a = bot.act(obs);
    const incr = a.type === 'fold' ? 'f' : a.type === 'check' ? 'k' : a.type === 'call' ? 'c' : `b${a.to}`;
    state = await post('act', { token, incr });
    token = state.token ?? token;
  }
  played++;
  sum += state.winnings; sq += state.winnings * state.winnings;
  appendFileSync(outFile, `${JSON.stringify({ n: played, winnings: state.winnings, pos: state.client_pos, action: state.action, board: state.board, hole: state.hole_cards, bot: state.bot_hole_cards })}\n`);
  if (played % 100 === 0) {
    const mean = sum / played, sd = Math.sqrt(Math.max(0, sq / played - mean * mean));
    console.log(`${played} hands: ${((mean / BB) * 1000).toFixed(0)} mbb/hand +- ${((1.96 * sd / Math.sqrt(played) / BB) * 1000).toFixed(0)} (95%)`);
  }
}
const mean = sum / played, sd = Math.sqrt(Math.max(0, sq / played - mean * mean));
console.log(JSON.stringify({ hands: played, mbbPerHand: (mean / BB) * 1000, ci95: (1.96 * sd / Math.sqrt(played) / BB) * 1000 }));
