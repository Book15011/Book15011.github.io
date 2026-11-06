# Training the blueprint

Everything here runs offline on Linux. The website never needs this machine.

## Hardware used

- AMD EPYC 7542, 16 cores available, of which training used 12 at low priority (`nice -n 10`)
- 50 GB RAM, of which the largest run used under 5 GB
- No GPU. The machine's RTX 4090 was busy with another job, and tabular CFR does not benefit from it anyway

## Setup

```bash
cd research/trainer
g++ -std=c++17 -Ofast -march=native -pthread -o abstract abstract.cpp
g++ -std=c++17 -Ofast -march=native -pthread -o train train.cpp
```

The only dependency is a C++17 compiler. Check the evaluator first:

```bash
./abstract check
```

It enumerates all 133,784,560 seven-card hands, compares the category counts against the known values, and prints a hash you can compare with the JavaScript evaluator's (`POKER_SLOW=1 node --test tests/evaluator.test.js`).

## Step 1: card abstraction

```bash
./abstract gen 2000 5000 5000 12 data
```

This takes about 10 minutes on 12 cores and produces one bucket per hand per canonical board (suit symmetry reduces the boards to 1,755 flops, 16,432 turns and 134,459 rivers).

| Street | Buckets | Features | Distance |
|---|---|---|---|
| Preflop | 169 | Exact starting-hand classes | None needed |
| Flop | 2,000 | 20-bin histogram of final equity vs a random hand, as a CDF | L2 on the CDF, standing in for earth mover's distance |
| Turn | 5,000 | Same | Same |
| River | 5,000 | Equity vs 8 opponent-hand clusters, plus overall equity | L2 |

To compute these quickly, one pass over a complete board scores all 1,081 remaining hands, sorts them, and sweeps once to get every hand's equity with card removal. So the flop street costs about 1.9M passes, not a trillion hand comparisons.

This is imperfect recall: a hand's bucket on the river doesn't remember its bucket on the flop. [Johanson et al. 2013](https://poker.cs.ualberta.ca/publications/AAMAS13-abstraction.pdf) found that this outperforms perfect recall at a given size.

## Step 2: Monte Carlo CFR

```bash
./train run <depthBB> data <outDir> <threads> <minutes> <seed>
```

The algorithm is external-sampling MCCFR, with the improvements Pluribus used:

- **Deal first, then traverse.** Each iteration samples a full deal and updates one player's regrets. Opposing actions are sampled, and the traverser's actions are all explored.
- **Linear CFR discounting.** During the first 15% of the run, regrets and average strategies are periodically multiplied by `t / (t + 1)`, which fades out the poor early iterations.
- **Regret-based pruning.** After 10% of the run, actions that have lost about 300 full stacks of regret are skipped on 95% of iterations.
- **Average strategy** is accumulated on preflop and flop, the only streets exported. Turn and river keep regrets only, which saves memory.
- **Lock-free threads.** All threads update shared arrays with no locks. Occasional lost updates are harmless to convergence and well worth the speed.

Bet sizes:

| Street | First bet (fraction of pot) | Raises | Always available |
|---|---|---|---|
| Preflop | Opens to 2, 2.5, 3 (and 4 when 40bb or deeper) big blinds | 3-bets and 4-bets by multiples | All-in |
| Flop | 0.25, 0.5, 0.75, 1.25 | 0.6, 1.0 | All-in |
| Turn | 0.33, 0.66, 1.0 | 0.7 | All-in |
| River | 0.33, 0.66, 1.25 | 0.7 | All-in |

Preflop menus shrink at shorter depths.

The driver script is `research/scripts/train_all.sh`. It trains the depths one after another, exports each one, and records a convergence measurement. See [BENCHMARKS.md](BENCHMARKS.md) for runtimes and results.

## Step 3: measure convergence

```bash
./train br <depthBB> data <checkpoint> <threads> <samples>
```

This estimates how much a best-responding opponent could win inside the abstract game. It learns the best action per information set on one batch of samples, then measures that fixed policy on fresh samples, so it isn't inflated by overfitting to its own batch.

Note the limits. It is a sampled estimate, it applies only to the abstract game, and on a very large tree it can undercount, because rare situations are visited too seldom. It is a progress signal rather than a true exploitability. Local Best Response measures the real game, and I report it separately.

## Step 4: export

```bash
./train export <depthBB> data <checkpoint> bp_<depth>.bin         # preflop and flop: this ships
./train export <depthBB> data <checkpoint> bp_<depth>_full.bin full   # all streets: benchmarks only
gzip -9 bp_<depth>.bin
```

Each probability is stored as a byte, rounded so each row sums to exactly 255. The export keeps only preflop and flop, because the browser solves the turn and river itself. That is what keeps the download small.

## The live solver

```bash
pip install ziglang
PYTHON=python3 bash research/solver/build.sh
```

This produces `solver.wasm` (about 50 KB) from `research/solver/solver.c`, using `zig cc` as a self-contained clang. No Emscripten or system toolchain is required.

## Reproducing the benchmarks

All benchmark code lives in `research/bench` and imports the same JavaScript the browser runs. Seeds are command-line arguments.

```bash
cd research/bench
node baseline_check.js 2000 100                                     # hand-written bot ladder
node expert_check.js <bpDir> <dataDir> 20 20 strong 2000 20 150 1   # Expert vs one opponent
node lbr.js expert <bpDir> <dataDir> 100 100 2000 20 150 1          # Local Best Response
node slumbot.js <bpDir> <dataDir> 5000 20 150 slumbot.jsonl 1       # Slumbot, over its public API
```

## What stays out of the repository

Checkpoints, full tables and bucket tables for the turn and river stay on the training machine. Only `poker/models/` (the preflop and flop tables and the flop bucket table) is committed.
