// @ts-check
/**
 * The playable game: match flow, table rendering, controls, history and the post-hand AI review.
 * The page holds the rules engine; the AI runs in a worker and only ever receives its own observation.
 */
import { Match, PREFLOP, STREET_NAMES } from '../engine/game.js';
import { RANKS, cardToString } from '../engine/cards.js';
import { evaluate, categoryName } from '../engine/evaluator.js';
import { HAND_A, HAND_B, NUM_HANDS } from '../ai/hands.js';

const HUMAN = 0, AI = 1;
const fmt = (/** @type {number} */ n) => Math.round(n).toLocaleString('en-US');
const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(x > 0.995 || x < 0.005 ? 0 : 1)}%`;

/** Match formats. Quick is the short format for visitors; Deep is a full 100 big blind heads-up session. */
export const FORMATS = {
  quick: {
    label: 'Quick match', blurb: 'First to 3,000 chips. Blinds rise every 5 hands. About 5 minutes.',
    startingStack: 2000, goalStack: 3000, handsPerLevel: 5,
    blinds: [[50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000]].map(([small, big]) => ({ small, big })),
  },
  deep: {
    label: 'Deep stacks', blurb: '100 big blinds each with flat blinds. Play until someone is out of chips.',
    startingStack: 10000, goalStack: 0, handsPerLevel: 0, blinds: [{ small: 50, big: 100 }],
  },
};

export const LEVELS = {
  casual: { label: 'Casual', blurb: 'Friendly. Calls too much and rarely bluffs.', name: 'Casual bot' },
  competitive: { label: 'Competitive', blurb: 'A careful rule-based player using equity and position.', name: 'Competitive bot' },
  expert: { label: 'Expert', blurb: 'Trained with CFR, and solves the turn and river live.', name: 'Expert AI' },
};

const SUIT_PATHS = [
  'M50 8c-7 0-13 5-13 12 0 3 1 6 3 8-3-2-7-3-10-3-9 0-16 7-16 16s7 16 16 16c6 0 11-3 14-7-1 12-5 22-10 30h32c-5-8-9-18-10-30 3 4 8 7 14 7 9 0 16-7 16-16s-7-16-16-16c-3 0-7 1-10 3 2-2 3-5 3-8 0-7-6-12-13-12z', // club
  'M50 6 84 50 50 94 16 50z', // diamond
  'M50 90C20 66 8 50 8 33 8 20 18 11 30 11c8 0 15 4 20 12 5-8 12-12 20-12 12 0 22 9 22 22 0 17-12 33-42 57z', // heart
  'M50 8C30 30 12 43 12 60c0 11 9 19 19 19 6 0 11-2 15-7-1 8-4 15-9 20h26c-5-5-8-12-9-20 4 5 9 7 15 7 10 0 19-8 19-19C88 43 70 30 50 8z', // spade
];
const suitSvg = (/** @type {number} */ s, /** @type {string} */ cls) => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="${SUIT_PATHS[s]}"/></svg>`;
const SUIT_WORD = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANK_WORD = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];

/** @param {number|null} c @param {{down?:boolean,dealt?:boolean,delay?:number,small?:boolean}} [o] */
function cardEl(c, o = {}) {
  const el = document.createElement('div');
  el.className = `pk-card${o.down ? ' is-down' : ''}${o.dealt ? ' is-dealt' : ''}${o.small ? ' pk-card--sm' : ''}`;
  if (o.delay) el.style.setProperty('--pk-delay', `${o.delay}s`);
  fillCard(el, c, !!o.down);
  return el;
}

/** @param {HTMLElement} el @param {number|null} c @param {boolean} down */
function fillCard(el, c, down) {
  if (c === null || down) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Face-down card');
    el.innerHTML = `<div class="pk-card-in"><div class="pk-face"></div><div class="pk-back"></div></div>`;
    return;
  }
  const r = c >> 2, s = c & 3;
  el.classList.toggle('is-red', s === 1 || s === 2);
  el.dataset.card = cardToString(c);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${RANK_WORD[r]} of ${SUIT_WORD[s]}`);
  el.innerHTML = `<div class="pk-card-in"><div class="pk-face"><span class="pk-rank">${RANKS[r]}</span>${suitSvg(s, 'pk-suit-s')}${suitSvg(s, 'pk-suit-b')}</div><div class="pk-back"></div></div>`;
}

/** The five cards that make up the best hand. @param {number[]} hole @param {number[]} board */
function bestFive(hole, board) {
  const all = [...hole, ...board];
  let best = -1, cards = /** @type {number[]} */ ([]);
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    const five = all.filter((_, k) => k !== i && k !== j);
    const v = evaluate(five);
    if (v > best) { best = v; cards = five; }
  }
  return cards;
}

/** Small WebAudio cues. Silent until the player turns sound on. */
class Sound {
  on = false;
  /** @type {AudioContext|null} */
  ctx = null;
  /** @param {number} freq @param {number} dur @param {OscillatorType} type @param {number} vol @param {number} [delay] */
  tone(freq, dur, type = 'sine', vol = 0.05, delay = 0) {
    if (!this.on) return;
    this.ctx ??= new AudioContext();
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur);
  }
  deal() { this.tone(700, 0.05, 'triangle', 0.035); }
  chip() { this.tone(1500, 0.05, 'square', 0.015); this.tone(2100, 0.04, 'square', 0.012, 0.03); }
  win() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.22, 'sine', 0.05, i * 0.09)); }
  lose() { this.tone(196, 0.3, 'sine', 0.04); }
}

class AIClient {
  constructor() {
    this.worker = new Worker(new URL('../ai/worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    /** @type {Map<number,{resolve:(v:any)=>void,reject:(e:any)=>void}>} */
    this.pending = new Map();
    this.worker.onmessage = (ev) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.type === 'error') p.reject(new Error(ev.data.error)); else p.resolve(ev.data);
    };
    this.worker.onerror = (ev) => { for (const p of this.pending.values()) p.reject(new Error(ev.message || 'AI worker failed')); this.pending.clear(); };
  }
  /** @param {any} msg */
  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }
  destroy() { this.worker.terminate(); }
}

/**
 * Mount the game into a container.
 * @param {HTMLElement} root
 * @param {{format?:'quick'|'deep', difficulty?:'casual'|'competitive'|'expert', onClose?:()=>void, links?:{howItWorks?:string,benchmarks?:string,source?:string}}} [options]
 */
export function mountPokerGame(root, options = {}) {
  const game = new PokerGame(root, options);
  return { destroy: () => game.destroy(), game };
}

class PokerGame {
  /** @param {HTMLElement} root @param {any} options */
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.format = options.format ?? 'quick';
    this.difficulty = options.difficulty ?? 'expert';
    this.sound = new Sound();
    /** @type {AIClient|null} */
    this.ai = null;
    /** @type {Match|null} */
    this.match = null;
    this.handsLog = /** @type {any[]} */ ([]);
    this.review = /** @type {any[]} */ ([]);
    this.awaitingHuman = false;
    this.handOver = false;
    this.token = 0; // cancels pending async steps after a restart
    this.stats = { hands: 0, won: 0, biggest: 0 };
    this.tab = 'log';
    this.#buildShell();
    this.keyHandler = (/** @type {KeyboardEvent} */ e) => this.#onKey(e);
    root.addEventListener('keydown', this.keyHandler);
    this.#showMenu();
  }

  destroy() {
    this.token++;
    this.root.removeEventListener('keydown', this.keyHandler);
    this.ai?.destroy();
    this.root.innerHTML = '';
  }

  // ---------- shell ----------
  #buildShell() {
    const closeBtn = this.options.onClose ? `<button class="pk-iconbtn" data-act="close" aria-label="Close the game"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : '';
    this.root.innerHTML = `
    <div class="pk-app" tabindex="-1">
      <div class="pk-top">
        <div class="pk-top-title"><span data-el="title">Heads-up vs AI</span><small data-el="blinds"></small></div>
        <div class="pk-goal" data-el="goal">
          <div class="pk-goal-row"><span data-el="goalYou"></span><span data-el="goalMid"></span><span data-el="goalAi"></span></div>
          <div class="pk-goal-bar"><div class="pk-goal-fill" data-el="goalFill"></div><i class="pk-goal-mark" data-el="markA"></i><i class="pk-goal-mark" data-el="markB"></i></div>
        </div>
        <button class="pk-iconbtn pk-only-narrow" data-act="toggleSide" aria-label="Show history and AI review"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>
        <button class="pk-iconbtn" data-act="sound" aria-pressed="false" aria-label="Sound"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7"/></svg></button>
        <button class="pk-iconbtn" data-act="restart" aria-label="Restart the match"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v6h6"/><path d="M4.5 15a8 8 0 101.8-8.3L4 10"/></svg></button>
        ${closeBtn}
      </div>
      <div class="pk-main">
        <div class="pk-stage">
          <div class="pk-table-wrap"><div class="pk-felt">
            <div class="pk-seat pk-seat--ai" data-el="seatAi">
              <div class="pk-plate"><div class="pk-avatar">AI</div><div><div class="pk-name" data-el="aiName">Expert AI</div><div class="pk-stack" data-el="aiStack" data-test="ai-stack">0</div></div><div class="pk-dealer" data-el="dAi" hidden>D</div></div>
              <div class="pk-hole" data-el="aiHole"></div>
            </div>
            <div class="pk-status" data-el="status" aria-live="polite"></div>
            <div class="pk-bet" data-el="betAi"></div>
            <div class="pk-center">
              <div class="pk-board" data-el="board" data-test="board"></div>
              <div class="pk-pot"><small>POT</small><span data-el="pot" data-test="pot">0</span></div>
            </div>
            <div class="pk-bet" data-el="betYou"></div>
            <div class="pk-seat pk-seat--you" data-el="seatYou">
              <div class="pk-hole" data-el="youHole" data-test="my-cards"></div>
              <div class="pk-plate"><div class="pk-avatar">YOU</div><div><div class="pk-name">You</div><div class="pk-stack" data-el="youStack" data-test="my-stack">0</div></div><div class="pk-dealer" data-el="dYou" hidden>D</div></div>
            </div>
          </div></div>
          <div class="pk-controls" data-el="controls"></div>
        </div>
        <aside class="pk-side" data-el="side">
          <div class="pk-tabs" role="tablist">
            <button class="pk-tab" role="tab" data-tab="log" aria-selected="true">Hand history</button>
            <button class="pk-tab" role="tab" data-tab="review" aria-selected="false">AI review</button>
            <button class="pk-iconbtn pk-only-narrow" data-act="toggleSide" aria-label="Close this panel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
          <div class="pk-panel-body" data-el="panel"></div>
        </aside>
      </div>
      <div class="pk-sr" aria-live="assertive" data-el="announce"></div>
    </div>`;
    this.els = /** @type {Record<string,HTMLElement>} */ ({});
    this.root.querySelectorAll('[data-el]').forEach((n) => { this.els[/** @type {HTMLElement} */ (n).dataset.el ?? ''] = /** @type {HTMLElement} */ (n); });
    this.app = /** @type {HTMLElement} */ (this.root.querySelector('.pk-app'));
    this.app.addEventListener('click', (e) => this.#onClick(e));
    this.#renderPanel();
  }

  /** @param {Event} e */
  #onClick(e) {
    const t = /** @type {HTMLElement} */ (e.target).closest('[data-act],[data-tab],[data-pick]');
    // On narrow screens the side panel is a drawer: tapping outside it closes it.
    if (this.els.side.classList.contains('is-open') && !/** @type {HTMLElement} */ (e.target).closest('.pk-side') && /** @type {HTMLElement|null} */ (t)?.dataset.act !== 'toggleSide' && /** @type {HTMLElement|null} */ (t)?.dataset.act !== 'openReview') {
      this.els.side.classList.remove('is-open');
    }
    if (!t) return;
    const el = /** @type {HTMLElement} */ (t);
    if (el.dataset.tab) { this.tab = el.dataset.tab; this.#renderPanel(); return; }
    if (el.dataset.pick) {
      const [kind, val] = el.dataset.pick.split(':');
      if (kind === 'level') this.difficulty = val; else this.format = val;
      this.#showMenu();
      return;
    }
    switch (el.dataset.act) {
      case 'close': this.options.onClose?.(); break;
      case 'sound': {
        this.sound.on = !this.sound.on;
        el.setAttribute('aria-pressed', String(this.sound.on));
        this.sound.chip();
        break;
      }
      case 'toggleSide': this.els.side.classList.toggle('is-open'); break;
      case 'restart': this.#showMenu(); break;
      case 'start': this.#startMatch(); break;
      case 'next': this.els.side.classList.remove('is-open'); this.#nextHand(); break;
      case 'fold': this.#human({ type: 'fold' }); break;
      case 'check': this.#human({ type: 'check' }); break;
      case 'call': this.#human({ type: 'call' }); break;
      case 'raise': this.#human({ type: 'raise', to: this.#raiseValue() }); break;
      case 'preset': this.#setRaise(Number(el.dataset.to)); break;
      case 'openReview': this.tab = 'review'; this.els.side.classList.add('is-open'); this.#renderPanel(); break;
      case 'rematch': this.#startMatch(); break;
      case 'menu': this.#showMenu(); break;
      case 'fallback': this.difficulty = 'competitive'; this.#startMatch(); break;
    }
  }

  /** @param {KeyboardEvent} e */
  #onKey(e) {
    if (e.key === 'Escape' && this.options.onClose) { this.options.onClose(); return; }
    if (/** @type {HTMLElement} */ (e.target).tagName === 'INPUT' && e.key !== 'Enter') return;
    if (this.handOver && (e.key === 'Enter' || e.key === ' ') && this.#el('next')) { e.preventDefault(); this.#nextHand(); return; }
    if (!this.awaitingHuman || !this.match?.hand) return;
    const l = this.match.hand.legalActions();
    if (e.key === 'f' && l.canFold) this.#human({ type: 'fold' });
    else if (e.key === 'c' && l.canCheck) this.#human({ type: 'check' });
    else if (e.key === 'c' && l.canCall) this.#human({ type: 'call' });
    else if (e.key === 'r' && l.canRaise) this.#human({ type: 'raise', to: this.#raiseValue() });
  }

  /** @param {string} act */
  #el(act) { return this.root.querySelector(`[data-act="${act}"]`); }

  // ---------- menu ----------
  #overlay(html) {
    this.#closeOverlay();
    const o = document.createElement('div');
    o.className = 'pk-overlay';
    o.innerHTML = html;
    this.app.appendChild(o);
    this.overlay = o;
    return o;
  }
  #closeOverlay() { this.overlay?.remove(); this.overlay = null; }

  #showMenu() {
    this.token++;
    const lv = (/** @type {string} */ k) => { const v = /** @type {any} */ (LEVELS)[k]; return `<button class="pk-choice" role="radio" aria-checked="${this.difficulty === k}" data-pick="level:${k}" data-test="level-${k}"><b>${v.label}</b><span>${v.blurb}</span></button>`; };
    const fm = (/** @type {string} */ k) => { const v = /** @type {any} */ (FORMATS)[k]; return `<button class="pk-choice" role="radio" aria-checked="${this.format === k}" data-pick="format:${k}" data-test="format-${k}"><b>${v.label}</b><span>${v.blurb}</span></button>`; };
    const links = this.options.links ?? {};
    const linkHtml = [
      links.howItWorks ? `<a href="${links.howItWorks}">How the AI works</a>` : '',
      links.benchmarks ? `<a href="${links.benchmarks}">Benchmark results</a>` : '',
      links.source ? `<a href="${links.source}" target="_blank" rel="noopener">Source on GitHub</a>` : '',
    ].join('');
    this.#overlay(`<div class="pk-menu">
      <p class="pk-eyebrow">Heads-up No-Limit Hold'em</p>
      <h2 class="pk-h1">Can You Beat My Poker AI?</h2>
      <p class="pk-sub">An experiment in game theory and decisions with hidden information. You each start with the same chips, and every card is dealt from a fair, secure shuffle.</p>
      <div class="pk-fieldlabel">Opponent</div>
      <div class="pk-choices" role="radiogroup" aria-label="Opponent">${lv('casual')}${lv('competitive')}${lv('expert')}</div>
      <div class="pk-fieldlabel">Format</div>
      <div class="pk-choices pk-choices--2" role="radiogroup" aria-label="Format">${fm('quick')}${fm('deep')}</div>
      <button class="pk-cta" data-act="start" data-test="start">Deal me in</button>
      <p class="pk-note">Virtual chips only. No sign-up. The AI plays only from its own cards and what it can see at the table.</p>
      <div class="pk-menu-links">${linkHtml}</div>
    </div>`);
  }

  // ---------- match flow ----------
  async #startMatch() {
    const token = ++this.token;
    this.ai?.destroy();
    this.ai = null;
    const f = /** @type {any} */ (FORMATS)[this.format];
    this.match = new Match({ startingStack: f.startingStack, blinds: f.blinds, handsPerLevel: f.handsPerLevel, goalStack: f.goalStack || undefined, firstButton: Math.random() < 0.5 ? 0 : 1 });
    this.handsLog = [];
    this.review = [];
    this.stats = { hands: 0, won: 0, biggest: 0 };
    this.handOver = false;
    this.els.aiName.textContent = /** @type {any} */ (LEVELS)[this.difficulty].name;
    this.els.title.textContent = /** @type {any} */ (FORMATS)[this.format].label;
    this.#clearTable();
    this.#renderTop();
    this.#renderPanel();
    this.#overlay(`<div class="pk-load"><div class="pk-spinner"></div><p>${this.difficulty === 'expert' ? 'Loading the AI strategy…' : 'Shuffling up…'}</p></div>`);
    try {
      this.ai = new AIClient();
      await this.ai.call({ type: 'init', difficulty: this.difficulty });
      await this.ai.call({ type: 'prepare', effectiveBB: f.startingStack / f.blinds[0].big });
      if (token !== this.token) return;
    } catch (err) {
      if (token !== this.token) return;
      console.warn('Poker AI failed to load', err);
      this.#overlay(`<div class="pk-menu pk-load"><h2 class="pk-h1">The AI could not load</h2><p class="pk-sub">The strategy files did not download. You can still play the rule-based bot, which needs no download.</p><button class="pk-cta" data-act="fallback">Play the Competitive bot</button><button class="pk-btn pk-btn--ghost" style="width:100%;margin-top:8px" data-act="menu">Back</button></div>`);
      return;
    }
    this.#closeOverlay();
    this.#nextHand();
  }

  #clearTable() {
    for (const k of ['aiHole', 'youHole', 'board', 'betAi', 'betYou', 'status']) this.els[k].innerHTML = '';
    for (let i = 0; i < 5; i++) { const s = document.createElement('div'); s.className = 'pk-slot'; this.els.board.appendChild(s); }
    this.els.controls.innerHTML = '';
    this.boardShown = 0;
    this.els.pot.textContent = '0';
    this.els.seatAi.classList.remove('is-active', 'is-thinking');
    this.els.seatYou.classList.remove('is-active');
  }

  async #nextHand() {
    const m = /** @type {Match} */ (this.match);
    if (m.winner() !== null) { this.#showMatchEnd(); return; }
    const token = ++this.token;
    this.handOver = false;
    this.#clearTable();
    const h = m.nextHand();
    this.currentLog = { number: m.handNumber, blinds: `${fmt(h.smallBlind)}/${fmt(h.bigBlind)}`, button: h.button, entries: [], result: null, board: [] };
    this.logged = 0;
    this.handsLog.unshift(this.currentLog);
    this.review = [];
    this.reviewReady = false;
    this.#renderTop();
    // Hole cards: yours face up, the AI's face down.
    h.holeCards(HUMAN).forEach((c, i) => { this.els.youHole.appendChild(cardEl(c, { dealt: true, delay: 0.05 + i * 0.16 })); });
    for (let i = 0; i < 2; i++) this.els.aiHole.appendChild(cardEl(null, { down: true, dealt: true, delay: 0.13 + i * 0.16 }));
    this.sound.deal();
    this.#syncLog();
    this.#renderState();
    this.#renderPanel();
    if (this.ai) await this.ai.call({ type: 'handStart', obs: h.observation(AI) });
    if (token !== this.token) return;
    await this.#wait(420);
    if (token !== this.token) return;
    this.#loop(token);
  }

  /** @param {number} ms */
  #wait(ms) { return new Promise((r) => setTimeout(r, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? Math.min(ms, 60) : ms)); }

  /** @param {number} token */
  async #loop(token) {
    const m = /** @type {Match} */ (this.match);
    for (;;) {
      const h = /** @type {import('../engine/game.js').HandState} */ (m.hand);
      if (h.finished) { this.#finishHand(); return; }
      if (h.toAct === HUMAN) {
        this.awaitingHuman = true;
        this.#renderControls();
        return;
      }
      this.awaitingHuman = false;
      this.#renderControls();
      this.els.seatAi.classList.add('is-thinking');
      this.els.status.textContent = 'AI is thinking…';
      const obs = h.observation(AI);
      const t0 = performance.now();
      let reply;
      try {
        reply = await /** @type {AIClient} */ (this.ai).call({ type: 'act', obs });
      } catch (err) {
        console.warn('AI error, falling back to a passive action', err);
        reply = { action: obs.legal?.canCheck ? { type: 'check' } : { type: 'fold' }, info: { source: 'error' } };
      }
      if (token !== this.token) return;
      const minThink = 550 + Math.random() * 450;
      const spent = performance.now() - t0;
      if (spent < minThink) await this.#wait(minThink - spent);
      if (token !== this.token) return;
      this.els.seatAi.classList.remove('is-thinking');
      this.els.status.textContent = '';
      this.review.push({ obs, info: reply.info, action: reply.action, ms: spent });
      this.#apply(reply.action, AI);
      await this.#afterAction(token);
      if (token !== this.token) return;
    }
  }

  /** @param {any} action @param {number} seat */
  #apply(action, seat) {
    const m = /** @type {Match} */ (this.match);
    try {
      m.act(action);
    } catch (err) {
      // A legal action is guaranteed by tests; if one ever slips through, never let it break the game.
      console.error('Rejected action', action, err);
      const l = /** @type {any} */ (m.hand).legalActions();
      m.act(l.canCheck ? { type: 'check' } : { type: 'fold' });
    }
    if (action.type === 'raise' || action.type === 'call') this.sound.chip();
    this.#syncLog();
    this.#renderState();
    this.#renderPanel();
    this.#announceLast(seat);
  }

  /** @param {number} token Reveal any newly dealt board cards with a short pause. */
  async #afterAction(token) {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    const target = h.board.length;
    if (target > this.boardShown) await this.#wait(240);
    while (this.boardShown < target) {
      if (token !== this.token) return;
      const stage = this.boardShown === 0 ? 3 : this.boardShown + 1;
      this.#dealBoardTo(stage);
      this.sound.deal();
      await this.#wait(h.finished ? 620 : 300);
    }
  }

  /** @param {number} count */
  #dealBoardTo(count) {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    const slots = this.els.board.children;
    for (let i = this.boardShown; i < count; i++) {
      const c = cardEl(h.board[i], { dealt: true, delay: (i - this.boardShown) * 0.1 });
      this.els.board.replaceChild(c, slots[i]);
    }
    this.boardShown = count;
  }

  /** @param {any} action */
  async #human(action) {
    if (!this.awaitingHuman) return;
    const token = this.token;
    this.awaitingHuman = false;
    this.els.controls.innerHTML = '';
    this.#apply(action, HUMAN);
    await this.#afterAction(token);
    if (token !== this.token) return;
    this.#loop(token);
  }

  #finishHand() {
    const m = /** @type {Match} */ (this.match);
    const h = /** @type {any} */ (m.hand);
    const r = h.result;
    this.handOver = true;
    this.awaitingHuman = false;
    this.reviewReady = true;
    this.els.seatAi.classList.remove('is-active', 'is-thinking');
    this.els.seatYou.classList.remove('is-active');
    this.stats.hands++;
    this.stats.biggest = Math.max(this.stats.biggest, r.pot);
    const youWon = r.net[HUMAN] > 0, tie = r.net[HUMAN] === 0;
    if (youWon) this.stats.won++;
    let line = '', detail = '';
    if (r.reason === 'showdown') {
      const aiCards = r.showdown.holes[AI];
      this.els.aiHole.innerHTML = '';
      aiCards.forEach((/** @type {number} */ c) => this.els.aiHole.appendChild(cardEl(c)));
      const youHand = categoryName(r.showdown.scores[HUMAN]), aiHand = categoryName(r.showdown.scores[AI]);
      if (!tie) {
        const winner = r.winners[0];
        const five = bestFive(r.showdown.holes[winner], r.showdown.board).map(cardToString);
        this.app.querySelectorAll('.pk-board .pk-card, [data-el="' + (winner === HUMAN ? 'youHole' : 'aiHole') + '"] .pk-card').forEach((c) => {
          /** @type {HTMLElement} */ (c).classList.toggle('is-win', five.includes(/** @type {HTMLElement} */ (c).dataset.card ?? ''));
        });
      }
      detail = `You: ${youHand} · AI: ${aiHand}`;
      line = tie ? 'Split pot' : youWon ? `You win ${fmt(r.net[HUMAN])}` : `AI wins ${fmt(r.net[AI])}`;
    } else {
      line = youWon ? `AI folds. You win ${fmt(r.net[HUMAN])}` : `You fold. AI wins ${fmt(r.net[AI])}`;
    }
    if (youWon) this.sound.win(); else if (!tie) this.sound.lose();
    this.currentLog.result = `${line}${detail ? ` (${detail})` : ''}`;
    this.#renderState();
    this.#renderPanel();
    this.#renderTop();
    const ended = m.winner() !== null;
    const cls = youWon ? 'is-win' : tie ? '' : 'is-lose';
    this.els.controls.innerHTML = `
      <div class="pk-result ${cls}" data-test="hand-result">${line}<small>${detail}</small></div>
      <div class="pk-actions">
        <button class="pk-btn pk-btn--ghost" data-act="openReview" data-test="review">Why did the AI do that?</button>
        <button class="pk-btn pk-btn--next" data-act="next" data-test="next">${ended ? 'See the result' : 'Next hand'} <kbd>Enter</kbd></button>
      </div>`;
    this.#announce(line);
    /** @type {HTMLElement|null} */ (this.#el('next'))?.focus({ preventScroll: true });
    this.ai?.call({ type: 'prepare', effectiveBB: this.#nextEffectiveBB() }).catch(() => {});
  }

  #nextEffectiveBB() {
    const m = /** @type {Match} */ (this.match);
    const f = /** @type {any} */ (FORMATS)[this.format];
    const lv = f.handsPerLevel ? Math.floor(m.handNumber / f.handsPerLevel) : 0;
    const bb = f.blinds[Math.min(lv, f.blinds.length - 1)].big;
    return Math.max(1, Math.min(m.stacks[0], m.stacks[1])) / bb;
  }

  #showMatchEnd() {
    const m = /** @type {Match} */ (this.match);
    const you = m.winner() === HUMAN;
    this.token++;
    const lvl = /** @type {any} */ (LEVELS)[this.difficulty].label;
    const harder = you && this.difficulty !== 'expert';
    const links = this.options.links ?? {};
    this.#overlay(`<div class="pk-menu pk-load" data-test="match-end">
      <p class="pk-eyebrow">${lvl} · ${m.handNumber} hands</p>
      <h2 class="pk-h1">${you ? (this.difficulty === 'expert' ? 'You beat the Expert AI.' : 'You won the match.') : 'The AI takes this one.'}</h2>
      <p class="pk-sub">${you ? (this.difficulty === 'expert' ? 'One match has a lot of luck in it, so it may take a few more to know for sure.' : 'Ready for a stronger opponent?') : 'Short matches swing a lot. It is rarely over in one try.'}</p>
      <div class="pk-endstats">
        <div class="pk-stat"><span>Hands</span><b>${m.handNumber}</b></div>
        <div class="pk-stat"><span>Hands won</span><b>${this.stats.won}</b></div>
        <div class="pk-stat"><span>Biggest pot</span><b>${fmt(this.stats.biggest)}</b></div>
      </div>
      <div class="pk-end-actions">
        <button class="pk-btn pk-btn--next" style="grid-column:auto" data-act="rematch" data-test="rematch">Play again</button>
        <button class="pk-btn pk-btn--ghost" data-act="menu">${harder ? 'Try a harder bot' : 'Change opponent'}</button>
      </div>
      <div class="pk-menu-links">${links.howItWorks ? `<a href="${links.howItWorks}">How the AI works</a>` : ''}${links.source ? `<a href="${links.source}" target="_blank" rel="noopener">Source on GitHub</a>` : ''}</div>
    </div>`);
  }

  // ---------- rendering ----------
  #renderTop() {
    const m = this.match;
    const f = /** @type {any} */ (FORMATS)[this.format];
    if (!m) return;
    const total = m.stacks[0] + m.stacks[1];
    const hand = m.hand;
    const you = hand && !hand.finished ? hand.stacks[0] + hand.totals[0] : m.stacks[0];
    const b = hand ? { small: hand.smallBlind, big: hand.bigBlind } : f.blinds[0];
    this.els.goalFill.style.width = `${(you / total) * 100}%`;
    this.els.goalYou.textContent = `You ${fmt(you)}`;
    this.els.goalAi.textContent = `AI ${fmt(total - you)}`;
    if (f.goalStack) {
      this.els.goalMid.textContent = `First to ${fmt(f.goalStack)}`;
      this.els.markA.style.left = `${(f.goalStack / total) * 100}%`;
      this.els.markB.style.left = `${((total - f.goalStack) / total) * 100}%`;
      this.els.markA.hidden = false; this.els.markB.hidden = false;
    } else {
      this.els.goalMid.textContent = 'Last one with chips wins';
      this.els.markA.hidden = true; this.els.markB.hidden = true;
    }
    let lv = '';
    if (f.handsPerLevel) {
      const left = f.handsPerLevel - ((m.handNumber - 1 + f.handsPerLevel) % f.handsPerLevel);
      lv = left === 1 ? ' · blinds up next hand' : ` · blinds up in ${left}`;
    }
    this.els.blinds.textContent = `Hand ${m.handNumber || 1} · ${fmt(b.small)}/${fmt(b.big)}${lv}`;
  }

  #renderState() {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    if (!h) return;
    this.els.youStack.textContent = fmt(h.stacks[HUMAN]);
    this.els.aiStack.textContent = fmt(h.stacks[AI]);
    this.els.pot.textContent = fmt(h.finished ? h.result.pot : h.pot);
    this.els.dYou.hidden = h.button !== HUMAN;
    this.els.dAi.hidden = h.button !== AI;
    const showBet = (/** @type {HTMLElement} */ el, /** @type {number} */ v) => { el.innerHTML = v > 0 ? `<i class="pk-chip"></i>${fmt(v)}` : ''; };
    showBet(this.els.betYou, h.finished ? 0 : h.bets[HUMAN]);
    showBet(this.els.betAi, h.finished ? 0 : h.bets[AI]);
    this.els.seatYou.classList.toggle('is-active', !h.finished && h.toAct === HUMAN);
    this.els.seatAi.classList.toggle('is-active', !h.finished && h.toAct === AI);
    this.#renderTop();
  }

  #renderControls() {
    const m = /** @type {Match} */ (this.match);
    const h = /** @type {any} */ (m.hand);
    if (!this.awaitingHuman) {
      this.els.controls.innerHTML = `<div class="pk-waiting">Waiting for the AI…</div>`;
      return;
    }
    const l = h.legalActions();
    const cur = Math.max(h.bets[0], h.bets[1]);
    const verb = cur > 0 ? 'Raise to' : 'Bet';
    const presetTo = (/** @type {number} */ f) => Math.round(cur + f * (h.pot + l.callAmount));
    const clamp = (/** @type {number} */ x) => Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, x));
    const oppCover = Math.min(l.maxRaiseTo, h.stacks[AI] + h.bets[AI]);
    const defaultTo = l.canRaise ? clamp(h.street === PREFLOP && cur <= h.bigBlind ? Math.round(2.5 * h.bigBlind) : presetTo(0.66)) : 0;
    const preset = (/** @type {string} */ label, /** @type {number} */ to) => {
      const t = clamp(to);
      return `<button class="pk-preset" data-act="preset" data-to="${t}">${label}</button>`;
    };
    const sizer = l.canRaise ? `
      <div class="pk-sizer">
        <div class="pk-presets">
          ${preset('Min', l.minRaiseTo)}${preset('⅓', presetTo(1 / 3))}${preset('½', presetTo(0.5))}${preset('¾', presetTo(0.75))}${preset('Pot', presetTo(1))}${preset('All-in', oppCover)}
        </div>
        <input class="pk-slider" type="range" min="${l.minRaiseTo}" max="${oppCover}" step="1" value="${Math.min(defaultTo, oppCover)}" aria-label="Bet size" data-el2="slider" data-test="slider">
        <input class="pk-amount" type="number" min="${l.minRaiseTo}" max="${oppCover}" value="${Math.min(defaultTo, oppCover)}" aria-label="Exact bet size" data-el2="amount" data-test="amount">
      </div>` : '';
    const left = l.canFold
      ? `<button class="pk-btn pk-btn--fold" data-act="fold" data-test="fold">Fold <kbd>F</kbd></button>`
      : `<button class="pk-btn pk-btn--fold" disabled data-test="fold">Fold</button>`;
    const middle = l.canCheck
      ? `<button class="pk-btn pk-btn--call" data-act="check" data-test="check">Check <kbd>C</kbd></button>`
      : `<button class="pk-btn pk-btn--call" data-act="call" data-test="call">Call ${fmt(l.callAmount)} <kbd>C</kbd></button>`;
    const right = l.canRaise
      ? `<button class="pk-btn pk-btn--raise" data-act="raise" data-test="raise"><span data-el2="raiseLabel"></span> <kbd>R</kbd></button>`
      : `<button class="pk-btn pk-btn--raise" disabled data-test="raise">Raise</button>`;
    this.els.controls.innerHTML = `${sizer}<div class="pk-actions">${left}${middle}${right}</div>`;
    this.verb = verb;
    this.oppCover = oppCover;
    if (l.canRaise) {
      const s = /** @type {HTMLInputElement} */ (this.els.controls.querySelector('[data-el2="slider"]'));
      const a = /** @type {HTMLInputElement} */ (this.els.controls.querySelector('[data-el2="amount"]'));
      s.addEventListener('input', () => this.#setRaise(Number(s.value)));
      a.addEventListener('change', () => this.#setRaise(Number(a.value)));
      this.#setRaise(Math.min(defaultTo, oppCover));
    }
    this.#renderTop();
  }

  /** @param {number} to */
  #setRaise(to) {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    const l = h.legalActions();
    const x = Math.max(l.minRaiseTo, Math.min(/** @type {number} */ (this.oppCover), Math.round(to) || l.minRaiseTo));
    const s = /** @type {HTMLInputElement|null} */ (this.els.controls.querySelector('[data-el2="slider"]'));
    const a = /** @type {HTMLInputElement|null} */ (this.els.controls.querySelector('[data-el2="amount"]'));
    const lab = this.els.controls.querySelector('[data-el2="raiseLabel"]');
    if (s) s.value = String(x);
    if (a) a.value = String(x);
    if (lab) lab.textContent = x >= /** @type {number} */ (this.oppCover) ? `All-in ${fmt(x)}` : `${this.verb} ${fmt(x)}`;
  }

  #raiseValue() {
    const a = /** @type {HTMLInputElement|null} */ (this.els.controls.querySelector('[data-el2="amount"]'));
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    const l = h.legalActions();
    return Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, Number(a?.value) || l.minRaiseTo));
  }

  // ---------- history ----------
  #syncLog() {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    for (; this.logged < h.history.length; this.logged++) this.currentLog.entries.push(h.history[this.logged]);
    this.currentLog.board = h.board.slice();
  }

  /** @param {any} e */
  #logText(e) {
    const you = e.seat === HUMAN;
    const who = you ? '<b>You</b>' : '<b>AI</b>';
    const v = (/** @type {string} */ base, /** @type {string} */ third) => (you ? base : third);
    switch (e.type) {
      case 'small_blind': return `${who} ${v('post', 'posts')} the small blind ${fmt(e.amount)}`;
      case 'big_blind': return `${who} ${v('post', 'posts')} the big blind ${fmt(e.amount)}`;
      case 'fold': return `${who} ${v('fold', 'folds')}`;
      case 'check': return `${who} ${v('check', 'checks')}`;
      case 'call': return `${who} ${v('call', 'calls')} ${fmt(e.amount)}${e.allIn ? ' (all-in)' : ''}`;
      case 'raise': return `${who} ${e.to === e.amount ? v('bet', 'bets') : v('raise to', 'raises to')} ${fmt(e.to)}${e.allIn ? ' (all-in)' : ''}`;
      case 'uncalled_return': return `${fmt(e.amount)} uncalled returned to ${you ? 'you' : 'the AI'}`;
      default: return e.type;
    }
  }

  /** @param {number} seat */
  #announceLast(seat) {
    const h = /** @type {any} */ (/** @type {Match} */ (this.match).hand);
    const e = [...h.history].reverse().find((x) => x.seat === seat && x.type !== 'uncalled_return');
    if (e) this.#announce(this.#logText(e).replace(/<\/?b>/g, ''));
  }
  /** @param {string} s */
  #announce(s) { this.els.announce.textContent = s; }

  #renderPanel() {
    this.root.querySelectorAll('.pk-tab').forEach((t) => t.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (t).dataset.tab === this.tab)));
    this.els.panel.innerHTML = this.tab === 'log' ? this.#logHtml() : this.#reviewHtml();
  }

  #logHtml() {
    if (!this.handsLog.length) return `<p class="pk-muted">Hands will appear here as you play.</p>`;
    return this.handsLog.slice(0, 40).map((hand) => {
      let html = `<div class="pk-log-hand"><div class="pk-log-head"><span>Hand ${hand.number}</span><span>${hand.blinds}</span></div>`;
      let street = -1;
      const boardFor = [0, 3, 4, 5];
      for (const e of hand.entries) {
        if (e.street !== street) {
          street = e.street;
          const cards = hand.board.slice(0, boardFor[street]).map(cardToString).join(' ');
          html += `<div class="pk-log-street">${STREET_NAMES[street]}${street > 0 && cards ? ` · ${cards}` : ''}</div>`;
        }
        html += `<div class="pk-log-line">${this.#logText(e)}</div>`;
      }
      if (hand.result) html += `<div class="pk-log-result">${hand.result}</div>`;
      return `${html}</div>`;
    }).join('');
  }

  // ---------- AI review ----------
  #reviewHtml() {
    if (!this.match?.hand) return `<p class="pk-muted">After each hand you can inspect how the AI decided.</p>`;
    if (!this.reviewReady) return `<p class="pk-muted">The review unlocks when this hand ends, so it cannot give away the AI's cards.</p>`;
    const h = /** @type {any} */ (this.match.hand);
    if (!this.review.length) return `<p class="pk-muted">The AI made no decision this hand.</p>`;
    const aiCards = this.review[0].obs.hole.map(cardToString).join(' ');
    const cards = this.review.map((r) => this.#reviewCard(r)).join('');
    return `<p class="pk-muted" style="margin:0 0 8px">The AI held <b class="pk-mono" style="color:var(--pk-paper)">${aiCards}</b> in hand ${h.handNumber}.</p>${cards}
      <p class="pk-caveat">These numbers come from the AI's own model: estimated hand ranges and a limited set of bet sizes. They explain what it computed, and they do not prove any move was optimal.</p>`;
  }

  /** @param {any} r */
  #reviewCard(r) {
    const { obs, info, action } = r;
    const l = obs.legal;
    const odds = l.canCall ? l.callAmount / (obs.pot + l.callAmount) : 0;
    const source = !info ? { label: 'Rule-based', plain: true }
      : info.source === 'solver' ? { label: `Live solve · ${info.iterations} it · ${Math.round(info.ms)} ms` }
      : info.source === 'blueprint' ? { label: 'Trained strategy' }
      : { label: 'Fallback', plain: true };
    const equity = info?.equity;
    const chosenName = this.#actionName(action, obs);
    let bars = '';
    if (info?.options) {
      const names = info.options.map((/** @type {any} */ o) => this.#optionName(o, obs));
      bars = `<div class="pk-bars">${info.options.map((/** @type {any} */ o, /** @type {number} */ i) => `
        <div class="pk-bar ${i === info.chosen ? 'is-chosen' : ''}"><span>${names[i]}</span>
        <div class="pk-bar-track"><div class="pk-bar-fill" style="width:${(o.prob * 100).toFixed(1)}%"></div></div>
        <span class="pk-bar-val">${pct(o.prob)}${o.ev !== undefined ? ` · ${o.ev >= 0 ? '+' : ''}${fmt(o.ev)}` : ''}</span></div>`).join('')}</div>`;
    }
    const heat = info?.oppRange ? this.#rangeHeat(info.oppRange) : '';
    return `<div class="pk-rv">
      <div class="pk-rv-head"><span class="pk-rv-street">${STREET_NAMES[obs.street]}: ${chosenName}</span><span class="pk-badge ${source.plain ? 'pk-badge--plain' : ''}">${source.label}</span></div>
      <div class="pk-stats">
        <div class="pk-stat"><span>Pot</span><b>${fmt(obs.pot)}</b></div>
        <div class="pk-stat"><span>Pot odds</span><b>${l.canCall ? pct(odds) : 'free'}</b></div>
        <div class="pk-stat"><span>Equity est.</span><b>${equity !== undefined ? pct(equity) : '–'}</b></div>
      </div>
      ${bars}
      <p class="pk-why">${this.#why(r, odds, chosenName)}</p>
      ${heat ? `<p class="pk-muted" style="margin:8px 0 0;font-size:.66rem">Hands it thought you could hold at this point:</p>${heat}` : ''}
    </div>`;
  }

  /** @param {any} o @param {any} obs */
  #optionName(o, obs) {
    if (o.type === 0) return 'Fold';
    if (o.type === 1) return 'Check';
    if (o.type === 2) return 'Call';
    const cur = Math.max(obs.bets[0], obs.bets[1]);
    if (o.allIn) return 'All-in';
    if (o.to) return `${cur > 0 ? 'Raise' : 'Bet'} ${fmt(o.to)}`;
    return `${cur > 0 ? 'Raise' : 'Bet'} ${Math.round((o.frac ?? 0) * 100)}%`;
  }

  /** @param {any} a @param {any} obs */
  #actionName(a, obs) {
    if (a.type === 'raise') return `${Math.max(obs.bets[0], obs.bets[1]) > 0 ? 'raised to' : 'bet'} ${fmt(a.to)}`;
    return { fold: 'folded', check: 'checked', call: 'called' }[/** @type {'fold'|'check'|'call'} */ (a.type)];
  }

  /** A plain description built only from numbers the AI actually computed. @param {any} r @param {number} odds @param {string} chosen */
  #why(r, odds, chosen) {
    const { info, obs, action } = r;
    const parts = [];
    const eq = info?.equity;
    if (obs.legal.canCall && eq !== undefined) {
      parts.push(`A call needed ${pct(odds)} equity, and it estimated ${pct(eq)} against the hands it thought you held.`);
    } else if (eq !== undefined) {
      parts.push(`It estimated ${pct(eq)} equity against the hands it thought you held.`);
    }
    if (info?.options) {
      const sorted = [...info.options].sort((a, b) => b.prob - a.prob);
      const top = sorted[0].prob;
      if (top < 0.85 && sorted[1]?.prob > 0.1) {
        parts.push(`This was a mixed spot: the strategy plays more than one action with this hand, so its betting is harder to read. This time it ${chosen}.`);
      } else {
        parts.push(`The strategy strongly favoured this action.`);
      }
      const evs = info.options.filter((/** @type {any} */ o) => o.ev !== undefined);
      if (evs.length > 1) {
        const best = evs.reduce((a, b) => (b.ev > a.ev ? b : a));
        const worst = evs.reduce((a, b) => (b.ev < a.ev ? b : a));
        if (best.ev - worst.ev > 1) parts.push(`Estimated value ranged from ${fmt(worst.ev)} to ${fmt(best.ev)} chips across its options.`);
      }
    }
    if (action.type === 'fold' && eq !== undefined && eq > odds) parts.push('Raw equity assumes both hands reach showdown with no more betting, so folding can still be right when equity beats the price: this hand expects to lose value on later streets.');
    if (action.type === 'raise' && eq !== undefined && eq < 0.42) parts.push('With that little equity this is a bluff or semi-bluff, relying on you folding or on improving later.');
    if (!info) parts.push('This difficulty uses hand-written rules based on equity, position and pot odds, so there is no solver output to show.');
    if (info?.source === 'blueprint' && info.translated) parts.push('Your bet size was not in its trained menu, so it treated it as a blend of the two nearest sizes.');
    if (info?.source === 'fallback') parts.push('The hand left its trained betting tree here, so it used a simple pot-odds rule.');
    return parts.join(' ');
  }

  /** 13x13 grid of the estimated opposing range. @param {number[]} range */
  #rangeHeat(range) {
    const grid = Array.from({ length: 169 }, () => ({ s: 0, n: 0 }));
    for (let h = 0; h < NUM_HANDS; h++) {
      const a = HAND_A[h], b = HAND_B[h], ra = a >> 2, rb = b >> 2;
      const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
      const suited = (a & 3) === (b & 3);
      const idx = ra === rb ? (12 - hi) * 13 + (12 - hi) : suited ? (12 - hi) * 13 + (12 - lo) : (12 - lo) * 13 + (12 - hi);
      grid[idx].s += range[h];
      grid[idx].n++;
    }
    const avg = grid.map((g) => (g.n ? g.s / g.n : 0));
    const max = Math.max(...avg, 1e-9);
    let html = '<div class="pk-heat" aria-hidden="true">';
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const v = avg[r * 13 + c] / max;
      const label = r === c ? `${RANKS[12 - r]}${RANKS[12 - c]}` : '';
      html += `<div style="background:rgba(62,207,142,${(v * 0.9 + (v > 0 ? 0.04 : 0)).toFixed(2)})">${label}</div>`;
    }
    return `${html}</div>`;
  }
}
