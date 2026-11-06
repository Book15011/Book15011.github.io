# How the Expert AI works

This is the plain-language version. You don't need to know poker theory to follow it.

## Why poker is hard for computers

In chess, both players see the whole board. In poker you can't see the other player's cards, so the right move depends on what they might hold, and what they might hold depends on what they think *you* might hold. No single "best move" exists. A strategy that always bets with good hands and always checks with bad ones is easy to read and easy to beat.

The goal is a strategy that cannot be exploited, even by an opponent who knows exactly how it works. Game theory calls this a Nash equilibrium. Good strategies are therefore *mixed*: with the same cards in the same spot, the AI might sometimes bet and sometimes check, and that randomness is on purpose.

## Step 1: learn by playing itself

The algorithm is **Counterfactual Regret Minimization (CFR)**. The bot plays billions of hands against itself. After each decision it asks: "How much better would I have done with each other action?" That gap is the *regret*. Next time, it plays each action in proportion to how much it regretted not playing it. Averaged over enough hands, this converges toward equilibrium in two-player zero-sum games.

Poker has far too many situations to store, so training uses a simplified version of the game:

- **Similar hands are grouped into buckets.** For each hand on each board, the trainer computes how strong the hand is now and how it might develop, then clusters similar hands together.
- **Only a few bet sizes are considered**, such as a quarter, half, three-quarters and one-and-a-quarter of the pot on the flop.

The result is the **blueprint**: a large table that says how often to take each action in each situation.

## Step 2: think live on the turn and river

Late in a hand the remaining game is small enough to solve properly, so the AI does it on your device. When it reaches the turn or river it:

1. Estimates which hands you could hold, based on how you bet and how the blueprint would have played.
2. Builds a betting tree for the rest of the hand, including the exact bet you just made.
3. Runs Discounted CFR on it for a second or two, in a background thread, so the page stays responsive.
4. Reads the strategy for its actual cards and rolls the dice to pick an action.

The solver works out a strategy for *every* hand it could hold, not just the real one. That is what keeps it balanced: it acts the same way with its bluffs as with its strong hands.

This is the same broad recipe as Pluribus and Modicum, on a much smaller budget.

## What was trained, precomputed and computed live

| Stage | Where | What happens |
|---|---|---|
| Card buckets | Offline | K-means over hand-strength features on every board, using suit symmetry |
| Blueprint | Offline | Monte Carlo CFR self-play, one table per stack depth |
| Exported model | Offline | Preflop and flop strategies only, as one byte per probability, then gzip |
| Range tracking | Live, in the browser | Bayes' rule over 1,326 hole-card combinations, using only public betting |
| Preflop and flop decisions | Live, in the browser | Table lookup, with bet-size translation |
| Turn and river decisions | Live, in the browser | Discounted CFR solve to the end of the hand |

No neural network is involved. I considered one and explain why not in [RESEARCH.md](RESEARCH.md). No LLM is involved at any point, and no data leaves your browser.

## What it optimizes

Chips won in expectation, assuming the opponent plays well. It aims to be hard to exploit rather than to spot your specific mistakes.

**It does not adapt to you.** Pluribus didn't either. A five-minute match gives too few hands to trust a read, and adapting opens the door to being exploited. Against a weak player, this means it wins less than a player who targets weaknesses would. Adaptive play would be a sensible next feature, and the [benchmarks](BENCHMARKS.md) show how much it leaves on the table against simple opponents.

## What is approximate

Being clear about this is the difference between a real result and marketing:

- **The blueprint is an equilibrium of a simplified game**, not of real poker. Hands in one bucket are forced to play alike.
- **Preflop and flop bet sizes are limited.** If you bet a size the tree doesn't have, it treats your bet as a blend of the two nearest ones.
- **Turn and river solving is approximate.** It uses estimated ranges, a limited set of bet sizes, and only as much time as your device allows. On a phone it runs fewer iterations.
- **It is "unsafe" in the technical sense.** Solving from estimated ranges has no worst-case guarantee, though in practice this kind of solving tends to work well ([Brown & Sandholm 2017](https://arxiv.org/abs/1705.02955)).
- **It has not been tested against professional players.** I would not claim it plays at a professional level.

## Reading the review panel

After each hand, **Why did the AI do that?** shows each decision it made:

- **Trained strategy** or **Live solve** says where the numbers came from.
- **Pot odds** is how much equity a call needed.
- **Equity est.** is how often it expected to win at showdown against the hands it thought you held. This is an estimate that depends on its model of you.
- **Bars** are its actual probabilities. The green bar is what it rolled.
- **Value numbers**, on live solves, are its estimated chip value for each option in its model.
- **The grid** shows the hands it thought you could hold. Brighter means more likely.

The panel stays locked until the hand ends, so it can never leak the AI's cards while they matter. These numbers explain what the AI computed. They don't prove a move was correct.
