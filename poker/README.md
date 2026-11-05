# Can You Beat My Poker AI?

A heads-up No-Limit Texas Hold'em game you can play in the browser, against an AI that was trained by self-play and that solves the turn and river live on your device. There is no server, no sign-up and no paid API. Virtual chips only.

**[Play it](https://book15011.github.io/quant.html#poker)** · **[How it works](https://book15011.github.io/poker/how-it-works.html)** · **[Benchmarks](../docs/BENCHMARKS.md)**

## What's interesting about it

Poker is a hard kind of AI problem because you can't see the other player's cards. The Expert bot uses the approach behind [Pluribus](https://noambrown.github.io/papers/19-Science-Superhuman.pdf) and [Modicum](https://arxiv.org/abs/1805.08195), on a budget:

- **Trained offline** with Monte Carlo counterfactual regret minimization (C++, multithreaded, CPU only).
- **Solves live** with vector-form Discounted CFR, compiled from C to about 50 KB of WebAssembly, running in a Web Worker.
- **Can't cheat by construction.** The engine runs on the page and posts the AI only its own observation.
- **Explains itself.** After each hand you can see its action probabilities, equity estimate and the range of hands it put you on, labelled as model estimates.

## Quality checks

- The hand evaluator matches the known counts for all 133,784,560 seven-card hands.
- The solver reproduces the exact solution of a river game with a known answer.
- Property tests check chip conservation and legal play over tens of thousands of random hands.
- Browser tests play full matches through the real buttons in Chrome, at desktop and phone sizes.
- Strength was tested against [Slumbot](https://slumbot.com), an independent competition winner, and with Local Best Response.

## Run it

```bash
# From the repository root: any static file server will do
python -m http.server 8000
# Then open http://localhost:8000/poker/
```

```bash
# Unit and property tests (Node 22 or newer, no dependencies)
cd poker
npm test
```

```bash
# Browser tests (Python, Playwright and an installed Chrome)
pip install playwright
python research/e2e/test_e2e.py http://localhost:8000
```

## Documentation

| Document | Contents |
|---|---|
| [AI_EXPLAINED.md](../docs/AI_EXPLAINED.md) | How the AI works, in plain language, and what is approximate |
| [ARCHITECTURE.md](../docs/ARCHITECTURE.md) | Code layout and design decisions |
| [RESEARCH.md](../docs/RESEARCH.md) | Literature review and why this approach |
| [TRAINING.md](../docs/TRAINING.md) | How to reproduce the training |
| [BENCHMARKS.md](../docs/BENCHMARKS.md) | Every measured result, with confidence intervals and limitations |

## Limitations

The AI approximates an equilibrium of a simplified game. It does not adapt to individual opponents and has not been tested against professional players. See [BENCHMARKS.md](../docs/BENCHMARKS.md) for what the numbers do and don't show.

## Provenance

All code and models here were written or trained for this project. The bots and papers cited in [RESEARCH.md](../docs/RESEARCH.md) were read for ideas, and no third-party code or weights are included. The training data is entirely self-play, with no human hand histories.
