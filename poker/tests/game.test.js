import test from 'node:test';
import assert from 'node:assert/strict';
import { HandState, Match, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN } from '../js/engine/game.js';
import { parseCards, seededRng, shuffledDeck } from '../js/engine/cards.js';

/** A deck dealing known cards. Non-button gets d[0], d[2]; button gets d[1], d[3]. */
function stackedDeck({ button, holes, board }) {
  const bb = 1 - button;
  const hb = parseCards(holes[bb]), hbtn = parseCards(holes[button]);
  const b = parseCards(board);
  const top = [hb[0], hbtn[0], hb[1], hbtn[1]];
  const used = new Set([...top, ...b]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const burn = () => rest.shift();
  return [...top, burn(), b[0], b[1], b[2], burn(), b[3], burn(), b[4], ...rest];
}
const hand = (o = {}) => new HandState({ stacks: [1000, 1000], smallBlind: 5, bigBlind: 10, button: 0, ...o });
const SPLIT = { button: 0, holes: ['Ac 2d', 'Ad 2c'], board: 'Ks Qs Js Ts 9h' };

test('button posts the small blind and acts first preflop; big blind acts first postflop', () => {
  const h = hand({ button: 1 });
  assert.deepEqual(h.bets, [10, 5]);
  assert.equal(h.toAct, 1);
  h.apply({ type: 'call' });
  assert.equal(h.toAct, 0, 'big blind has the option');
  const legal = h.legalActions();
  assert.ok(legal.canCheck && legal.canRaise && !legal.canFold);
  h.apply({ type: 'check' });
  assert.equal(h.street, FLOP);
  assert.equal(h.toAct, 0, 'big blind acts first on the flop');
  assert.equal(h.board.length, 3);
  h.apply({ type: 'check' }); h.apply({ type: 'check' });
  assert.equal(h.street, TURN); assert.equal(h.board.length, 4); assert.equal(h.toAct, 0);
  h.apply({ type: 'check' }); h.apply({ type: 'check' });
  assert.equal(h.street, RIVER); assert.equal(h.board.length, 5);
  h.apply({ type: 'check' }); h.apply({ type: 'check' });
  assert.equal(h.street, SHOWDOWN); assert.ok(h.finished);
});

test('the big blind keeps its option after a limp and may raise', () => {
  const h = hand();
  h.apply({ type: 'call' });
  assert.equal(h.street, PREFLOP);
  h.apply({ type: 'raise', to: 30 });
  assert.equal(h.toAct, 0);
  assert.equal(h.legalActions().callAmount, 20);
});

test('minimum raise equals the previous raise size', () => {
  const h = hand();
  assert.equal(h.legalActions().minRaiseTo, 20, 'an open must add a full big blind');
  assert.throws(() => h.apply({ type: 'raise', to: 19 }), /Illegal raise/);
  h.apply({ type: 'raise', to: 35 }); // adds 25
  assert.equal(h.legalActions().minRaiseTo, 60, 'a re-raise must add at least 25');
  h.apply({ type: 'raise', to: 60 });
  assert.equal(h.legalActions().minRaiseTo, 85);
});

test('postflop minimum bet is one big blind and resets each street', () => {
  const h = hand();
  h.apply({ type: 'raise', to: 100 }); h.apply({ type: 'call' });
  assert.equal(h.street, FLOP);
  assert.equal(h.legalActions().minRaiseTo, 10);
  h.apply({ type: 'raise', to: 50 });
  assert.equal(h.legalActions().minRaiseTo, 100, 'a raise over a 50 bet must add at least 50');
  h.apply({ type: 'call' });
  assert.equal(h.street, TURN);
  assert.equal(h.legalActions().minRaiseTo, 10, 'the minimum resets on the next street');
});

test('an all-in below the minimum raise is legal and ends the betting', () => {
  const h = new HandState({ stacks: [100, 62], smallBlind: 5, bigBlind: 10, button: 0 });
  h.apply({ type: 'raise', to: 50 }); // adds 40, so a full raise would be to 90
  const legal = h.legalActions();
  assert.equal(legal.minRaiseTo, 62, 'the short stack may still go all-in for 62');
  assert.equal(legal.maxRaiseTo, 62);
  h.apply({ type: 'raise', to: 62 });
  const after = h.legalActions();
  assert.ok(after.canCall && after.canFold && !after.canRaise, 'opponent is all-in: only call or fold');
  assert.equal(after.callAmount, 12);
});

test('an uncalled all-in excess is returned', () => {
  const deck = stackedDeck({ button: 0, holes: ['Ac Ad', 'Kc Kd'], board: '2h 3h 7s 9c Jd' });
  const h = new HandState({ stacks: [1000, 300], smallBlind: 5, bigBlind: 10, button: 0, deck });
  h.apply({ type: 'raise', to: 1000 });
  assert.equal(h.legalActions().callAmount, 290);
  h.apply({ type: 'call' });
  assert.ok(h.finished);
  assert.equal(h.result.pot, 600, 'only matched chips are in the pot');
  assert.deepEqual(h.stacks, [1300, 0]);
  assert.ok(h.history.some((x) => x.type === 'uncalled_return' && x.seat === 0 && x.amount === 700));
});

test('a fold returns the uncalled part and awards the matched pot', () => {
  const h = hand();
  h.apply({ type: 'raise', to: 40 });
  h.apply({ type: 'fold' });
  assert.ok(h.finished);
  assert.deepEqual(h.stacks, [1010, 990]);
  assert.equal(h.result.reason, 'fold');
  assert.equal(h.result.showdown, null, 'folded cards stay hidden');
});

test('an all-in preflop runs out the whole board', () => {
  const deck = stackedDeck({ button: 0, holes: ['Ac Ad', 'Kc Kd'], board: '2h 3h 7s 9c Jd' });
  const h = new HandState({ stacks: [500, 500], smallBlind: 5, bigBlind: 10, button: 0, deck });
  h.apply({ type: 'raise', to: 500 });
  h.apply({ type: 'call' });
  assert.equal(h.board.length, 5);
  assert.deepEqual(h.stacks, [1000, 0]);
  assert.equal(h.result.reason, 'showdown');
});

test('a short big blind: the button owes only the difference and cannot raise', () => {
  const h = new HandState({ stacks: [1000, 6], smallBlind: 5, bigBlind: 10, button: 0 });
  assert.deepEqual(h.bets, [5, 6]);
  const l = h.legalActions();
  assert.equal(l.callAmount, 1);
  assert.ok(!l.canRaise);
  h.apply({ type: 'call' });
  assert.ok(h.finished);
  assert.equal(h.stacks[0] + h.stacks[1], 1006);
});

test('blinds that put a player all-in go straight to showdown and refund the excess', () => {
  const a = new HandState({ stacks: [3, 1000], smallBlind: 5, bigBlind: 10, button: 0 });
  assert.ok(a.finished, 'button is all-in on the small blind');
  assert.equal(a.result.pot, 6, 'big blind only risks what the button posted');
  assert.equal(a.stacks[0] + a.stacks[1], 1003);
  const b = new HandState({ stacks: [1000, 4], smallBlind: 5, bigBlind: 10, button: 0 });
  assert.ok(b.finished, 'big blind is all-in for less than the small blind');
  assert.equal(b.result.pot, 8);
  assert.equal(b.stacks[0] + b.stacks[1], 1004);
});

test('split pot divides the chips evenly', () => {
  const h = new HandState({ stacks: [1000, 1000], smallBlind: 5, bigBlind: 10, button: 0, deck: stackedDeck(SPLIT) });
  h.apply({ type: 'raise', to: 1000 });
  h.apply({ type: 'call' });
  assert.equal(h.result.winners.length, 2, 'the board plays for both');
  assert.deepEqual(h.stacks, [1000, 1000]);
});

test('showdown pots are always even heads-up, so a split never has an odd chip', () => {
  const h = new HandState({ stacks: [8, 7], smallBlind: 1, bigBlind: 3, button: 0, deck: stackedDeck(SPLIT) });
  h.apply({ type: 'raise', to: 8 });
  h.apply({ type: 'call' });
  assert.equal(h.result.pot, 14, 'the one uncalled chip was refunded');
  assert.deepEqual(h.stacks, [8, 7]);
  const rng = seededRng(99);
  for (let i = 0; i < 5000; i++) {
    const r = new HandState({ stacks: [1 + rng.int(50), 1 + rng.int(50)], smallBlind: 1, bigBlind: 2, button: rng.int(2), randInt: rng.int });
    while (!r.finished) r.apply({ type: r.legalActions().canCheck ? 'check' : 'call' });
    assert.equal(r.result.pot % 2, 0);
  }
});

test('observation never exposes the deck or opposing hole cards', () => {
  const h = hand();
  const obs = h.observation(1);
  const opp = h.holeCards(0);
  assert.ok(!('deck' in obs));
  assert.ok(!('holes' in obs));
  assert.equal(obs.hole.length, 2);
  assert.ok(!opp.some((c) => obs.hole.includes(c)));
  assert.ok(!Object.keys(h).some((k) => /deck|hole/i.test(k)), 'no enumerable hidden state on the hand object');
  assert.equal(h.observation(0).legal?.canCall, true, 'the player to act gets legal actions');
  assert.equal(obs.legal, null, 'the waiting player does not');
});

test('the shuffle is a uniform permutation of 52 distinct cards', () => {
  const rng = seededRng(7);
  assert.equal(new Set(shuffledDeck(rng.int)).size, 52);
  const pos0 = new Array(52).fill(0);
  for (let i = 0; i < 52000; i++) pos0[shuffledDeck(rng.int)[0]]++;
  for (const n of pos0) assert.ok(Math.abs(n - 1000) < 180, `card frequency ${n} is within tolerance`);
  assert.equal(new Set(shuffledDeck()).size, 52, 'the crypto-backed shuffle works');
});

test('property: random legal play conserves chips, stays legal and always terminates', () => {
  const rng = seededRng(12345);
  let showdowns = 0, folds = 0, allIns = 0;
  for (let i = 0; i < 40000; i++) {
    const s0 = 1 + rng.int(3000), s1 = 1 + rng.int(3000);
    const bb = [2, 10, 20, 100][rng.int(4)], sb = Math.floor(bb / 2);
    const h = new HandState({ stacks: [s0, s1], smallBlind: sb, bigBlind: bb, button: rng.int(2), randInt: rng.int });
    const total = s0 + s1;
    let steps = 0;
    while (!h.finished) {
      assert.ok(++steps < 300, 'hand terminates');
      const l = h.legalActions();
      assert.equal(h.stacks[0] + h.stacks[1] + h.totals[0] + h.totals[1], total, 'chips conserved mid-hand');
      assert.ok(h.stacks[0] >= 0 && h.stacks[1] >= 0, 'no negative stacks');
      assert.ok(l.canCheck || l.canCall, 'a passive option always exists');
      assert.ok(!(l.canFold && l.canCheck), 'never fold when checking is free');
      const opts = [];
      if (l.canFold && rng.next() < 0.3) opts.push({ type: 'fold' });
      if (l.canCheck) opts.push({ type: 'check' });
      if (l.canCall) opts.push({ type: 'call' });
      if (l.canRaise) {
        const w = rng.next();
        const to = w < 0.3 ? l.minRaiseTo : w < 0.5 ? l.maxRaiseTo : l.minRaiseTo + rng.int(l.maxRaiseTo - l.minRaiseTo + 1);
        assert.ok(to > h.currentBet, 'a raise must exceed the current bet');
        opts.push({ type: 'raise', to });
      }
      h.apply(opts[rng.int(opts.length)]);
    }
    assert.equal(h.stacks[0] + h.stacks[1], total, 'chips conserved at settlement');
    assert.equal(h.result.net[0] + h.result.net[1], 0, 'zero-sum');
    assert.ok(Math.abs(h.result.net[0]) <= Math.min(s0, s1), 'nobody moves more than the effective stack');
    if (h.result.reason === 'showdown') { showdowns++; assert.equal(h.board.length, 5); } else folds++;
    if (h.stacks[0] === 0 || h.stacks[1] === 0) allIns++;
  }
  assert.ok(showdowns > 1000 && folds > 1000 && allIns > 1000, `coverage: ${showdowns} showdowns, ${folds} folds, ${allIns} all-ins`);
});

test('match: button alternates, blinds rise on schedule, and a winner is declared', () => {
  const m = new Match({ startingStack: 100, blinds: [{ small: 1, big: 2 }, { small: 2, big: 4 }], handsPerLevel: 2, randInt: seededRng(3).int });
  const h1 = m.nextHand(); assert.equal(h1.button, 0); assert.equal(h1.bigBlind, 2);
  m.act({ type: 'fold' });
  assert.deepEqual(m.stacks, [99, 101]);
  const h2 = m.nextHand(); assert.equal(h2.button, 1); assert.equal(h2.bigBlind, 2);
  m.act({ type: 'fold' });
  assert.deepEqual(m.stacks, [100, 100], 'seat 1 was the button, so it lost only the small blind');
  const h3 = m.nextHand(); assert.equal(h3.button, 0); assert.equal(h3.bigBlind, 4, 'level 2');
  m.act({ type: 'raise', to: h3.legalActions().maxRaiseTo });
  m.act({ type: 'call' });
  assert.equal(m.stacks[0] + m.stacks[1], 200);
  const expected = m.stacks[0] === m.stacks[1] ? null : (m.stacks[0] > m.stacks[1] ? 0 : 1);
  assert.equal(m.winner(), expected);
});

test('match: a chip goal ends the match early', () => {
  const m = new Match({ startingStack: 100, blinds: [{ small: 5, big: 10 }], goalStack: 115, randInt: seededRng(5).int });
  m.nextHand();
  m.act({ type: 'raise', to: 20 }); m.act({ type: 'fold' }); // seat 0 is the button and wins the 10 big blind
  assert.equal(m.winner(), null);
  m.nextHand();
  m.act({ type: 'fold' });  // seat 1 button folds: seat 0 wins 5 more
  assert.equal(m.stacks[0], 115);
  assert.equal(m.winner(), 0);
  assert.throws(() => m.nextHand(), /Match is over/);
});
