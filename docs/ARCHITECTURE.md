# Architecture

The project has two separate halves. Heavy training happens once, offline, on a Linux machine. Everything a visitor needs then runs in their browser, with no server and no paid API.

```
Remote training machine (12 CPU cores, no GPU used)
    |
    |  research/trainer: card abstraction, Monte Carlo CFR self-play
    v
Strategy tables, one per stack depth
    |
    |  Export preflop and flop only, quantised to bytes, gzipped
    v
poker/models/*.bin.gz and poker/js/ai/solver.wasm
    |
    |  GitHub Pages serves them as static files, loaded lazily
    v
Browser
    ├── Main thread: rules engine, table UI, controls, history, AI review
    └── Web Worker: blueprint lookups, live solver (only ever gets the AI's observation)
```

## Repository layout

| Path | What it is |
|---|---|
| `quant.html` | Portfolio page. Adds a section and a floating button that open the game in a modal |
| `poker/index.html` | Full-page version of the game |
| `poker/how-it-works.html` | Plain-language write-up with benchmark results |
| `poker/js/engine/` | Rules engine and hand evaluator. No dependency on UI or AI |
| `poker/js/ai/` | Bots, blueprint reader, range tracking, solver front end, worker, model loading |
| `poker/js/ui/` | Game flow, rendering and the modal launcher |
| `poker/models/` | Deployed strategy artifacts |
| `poker/tests/` | Unit and property-based tests (`node --test`) |
| `research/trainer/` | C++: abstraction generator and MCCFR trainer |
| `research/solver/` | C: the live solver, compiled to WebAssembly |
| `research/bench/` | Benchmarks. These import the same JS that ships to the browser |
| `research/e2e/` | Browser tests driving real Chrome |

There is no build step for the website. The site is plain HTML and CSS with hand-written ES modules, which matches how the rest of the portfolio works. JavaScript files carry JSDoc types and `// @ts-check`, so type checking stays available without adding a compiler to a static site. The one compiled artifact is `solver.wasm`, and its source and build script are in the repository.

## Poker engine (`poker/js/engine`)

`game.js` holds the rules for one hand (`HandState`) and for a match (`Match`). All chips are integers.

- The button posts the small blind and acts first preflop. The big blind acts first on later streets.
- A raise must add at least the size of the last bet or raise. An all-in for less is allowed, and heads-up it can never reopen the betting, because the only opponent is the one who just went all-in.
- Chips above what the opponent can match are refunded before settlement. This also means heads-up showdown pots are always even, so a split can never leave an odd chip. A test asserts this.
- If a blind puts a player all-in, the board runs out with no action.

Hidden information lives in JavaScript private fields (`#deck`, `#holes`). The only thing an agent receives is `observation(seat)`, which contains no deck and no opposing cards. In the browser this boundary is stronger still: the AI is in a separate worker, and the engine posts it only that observation.

The shuffle is Fisher-Yates over `crypto.getRandomValues` with rejection sampling, so there is no modulo bias.

`evaluator.js` scores 5 to 7 cards from four 13-bit suit masks. It matches the known counts for all 133,784,560 seven-card hands. The C++ evaluator used for training uses the same formula, and the two produce the same hash over all those hands.

## The AI

### Three difficulties

| Level | How it decides | Download |
|---|---|---|
| Casual | Hand-written rules that over-call and rarely bluff | None |
| Competitive | Hand-written rules using equity, position, board texture and mixing | None |
| Expert | Trained blueprint plus live solving | See [BENCHMARKS.md](BENCHMARKS.md) |

### Expert: preflop and flop

`Blueprint` reads a table of probabilities per (betting line, card bucket, action). `BlueprintWalker` follows the real hand through the abstract tree. As it goes, it tracks both players' ranges by Bayes' rule over all 1,326 hole-card combinations, using only public actions.

Real bet sizes rarely match the tree exactly. Raises are translated with the [pseudo-harmonic mapping](https://www.cs.cmu.edu/~sandholm/reverse%20mapping.ijcai13.pdf), weighting the two nearest sizes. If the hand leaves the tree completely, a labelled pot-odds fallback takes over until the turn.

The table for the stack depth nearest the effective stack is used, chosen by ratio and downloaded on demand.

### Expert: turn and river

`RealtimeSolver` builds a betting tree for the rest of the current street (plus every river, when on the turn) and solves it live with vector-form Discounted CFR.

- The opening ranges come from the blueprint on the turn, and from the turn solve along the real betting line on the river.
- A small share of the earlier range always survives, so an unexpected line can never empty a range.
- The opponent's actual bet size is added to the tree as an exact option.
- The AI's own earlier actions on the street are pinned to the strategy it actually used, as Pluribus does.
- If the next action is already in the solved tree, the existing solution is reused, topped up to the iteration target if the time budget cut it short.
- **It thinks on your time.** While you decide on the turn or river, the worker keeps iterating the current tree in 40 ms slices, up to 300 turn or 600 river iterations, and stops as soon as any message arrives. If your action is in the tree (check, call, fold, or the ½-pot, pot and all-in buttons as a first bet), its reply starts from that work. Its own earlier decisions on the tree are pinned first, so extra iterations cannot change what it already played. The worker still sees only its own observation. Short solves leave the Expert too aggressive on the turn (see [BENCHMARKS.md](BENCHMARKS.md#turn-aggression-and-solve-length)), so this matters most for strength, not speed.

The solver core (`research/solver/solver.c`) updates every hand in the range in one pass, computing showdowns in O(hands) using sorted hand strength with a card-removal correction. It compiles to about 50 KB of WebAssembly with SIMD.

Everything here is approximate, and the review panel says so. See [AI_EXPLAINED.md](AI_EXPLAINED.md).

## Web application (`poker/js/ui`)

`mountPokerGame(container, options)` renders the whole game into any element. Both the modal on the Quant page and the full page use it. Styles are scoped by a `pk-` prefix and sizing uses container queries, so the same layout works in a modal or a full page and on a phone.

Portfolio integration costs almost nothing until someone asks for it. `quant.html` gains one section, one floating button and one short module script. The game's code, CSS and models load only after a click.

## Match formats

- **Quick match:** 2,000 chips each, blinds start at 50/100 and rise every 5 hands, first to 3,000 chips wins. This is the default, built for someone taking a short break from reading a CV.
- **Deep stacks:** 100 big blinds each, flat blinds, play until someone is out of chips. This is the serious mode.

## Main risks and how they were handled

| Risk | Response |
|---|---|
| Rules bugs | Exhaustive evaluator check, unit tests on each heads-up edge case, property tests over tens of thousands of random hands |
| The AI playing an illegal action | Fuzz tests. The engine rejects illegal actions and the UI falls back safely if one ever appears |
| The solver being wrong | Test against a toy game with a known exact solution, plus exploitability measurement inside the solver |
| Slow turn solves on phones | Time budget with a minimum iteration count, in a worker. Tested alternatives are in [BENCHMARKS.md](BENCHMARKS.md) |
| A failed download | The game offers the rule-based opponent, which needs no download |
| Breaking the portfolio | Diff to `quant.html` is additive only. The end-to-end test loads every existing page |
