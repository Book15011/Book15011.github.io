// @ts-check
/**
 * Heads-up No-Limit Texas Hold'em rules engine. It knows nothing about UI or AI.
 * All chips are integers. Hidden cards live in private fields, and bots only ever receive the
 * `observation()` object, so an agent cannot read the deck or the opponent's cards.
 *
 * Heads-up specifics implemented here:
 *  - The button posts the small blind, acts first preflop and last on every later street.
 *  - A raise must add at least the size of the previous bet/raise, except an all-in for less.
 *  - An all-in for less than a full raise cannot reopen betting: the only opponent is all-in.
 *  - Bets above what the opponent can match are returned when the hand settles.
 *  - Heads-up pots at showdown are always even (uncalled chips are refunded first), so a split
 *    pot never has an odd chip. The rule is still coded (big blind) as a defensive default.
 */
import { shuffledDeck } from './cards.js';
import { evaluate } from './evaluator.js';

export const PREFLOP = 0, FLOP = 1, TURN = 2, RIVER = 3, SHOWDOWN = 4;
export const STREET_NAMES = ['preflop', 'flop', 'turn', 'river', 'showdown'];

/**
 * @typedef {{type:'fold'|'check'|'call'|'raise', to?:number}} Action
 * `to` is the player's total street commitment after a raise, not the increment.
 *
 * @typedef {{seat:number, street:number, type:string, amount:number, to:number, allIn:boolean, pot:number}} HistoryEntry
 *
 * @typedef {{canFold:boolean, canCheck:boolean, canCall:boolean, callAmount:number,
 *            canRaise:boolean, minRaiseTo:number, maxRaiseTo:number}} LegalActions
 */

export class HandState {
  #deck; #holes;

  /**
   * @param {{stacks:number[], smallBlind:number, bigBlind:number, button:number, handNumber?:number,
   *          deck?:number[], randInt?:(n:number)=>number}} opts
   */
  constructor(opts) {
    const { stacks, smallBlind, bigBlind, button } = opts;
    if (stacks[0] <= 0 || stacks[1] <= 0) throw new Error('Both players need chips to start a hand');
    this.handNumber = opts.handNumber ?? 1;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.button = button;
    this.startStacks = [stacks[0], stacks[1]];
    this.stacks = [stacks[0], stacks[1]];
    this.bets = [0, 0];   // chips committed on this street
    this.totals = [0, 0]; // chips committed this hand
    this.street = PREFLOP;
    this.board = /** @type {number[]} */ ([]);
    this.history = /** @type {HistoryEntry[]} */ ([]);
    this.finished = false;
    this.result = /** @type {any} */ (null);

    const d = opts.deck ? opts.deck.slice() : shuffledDeck(opts.randInt);
    if (new Set(d).size !== d.length) throw new Error('Corrupt deck');
    // Conventional heads-up deal, starting with the non-button player.
    this.#holes = button === 0 ? [[d[1], d[3]], [d[0], d[2]]] : [[d[0], d[2]], [d[1], d[3]]];
    this.#deck = d.slice(4);

    const bb = 1 - button;
    this.#post(button, smallBlind, 'small_blind');
    this.#post(bb, bigBlind, 'big_blind');
    this.lastRaise = bigBlind;
    this.acted = [false, false];
    this.toAct = button;

    // Nobody can act when a blind has already put a player all-in and the other covers it.
    const buttonOwes = this.bets[bb] - this.bets[button];
    if (this.stacks[button] === 0 || (this.stacks[bb] === 0 && buttonOwes <= 0)) this.#runOut();
  }

  get pot() { return this.totals[0] + this.totals[1]; }
  get currentBet() { return Math.max(this.bets[0], this.bets[1]); }

  /** @param {number} seat @param {number} amount @param {string} type */
  #post(seat, amount, type) {
    const paid = Math.min(amount, this.stacks[seat]);
    this.#commit(seat, paid);
    this.#log(seat, type, paid);
  }

  /** @returns {LegalActions} */
  legalActions() {
    const out = { canFold: false, canCheck: false, canCall: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
    if (this.finished) return out;
    const me = this.toAct, opp = 1 - me;
    const owe = this.bets[opp] - this.bets[me];
    const myMax = this.bets[me] + this.stacks[me];
    if (owe > 0) {
      out.canFold = true; out.canCall = true;
      out.callAmount = Math.min(owe, this.stacks[me]);
    } else {
      out.canCheck = true;
    }
    if (this.stacks[opp] > 0 && myMax > this.currentBet) {
      out.canRaise = true;
      out.minRaiseTo = Math.min(this.currentBet + this.lastRaise, myMax); // all-in for less is allowed
      out.maxRaiseTo = myMax;
    }
    return out;
  }

  /** @param {Action} action */
  apply(action) {
    if (this.finished) throw new Error('Hand is over');
    const me = this.toAct, opp = 1 - me;
    const legal = this.legalActions();
    switch (action.type) {
      case 'fold':
        if (!legal.canFold) throw new Error('Illegal fold: nothing to call');
        this.#log(me, 'fold', 0);
        this.#settleFold(opp);
        return;
      case 'check':
        if (!legal.canCheck) throw new Error('Illegal check: facing a bet');
        this.#log(me, 'check', 0);
        this.acted[me] = true;
        break;
      case 'call':
        if (!legal.canCall) throw new Error('Illegal call: nothing to call');
        this.#commit(me, legal.callAmount);
        this.#log(me, 'call', legal.callAmount);
        this.acted[me] = true;
        break;
      case 'raise': {
        const to = action.to;
        if (!legal.canRaise) throw new Error('Illegal raise: raising is not available');
        if (typeof to !== 'number' || !Number.isInteger(to) || to < legal.minRaiseTo || to > legal.maxRaiseTo) {
          throw new Error(`Illegal raise to ${to}; allowed ${legal.minRaiseTo}..${legal.maxRaiseTo}`);
        }
        const raiseBy = to - this.currentBet;
        // Only a full raise changes the minimum for later raises.
        if (raiseBy >= this.lastRaise) this.lastRaise = raiseBy;
        const pay = to - this.bets[me];
        this.#commit(me, pay);
        this.#log(me, 'raise', pay);
        this.acted[me] = true;
        this.acted[opp] = false;
        break;
      }
      default:
        throw new Error(`Unknown action ${/** @type {any} */ (action).type}`);
    }
    this.#advance();
  }

  /** @param {number} seat @param {number} chips */
  #commit(seat, chips) {
    this.stacks[seat] -= chips; this.bets[seat] += chips; this.totals[seat] += chips;
  }

  /** @param {number} seat @param {string} type @param {number} amount */
  #log(seat, type, amount) {
    this.history.push({ seat, street: this.street, type, amount, to: this.bets[seat], allIn: this.stacks[seat] === 0, pot: this.pot });
  }

  #advance() {
    const me = this.toAct, opp = 1 - me;
    const everyoneDone = this.acted[0] && this.acted[1];
    if (this.bets[0] === this.bets[1]) {
      const anyAllIn = this.stacks[0] === 0 || this.stacks[1] === 0;
      if (anyAllIn && this.acted[me]) { this.#runOut(); return; }
      if (everyoneDone) { this.#nextStreet(); return; }
    } else if (this.stacks[me] === 0 && this.bets[me] < this.bets[opp]) {
      // An all-in call for less than the bet: refund the difference and run it out.
      this.#runOut();
      return;
    }
    this.toAct = opp;
  }

  #refundExcess() {
    const diff = this.bets[0] - this.bets[1];
    if (diff === 0) return;
    const hi = diff > 0 ? 0 : 1, x = Math.abs(diff);
    this.bets[hi] -= x; this.totals[hi] -= x; this.stacks[hi] += x;
    this.#log(hi, 'uncalled_return', x);
  }

  #dealStreet() {
    const d = this.#deck; // positions 0, 4 and 6 are the burn cards
    if (this.street === FLOP) this.board.push(d[1], d[2], d[3]);
    else if (this.street === TURN) this.board.push(d[5]);
    else if (this.street === RIVER) this.board.push(d[7]);
  }

  #nextStreet() {
    this.street++;
    if (this.street > RIVER) { this.#showdown(); return; }
    this.bets = [0, 0];
    this.acted = [false, false];
    this.lastRaise = this.bigBlind;
    this.#dealStreet();
    this.toAct = 1 - this.button; // the big blind acts first after the flop
  }

  #runOut() {
    this.#refundExcess();
    while (this.street < RIVER) { this.street++; this.#dealStreet(); }
    this.bets = [0, 0];
    this.#showdown();
  }

  /** @param {number} winner */
  #settleFold(winner) {
    this.#refundExcess();
    const pot = this.pot;
    this.stacks[winner] += pot;
    this.bets = [0, 0];
    this.finished = true;
    this.result = this.#result({ reason: 'fold', winners: [winner], payouts: winner === 0 ? [pot, 0] : [0, pot], showdown: null });
  }

  #showdown() {
    this.street = SHOWDOWN;
    const s0 = evaluate([...this.#holes[0], ...this.board]);
    const s1 = evaluate([...this.#holes[1], ...this.board]);
    const pot = this.pot;
    let payouts, winners;
    if (s0 > s1) { payouts = [pot, 0]; winners = [0]; }
    else if (s1 > s0) { payouts = [0, pot]; winners = [1]; }
    else {
      const half = Math.floor(pot / 2);
      payouts = [half, half];
      payouts[1 - this.button] += pot - 2 * half; // odd chip to the big blind
      winners = [0, 1];
    }
    this.stacks[0] += payouts[0];
    this.stacks[1] += payouts[1];
    this.finished = true;
    this.result = this.#result({
      reason: 'showdown', winners, payouts,
      showdown: { scores: [s0, s1], holes: [this.#holes[0].slice(), this.#holes[1].slice()], board: this.board.slice() },
    });
  }

  /** @param {any} r */
  #result(r) {
    return {
      ...r, pot: this.pot,
      net: [this.stacks[0] - this.startStacks[0], this.stacks[1] - this.startStacks[1]],
      stacks: [this.stacks[0], this.stacks[1]],
    };
  }

  /** The only view of the game an agent receives: no deck, no opposing hole cards. @param {number} seat */
  observation(seat) {
    return {
      seat,
      hole: this.#holes[seat].slice(),
      board: this.board.slice(),
      street: this.street,
      button: this.button,
      toAct: this.toAct,
      stacks: [this.stacks[0], this.stacks[1]],
      bets: [this.bets[0], this.bets[1]],
      pot: this.pot,
      startStacks: [this.startStacks[0], this.startStacks[1]],
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      handNumber: this.handNumber,
      history: this.history.map((h) => ({ ...h })),
      legal: this.toAct === seat ? this.legalActions() : null,
    };
  }

  /** One seat's cards, for the UI to show that player their own hand. @param {number} seat */
  holeCards(seat) { return this.#holes[seat].slice(); }
}

/** A multi-hand match with button rotation and an optional rising blind schedule. */
export class Match {
  /**
   * @param {{startingStack:number, blinds:{small:number,big:number}[], handsPerLevel?:number,
   *          firstButton?:number, randInt?:(n:number)=>number, resetStacks?:boolean, goalStack?:number}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.stacks = [cfg.startingStack, cfg.startingStack];
    this.button = cfg.firstButton ?? 0;
    this.handNumber = 0;
    this.hand = /** @type {HandState|null} */ (null);
  }

  currentBlinds() {
    const { blinds, handsPerLevel } = this.cfg;
    const level = handsPerLevel ? Math.floor(this.handNumber / handsPerLevel) : 0;
    return { level, ...blinds[Math.min(level, blinds.length - 1)] };
  }

  /** Winner seat, or null while the match is alive. */
  winner() {
    if (this.hand && !this.hand.finished) return null;
    if (this.stacks[0] <= 0) return 1;
    if (this.stacks[1] <= 0) return 0;
    const g = this.cfg.goalStack;
    if (g) { if (this.stacks[0] >= g) return 0; if (this.stacks[1] >= g) return 1; }
    return null;
  }

  /** @param {number[]} [deck] */
  nextHand(deck) {
    if (!this.cfg.resetStacks && this.winner() !== null) throw new Error('Match is over');
    if (this.handNumber > 0) this.button = 1 - this.button;
    if (this.cfg.resetStacks) this.stacks = [this.cfg.startingStack, this.cfg.startingStack];
    const b = this.currentBlinds();
    this.handNumber++;
    this.hand = new HandState({
      stacks: this.stacks, smallBlind: b.small, bigBlind: b.big, button: this.button,
      handNumber: this.handNumber, deck, randInt: this.cfg.randInt,
    });
    if (this.hand.finished) this.#sync();
    return this.hand;
  }

  /** @param {Action} action */
  act(action) {
    if (!this.hand) throw new Error('No hand in progress');
    this.hand.apply(action);
    if (this.hand.finished) this.#sync();
  }

  #sync() {
    const h = /** @type {HandState} */ (this.hand);
    this.stacks = [h.stacks[0], h.stacks[1]];
  }
}
