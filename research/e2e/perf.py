"""Measures Expert decision latency and model load time in real Chrome.

Part 1 plays hands through the production worker, at full speed. The opposing seat plays check/call.
Part 2 times the solver on the main thread with CPU throttling. Chrome's throttling reaches the main thread but
not dedicated workers, so this is how throttled speed is measured. 4x and 6x are rough stand-ins for mid-range and
low-end phones, not measurements on real phones.

Usage: python perf.py <base_url> [hands]
"""
import json
import sys
from playwright.sync_api import sync_playwright

base = sys.argv[1].rstrip('/')
hands = int(sys.argv[2]) if len(sys.argv) > 2 else 25

SCRIPT = """
async ({hands}) => {
  const { HandState } = await import('/poker/js/engine/game.js');
  const worker = new Worker('/poker/js/ai/worker.js', { type: 'module' });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (e.data.type === 'error') p.reject(new Error(e.data.error)); else p.resolve(e.data); };
  const call = (m) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...m, id }); });
  const t0 = performance.now();
  await call({ type: 'init', difficulty: 'expert' });
  await call({ type: 'prepare', effectiveBB: 20 });
  const loadMs = performance.now() - t0;
  const times = { 0: [], 1: [], 2: [], 3: [] };
  const iters = { 2: [], 3: [] };
  const handsInSolve = [];
  let ai = 1;
  for (let i = 0; i < hands; i++) {
    const h = new HandState({ stacks: [2000, 2000], smallBlind: 50, bigBlind: 100, button: i % 2 });
    await call({ type: 'handStart', obs: h.observation(ai) });
    let guard = 0;
    while (!h.finished && guard++ < 60) {
      if (h.toAct === ai) {
        const obs = h.observation(ai);
        const r = await call({ type: 'act', obs });
        times[obs.street].push(r.ms);
        if (r.info && r.info.source === 'solver' && !r.info.reused) { iters[obs.street].push(r.info.iterations); handsInSolve.push(r.info.hands); }
        h.apply(r.action);
      } else {
        const l = h.legalActions();
        if (l.canCheck) h.apply({ type: 'check' }); else h.apply({ type: 'call' });
      }
    }
  }
  worker.terminate();
  return { loadMs, times, iters, handsInSolve };
}
"""


SOLVER_SCRIPT = """
async () => {
  const { loadSolverCore, Subgame } = await import('/poker/js/ai/solver.js');
  const { NUM_HANDS, HAND_A, HAND_B } = await import('/poker/js/ai/hands.js');
  const { preflopStrength } = await import('/poker/js/ai/bots.js');
  const { parseCards } = await import('/poker/js/engine/cards.js');
  const core = await loadSolverCore(await (await fetch('/poker/js/ai/solver.wasm')).arrayBuffer());
  const r0 = new Float32Array(NUM_HANDS), r1 = new Float32Array(NUM_HANDS);
  for (let h = 0; h < NUM_HANDS; h++) {
    const s = preflopStrength([HAND_A[h], HAND_B[h]]);
    r0[h] = s > 0.3 ? 1 : 0;
    r1[h] = s > 0.2 ? Math.min(1, s * 1.4) : 0;
  }
  const out = {};
  for (const [name, board, stride] of [['turn_stride4', 'Ks 7h 2d 9c', 4], ['turn_stride6', 'Ks 7h 2d 9c', 6], ['river', 'Ks 7h 2d 9c 4s', 1]]) {
    const sg = new Subgame(core, { board: parseCards(board), inv: [300, 300], behind: 1700, minBet: 100, ranges: [r0, r1], riverStride: stride });
    const t0 = performance.now();
    sg.run({ budgetMs: 1000, minIterations: 2 });
    out[name] = { hands: sg.H, msPerIter: +((performance.now() - t0) / sg.iterations).toFixed(1), iterationsIn1500ms: Math.round(1500 / ((performance.now() - t0) / sg.iterations)) };
  }
  return out;
}
"""


def stats(xs):
    if not xs:
        return {'n': 0}
    s = sorted(xs)
    return {'n': len(s), 'mean': round(sum(s) / len(s), 1), 'p50': round(s[len(s) // 2], 1), 'p95': round(s[min(len(s) - 1, int(0.95 * len(s)))], 1), 'max': round(s[-1], 1)}


results = {}
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for rate in [1, 4, 6]:
        ctx = browser.new_context()
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': rate})
        page.goto(f'{base}/poker/index.html')
        page.wait_for_selector('[data-test=start]')
        entry = {'solverMainThread': page.evaluate(SOLVER_SCRIPT)}
        if rate == 1:
            r = page.evaluate(SCRIPT, {'hands': hands})
            names = ['preflop', 'flop', 'turn', 'river']
            entry.update({
                'loadMs': round(r['loadMs']),
                **{names[i]: stats(r['times'][str(i)]) for i in range(4)},
                'turnIterations': stats(r['iters']['2']),
                'riverIterations': stats(r['iters']['3']),
                'handsInSolve': stats(r['handsInSolve']),
            })
        results[f'cpu_{rate}x'] = entry
        print(f'throttle {rate}x', json.dumps(entry))
        ctx.close()
    browser.close()
print(json.dumps(results))
