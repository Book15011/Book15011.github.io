import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, categoryOf, categoryName, FULL_HOUSE, FLUSH, STRAIGHT, STRAIGHT_FLUSH, TWO_PAIR, QUADS, PAIR, HIGH_CARD, TRIPS } from '../js/engine/evaluator.js';
import { parseCards } from '../js/engine/cards.js';

const ev = (s) => evaluate(parseCards(s));

test('5-card category counts match the known exhaustive frequencies', () => {
  const counts = new Array(9).fill(0);
  const h = [0, 0, 0, 0, 0];
  for (h[0] = 0; h[0] < 48; h[0]++) for (h[1] = h[0] + 1; h[1] < 49; h[1]++) for (h[2] = h[1] + 1; h[2] < 50; h[2]++)
    for (h[3] = h[2] + 1; h[3] < 51; h[3]++) for (h[4] = h[3] + 1; h[4] < 52; h[4]++) counts[categoryOf(evaluate(h))]++;
  assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
});

test('7-card category counts match the known exhaustive frequencies', { skip: !process.env.POKER_SLOW && 'set POKER_SLOW=1 to run all 133,784,560 hands' }, () => {
  const counts = new Array(9).fill(0);
  const h = new Int32Array(7);
  let hash = 0;
  for (h[0] = 0; h[0] < 46; h[0]++) for (h[1] = h[0] + 1; h[1] < 47; h[1]++) for (h[2] = h[1] + 1; h[2] < 48; h[2]++)
    for (h[3] = h[2] + 1; h[3] < 49; h[3]++) for (h[4] = h[3] + 1; h[4] < 50; h[4]++) for (h[5] = h[4] + 1; h[5] < 51; h[5]++)
      for (h[6] = h[5] + 1; h[6] < 52; h[6]++) { const v = evaluate(h); counts[v >> 20]++; hash = (Math.imul(hash, 31) + v) | 0; }
  assert.deepEqual(counts, [23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584]);
  console.log(`7-card score hash (compare with: research/trainer/abstract check): ${hash >>> 0}`);
});

test('category detection on hand-picked 7-card hands', () => {
  assert.equal(categoryOf(ev('As Ks Qs Js Ts 2d 3c')), STRAIGHT_FLUSH);
  assert.equal(categoryOf(ev('5s 4s 3s 2s As Kd Qc')), STRAIGHT_FLUSH, 'steel wheel');
  assert.equal(categoryOf(ev('9c 9d 9h 9s 2c 3d 4h')), QUADS);
  assert.equal(categoryOf(ev('9c 9d 9h 2s 2c 3d 4h')), FULL_HOUSE);
  assert.equal(categoryOf(ev('9c 9d 9h 2s 2c 2d 4h')), FULL_HOUSE, 'two sets of trips');
  assert.equal(categoryOf(ev('Ac Kc 9c 5c 2c 3d 4h')), FLUSH);
  assert.equal(categoryOf(ev('Ac 2d 3h 4s 5c 9d Jh')), STRAIGHT, 'wheel');
  assert.equal(categoryOf(ev('9c 9d 9h 2s 5c 7d Kh')), TRIPS);
  assert.equal(categoryOf(ev('9c 9d 2h 2s 5c 7d Kh')), TWO_PAIR);
  assert.equal(categoryOf(ev('9c 9d 3h 2s 5c 7d Kh')), PAIR);
  assert.equal(categoryOf(ev('Ac 9d 3h 2s 5c 7d Kh')), HIGH_CARD);
  assert.equal(categoryName(ev('9c 9d 3h 2s 5c 7d Kh')), 'Pair');
});

test('ordering and kicker edge cases', () => {
  assert.ok(ev('Ac 2d 3h 4s 5c Kd Qh') < ev('2d 3h 4s 5c 6h Kd Qh'), 'the wheel is the lowest straight');
  assert.ok(ev('Ah Ad Kc Qs Js 2c 3d') > ev('Ah Ad Kc Qs Ts 2c 3d'), 'pair kicker decides');
  assert.equal(ev('Ah Ad Kc Qs Js 2c 3d'), ev('As Ac Kh Qd Jc 3s 2h'), 'identical best five tie');
  assert.equal(ev('Kh Kd 9c 9s 7h 7d 2c'), ev('Kc Ks 9h 9d 7s 7c 3d'), 'a third pair only counts as the kicker');
  assert.ok(ev('Kh Kd 9c 9s Ah 7d 2c') > ev('Kh Kd 9c 9s 7h 7d 2c'), 'ace kicker beats seven kicker');
  assert.ok(ev('Th Td Tc 9s 9h 9d 2c') > ev('Th Td Tc 8s 8h 8d 2c'), 'higher second set wins the full house');
  assert.ok(ev('2c 2d 2h 2s Ac 3d 4h') > ev('2c 2d 2h 2s Kc Qd Jh'), 'quads kicker decides');
  assert.ok(ev('Tc 9c 8c 7c 6c Ad Kh') > ev('Ac Kc Qc Jc 9c Td 8h'), 'straight flush beats ace-high flush');
  assert.ok(ev('As Ks Qs Js 9s 3s 4d') > ev('As Ks Qs Js 8s 3s 4d'), 'flush uses the five best suited cards');
});
