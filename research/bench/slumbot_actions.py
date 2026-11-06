"""Breaks down the Slumbot hand logs by who did what on each street, to find where the chips were lost.

Slumbot's action string has one segment per street. k = check, c = call, f = fold, bN = bet or raise to N
chips in total on that street. Blinds are 50/100 and stacks 20,000. pos 1 means we were the small blind (button).

Usage: python slumbot_actions.py <slumbot_*.jsonl> ...
"""
import json
import re
import sys
from collections import defaultdict

STACK, SB, BB = 20000, 50, 100
STREETS = ['preflop', 'flop', 'turn', 'river']


def parse(hand):
    """Yields (street, actor, kind, potFraction, allIn) for every action; actor 0 = us, 1 = Slumbot."""
    us_sb = hand['pos'] == 1
    seat_of = {'sb': 0 if us_sb else 1, 'bb': 1 if us_sb else 0}
    prior = 0  # chips each player had in before this street (equal at the start of every street)
    out = []
    for s, seg in enumerate(hand['action'].split('/')):
        bets = {seat_of['sb']: SB, seat_of['bb']: BB} if s == 0 else {0: 0, 1: 0}
        actor = seat_of['sb'] if s == 0 else seat_of['bb']
        for tok in re.findall(r'b\d+|[kcf]', seg):
            other = 1 - actor
            pot = 2 * prior + bets[0] + bets[1]
            if tok[0] == 'b':
                to = int(tok[1:])
                frac = (to - bets[actor]) / pot
                kind = 'raise' if bets[other] > (BB if s == 0 else 0) else ('open' if s == 0 else 'bet')
                bets[actor] = to
                out.append((s, actor, kind, frac, prior + to >= STACK))
            elif tok == 'c':
                bets[actor] = bets[other]
                out.append((s, actor, 'call', 0, prior + bets[actor] >= STACK))
            else:
                out.append((s, actor, 'check' if tok == 'k' else 'fold', 0, False))
            actor = other
        prior += bets[0] if bets[0] == bets[1] else min(bets.values())
    return out


hands = []
for path in sys.argv[1:]:
    with open(path, encoding='utf-8') as f:
        hands += [json.loads(line) for line in f if line.startswith('{')]
n = len(hands)
total = sum(h['winnings'] for h in hands)
print(f'{n} hands, {total / BB / n * 100:+.1f} bb/100 overall')

for pos, name in [(1, 'small blind (button)'), (0, 'big blind')]:
    hs = [h for h in hands if h['pos'] == pos]
    print(f'  as {name}: {len(hs)} hands, {sum(h["winnings"] for h in hs) / BB / len(hs) * 100:+.1f} bb/100')

# Aggression profile per street: share of decisions that were a bet/raise, and how many of those were all-in.
print('\nAggression by street (share of each player\'s actions)')
print(f'{"street":8} {"who":8} {"actions":>8} {"bet/raise":>10} {"all-in":>8} {"median size":>12}')
for s in range(4):
    for who, label in [(0, 'Expert'), (1, 'Slumbot')]:
        acts = [a for h in hands for a in parse(h) if a[0] == s and a[1] == who]
        aggr = [a for a in acts if a[2] in ('bet', 'raise', 'open')]
        shoves = [a for a in aggr if a[4]]
        sizes = sorted(a[3] for a in aggr)
        med = sizes[len(sizes) // 2] if sizes else 0
        print(f'{STREETS[s]:8} {label:8} {len(acts):8} {len(aggr) / max(1, len(acts)):10.1%} {len(shoves) / max(1, len(acts)):8.1%} {med:11.2f}x')

# Where the chips went: group hands by the street and type of our last aggressive action.
print('\nResult by our last aggressive action (bb/100 contribution to the overall rate)')
groups = defaultdict(list)
for h in hands:
    acts = parse(h)
    ours = [a for a in acts if a[1] == 0 and a[2] in ('bet', 'raise', 'open')]
    if not ours:
        key = 'never bet or raised'
    else:
        a = ours[-1]
        key = f'{STREETS[a[0]]} {"all-in" if a[4] else a[2]}'
    groups[key].append(h['winnings'])
for key, ws in sorted(groups.items(), key=lambda kv: sum(kv[1])):
    print(f'  {key:24} {len(ws):5} hands  {sum(ws) / BB / n * 100:+7.1f}  (avg {sum(ws) / len(ws) / BB:+.1f} bb/hand)')

# Turn and river shoves in detail: were they bluffs or value, and how did they do?
print('\nOur postflop all-ins')
for h in hands:
    for a in parse(h):
        if a[1] == 0 and a[4] and a[2] in ('bet', 'raise') and a[0] >= 2:
            print(f'  #{h["n"]:5} {STREETS[a[0]]:5} {a[2]:5} {a[3]:5.2f}x pot  hole={"".join(h["hole"])} board={" ".join(h["board"])} '
                  f'bot={"".join(h.get("bot") or ["??"])}  {h["winnings"] / BB:+.0f} bb  {h["action"]}')
