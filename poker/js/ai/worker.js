// @ts-check
/**
 * The AI runs here, in a Web Worker, so solving never blocks the page. The page holds the game engine and
 * sends only the AI's player observation, so the worker has no way to see the deck or the human's cards.
 */
import { CasualBot, StrongHeuristicBot } from './bots.js';
import { ExpertBot } from './expert.js';
import { ModelStore } from './models.js';
import { RealtimeSolver } from './realtime.js';
import { secureRandomInt } from '../engine/cards.js';

const rng = { next: () => secureRandomInt(0x40000000) / 0x40000000, int: secureRandomInt };
const store = new ModelStore();
/** @type {any} */
let bot = null;
let difficulty = 'expert';

/** @param {string} level */
async function init(level) {
  difficulty = level;
  if (level === 'casual') { bot = new CasualBot(rng); return; }
  if (level === 'competitive') { bot = new StrongHeuristicBot(rng); return; }
  await store.loadShared();
  bot = new ExpertBot({
    name: 'Expert',
    blueprintFor: (bb) => store.blueprintFor(bb),
    bucketsFor: (s, b, o) => store.bucketsFor(s, b, o),
    rng,
    analysis: true,
    solver: new RealtimeSolver(store.core, {
      // While the player decides, the solve keeps going up to ponderIterations (see ponder below).
      turn: { budgetMs: 1500, minIterations: 8, iterations: 80, ponderIterations: 300 },
      river: { budgetMs: 700, minIterations: 40, iterations: 400, ponderIterations: 600 },
      riverStride: 4,
      adaptive: true,
      analysis: true,
    }),
  });
}

/** @param {Float32Array|undefined} range */
function compressRange(range) {
  return range ? Array.from(range) : undefined;
}

/**
 * Thinking on the player's time. On the turn and river the Expert keeps solving the current street in short
 * slices while the player decides, so its next decision starts from a more converged solve. Any new message
 * stops it: the slices yield to the event loop, and a stale generation number ends the loop.
 */
let ponderGen = 0;
/** @param {number} gen @param {any} obs */
function ponderSlice(gen, obs) {
  if (gen !== ponderGen) return;
  let more = false;
  try { more = bot?.ponder?.(obs, 40) ?? false; } catch { more = false; }
  if (more) setTimeout(() => ponderSlice(gen, obs), 0);
}

self.onmessage = async (ev) => {
  const m = ev.data;
  const gen = ++ponderGen;
  try {
    switch (m.type) {
      case 'ponder':
        self.postMessage({ id: m.id, type: 'ok' });
        if (difficulty === 'expert') setTimeout(() => ponderSlice(gen, m.obs), 0);
        break;
      case 'init':
        await init(m.difficulty);
        self.postMessage({ id: m.id, type: 'ready' });
        break;
      case 'prepare': // the effective stack for the next hand, so its table is downloaded before it matters
        if (difficulty === 'expert') await store.ensure(m.effectiveBB);
        self.postMessage({ id: m.id, type: 'prepared' });
        break;
      case 'handStart':
        bot.onHandStart?.(m.obs);
        self.postMessage({ id: m.id, type: 'ok' });
        break;
      case 'act': {
        const t0 = performance.now();
        const action = bot.act(m.obs);
        const info = bot.lastDecision ? { ...bot.lastDecision, oppRange: compressRange(bot.lastDecision.oppRange) } : null;
        self.postMessage({ id: m.id, type: 'action', action, info, ms: performance.now() - t0 });
        break;
      }
      default:
        self.postMessage({ id: m.id, type: 'error', error: `Unknown message ${m.type}` });
    }
  } catch (e) {
    self.postMessage({ id: m.id, type: 'error', error: String(/** @type {any} */ (e)?.stack ?? e) });
  }
};
