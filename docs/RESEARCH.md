# Poker AI research notes

What I read before choosing an architecture, what the evidence says, and what I decided.

Figures below were checked against the source PDFs or repositories on 5 November 2026, unless marked otherwise. "mbb/g" is thousandths of a big blind per hand; 10 mbb/g equals 1 bb/100.

## The short version

For heads-up No-Limit Hold'em running on a visitor's device with no server, the strongest practical design is the **blueprint plus real-time search** recipe from Modicum, Libratus and Pluribus:

1. Train a strategy offline with Monte Carlo CFR on an abstracted game. Ship only the preflop and flop tables.
2. On the turn and river, solve the rest of the hand live in the browser, using the ranges implied by the blueprint.

Modicum is the key precedent. Its authors built a master-level agent with **700 core hours and 16 GB of RAM** that ran on **a 4-core CPU**, and it beat both Slumbot and Baby Tartanian8. Those opponents took about 250,000 and 2 million core hours to compute. Search buys back most of what a small abstraction gives up.

## Landmark systems

| System | Year | Game | Method | Published result | Compute |
|---|---|---|---|---|---|
| [DeepStack](https://arxiv.org/abs/1701.01724) | 2017 | HUNL | Continual re-solving with counterfactual value networks | 492 mbb/g over 44,852 hands against 33 players; LBR found no positive bound under its tested action sets | Turn net: 10M solved games, over 175 core years on 6,144 cores. Re-solves under 5 s on a GTX 1080 |
| [Libratus](https://noambrown.github.io/papers/17-Science-Superhuman.pdf) | 2017 | HUNL | Blueprint, nested subgame solving, self-improvement | Beat four top professionals over 120,000 hands. 147 ± 39 mbb/g as tabulated in the ReBeL paper | Supercomputer |
| [Modicum](https://arxiv.org/abs/1805.08195) | 2018 | HUNL | Blueprint plus depth-limited solving | 11 ± 5 vs Slumbot, 6 ± 3 vs Baby Tartanian8 (as tabulated in ReBeL) | 700 core hours, 16 GB, 4-core CPU in play, about 20 s per hand |
| [Pluribus](https://noambrown.github.io/papers/19-Science-Superhuman.pdf) | 2019 | 6-max NL | MCCFR blueprint plus depth-limited search | 48 mbb/g (SE 25) with five pros and itself; 32 mbb/g (SE 15) with five copies against one pro | 12,400 core hours, under 512 GB, no GPUs. Plays on 2 CPUs, under 128 GB |
| [ReBeL](https://arxiv.org/abs/2007.13544) | 2020 | HUNL | Self-play RL over public belief states | 45 ± 5 vs Slumbot, 9 ± 4 vs Baby Tartanian8, 165 ± 69 vs Dong Kim, LBR 881 ± 94 (calling for two rounds) | 90 DGX-1 machines, each with 8 V100 GPUs, for data generation |
| [Supremus](https://arxiv.org/abs/2007.10442) | 2020 | HUNL | Improved DeepStack with DCFR+ | 176 ± 44 vs Slumbot over 150,000 hands. Its DeepStack reimplementation lost 63 ± 40 | Large cluster |
| [AlphaHoldem](https://ojs.aaai.org/index.php/AAAI/article/view/20394) | 2022 | HUNL | End-to-end self-play RL, no search | 111.56 mbb/h vs Slumbot, 16.91 vs DeepStack (200,000 hands) | Three days on one PC, 6.5B samples. 2.9 ms per decision on a GPU |
| [DecisionHoldem](https://arxiv.org/abs/2201.11580) | 2022 | HUNL | Linear CFR blueprint plus safer depth-limited solving | Above 730 mbb/h vs Slumbot over about 20,000 hands (self-reported) | 4,000 core hours, 48 cores |
| [Deep CFR](https://arxiv.org/abs/1811.00164) | 2019 | Flop hold'em, limit hold'em | Neural regret approximation | Evaluated on smaller games, not on No-Limit in the paper | Network of 98,948 parameters |

Things worth noticing:

- **Results vary by order of magnitude, and reimplementation is hard.** A reimplementation of DeepStack lost to Slumbot while being unexploitable by LBR. Head-to-head results and exploitability measure different things.
- **Self-reported numbers need care.** DecisionHoldem's 730 mbb/h against Slumbot is far above ReBeL's 45 ± 5. Slumbot may also have changed over time. I treat these as rough, not as a ranking.
- **Slumbot is not a weak target.** It won the 2018 Annual Computer Poker Competition and took about 250,000 core hours and 2 TB to compute.

## The competition bots you pointed me to

These are useful mostly because of how much they differ from the research systems. Each one fits its own contest's rules.

- **[Fro116/Pokerbots](https://github.com/Fro116/Pokerbots)** (MIT Pokerbots 2017, winner per its README). CFR on a *Discard Hold'em* variant with 169 preflop and 100 postflop buckets, plus careful off-tree handling. Close to my approach in spirit, at a far smaller scale. No license is declared, so I read it but used no code.
- **[HPI-Poker/competition-2025-winners](https://github.com/HPI-Poker/competition-2025-winners)**. I read the winner's main bot, "Der Graph von Monte Carlo". It is **not CFR at all**. It plays Monte Carlo equity thresholds with a fast evaluator, plus a rule that folds everything once its lead can no longer be overturned in the remaining rounds. It won by exploiting that format, not by general strength.
- **[txnujk09/fullhouse-poker-bot](https://github.com/txnujk09/fullhouse-poker-bot)** (top 64, 6-max). Built a from-scratch MCCFR preflop solver and then *did not ship it*, because it only tied a simple baseline with a one-line fix. Its "measure, don't assert" gating influenced my benchmark rules.
- **[advitrocks9/fullhouse-bot](https://github.com/advitrocks9/fullhouse-bot)** (12th of 500+, 15th of 64 in the final, 6-max). Deep CFR with a 51-feature net and pure-NumPy inference. Its experiment ledger has a clear lesson: growing the action menu without growing the training budget starved the policy, and only representation changes beat the baseline. It also reports results against a held-out pool, which I copied.
- **[Sequoia "No Limit" tournament](https://pokerbot.sequoiacap.com/)**. The rules specify 8-bot sit-and-gos, a one-millisecond decision limit and a 100 MB file limit. The regional events start on 6 November 2026, so **there are no winners to study yet**. A 1 ms limit rules out search entirely, so it is a very different problem from mine.

## Approaches compared for this project

Hardware: 12 of 16 EPYC cores and 50 GB RAM (shared). The RTX 4090 is busy with another job and has about 7 GB free. The final AI must run on a visitor's laptop or phone with no server.

| | Tabular MCCFR only | **MCCFR + live solving** | Deep CFR / neural policy | DeepStack-style value nets | ReBeL / self-play RL |
|---|---|---|---|---|---|
| Expected strength | Good, exploitable by unusual bet sizes | **High**: Modicum beat top agents | Unknown at this budget; little published for HUNL | Very high, if the nets are good | Very high |
| Feasible here | Yes | **Yes** | Partly (GPU is busy) | No: over 175 core years for the turn net alone | No: 90 multi-GPU machines |
| Development complexity | Medium | **High** | High | Very high | Very high |
| Offline training | Hours | **Hours** | Days | Core-years | Machine-years |
| Runtime latency | Instant | **About 1 to 2 s, in a worker** | Milliseconds | Seconds with a GPU | Seconds with a GPU |
| Artifact size | Very large if all streets ship | **Small: preflop and flop only** | Small to medium | Medium | Medium |
| Static browser deployment | Yes, if the tables are small | **Yes**, WebAssembly | Yes | Hard without a GPU | Hard without a GPU |
| Handles any bet size | Poorly (translation only) | **Well on later streets** | Poorly | Well | Well |
| Licensing risk | None, own code | **None, own code** | None | None | None |

The decisive factors:

- **A human can bet any amount with a slider.** Translation-only bots are known to be exploitable by this ([Ganzfried & Sandholm 2013](https://www.cs.cmu.edu/~sandholm/reverse%20mapping.ijcai13.pdf)), while subgame solving responds to the exact size ([Brown & Sandholm 2017](https://arxiv.org/abs/1705.02955)).
- **Shipping tables for later streets is wasteful.** The river has about 123M hand-and-board combinations under suit symmetry. Solving instead of storing shrinks the download by more than a hundred times.
- **A neural policy is not obviously better.** [AlphaHoldem](https://ojs.aaai.org/index.php/AAAI/article/view/20394) shows pure RL can work, but with 6.5B samples and GPU training, on a machine I would have to share. The Fullhouse repositories show neural and tabular both tying simple baselines when underfunded. I chose not to train a network just to say the project uses one.

## Techniques I adopted, and where they come from

- **External-sampling Monte Carlo CFR with Linear CFR discounting and regret-based pruning**, the recipe in the Pluribus paper. Actions with very negative regret are skipped in 95% of iterations.
- **Discounted CFR with α = 3/2, β = 0, γ = 2** for live solving. The [DCFR paper](https://arxiv.org/abs/1809.04040) reports these parameters were consistently stronger than CFR+.
- **Imperfect-recall k-means card abstraction**: earth-mover-style histograms on the flop and turn, and Opponent Cluster Hand Strength on the river, from [Johanson et al. 2013](https://poker.cs.ualberta.ca/publications/AAMAS13-abstraction.pdf). [Ganzfried & Sandholm 2014](https://www.cs.cmu.edu/~sandholm/potential-aware_imperfect-recall.aaai14.pdf) report that potential-aware clustering does better still. I did not implement that, and it is a clear next step.
- **The pseudo-harmonic mapping** for translating unusual bet sizes on preflop and flop.
- **Nested solving with the agent's past actions pinned**, as Pluribus does, so an unusual opposing bet becomes an exact option in the re-solved tree.

## How strength should be measured

- **Beating weak bots proves little.** The DeepStack paper shows that Act1 and Slumbot were within 20 mbb/g head-to-head while Act1 was 1,300 mbb/g less exploitable under LBR.
- **[Local Best Response](https://arxiv.org/abs/1612.07547)** gives a lower bound on exploitability. Published examples include Hyperborean 2014 at 4,675 and Slumbot 2016 at 4,020 under the most damaging action set (from DeepStack's Table 3).
- **Independent, held-out opponents matter most.** Slumbot's [public API](https://slumbot.com/sample_api.py) makes it the natural test.
- **Duplicate deals reduce variance**: each deck is played twice with seats swapped. [AIVAT](https://arxiv.org/abs/1612.06915) does better still, but needs more machinery than I built.

## Recent work checked

- [Parallel CFR (2026)](https://arxiv.org/abs/2605.19928) reports a 3.3 to 3.4× speedup for depth-limited solving using a CPU-GPU pipeline on a DGX Spark. It is a useful direction for desktop solvers. It does not apply to a browser without GPU compute, and it is a preprint.
- I found no newer public HUNL agent with a clearly verified result against the systems above, so I stopped there. That is an absence in what I found, not proof that none exists.

## What this project does not claim

- It is not an equilibrium of full No-Limit Hold'em. The blueprint solves an abstracted game, and the solver handles a subgame with estimated ranges and a limited set of sizes.
- A mid-size blueprint trained for hours is not Libratus or Pluribus, which used far more compute and much finer abstractions.
- It has not been tested against professional players. See [BENCHMARKS.md](BENCHMARKS.md) for what was measured.
