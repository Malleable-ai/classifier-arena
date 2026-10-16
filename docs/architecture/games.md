# Games

Every game implements one contract, `src/core/game.ts`, and is listed in the registry,
`src/games/index.ts`. The schedulers, the log, replay, the CLIs, the proxy and the web shell work
through that contract and know nothing else about a game ([core.md](core.md)). Three games are
registered, each with its own page: the fighter ([fighter.md](fighter.md)), Inbox Invaders
([inbox.md](inbox.md)) and Clue Clash ([clues.md](clues.md)). The fighter is the worked example
below; Clue Clash is the turn game. Two test-only games, `test/core/games/counter-realtime.ts`
and `test/core/games/counter-turns.ts`, are small complete examples of each cadence and are never
registered.

## The contract

A game is plain data plus pure functions over its own state `S` and config `C`. There are two
cadences: a `RealtimeGame` advances by ticks whether or not anyone answered; a `TurnGame` advances
once both seats have answered or timed out. The registry holds them as `Game`, with `S` and `C`
erased.

### Every game (`GameCommon<S, C>`)

| Member | What it must do | Fighter |
|---|---|---|
| `id` | Lowercase letters, digits and `_`, starting with a letter (`GAME_ID_RE`). It goes in match ids, result paths and routes | `'fighter'` |
| `label` | Display name | `'Fighter'` |
| `version` | An integer, bumped on every rule or number change. Logged in every header; a replay refuses a log from another version | `ENGINE_VERSION` (2) |
| `defaultConfig` | The config matches run with | `DEFAULT_CONFIG` |
| `promptConfig` | The frozen `GamePromptConfig` (below). Its hash goes in every header | `FIGHTER_PROMPT_CONFIG` |
| `graded` | True when answers are right or wrong (`Settlement.correct`, `applyTurn().correct`) | `false` |
| `baselines` | The game's own baseline ids. Never `random`: every game gets that from core | `['scripted', 'human']` |
| `baselineLabels?` | Display labels for `baselines`, by id. `gameBaselines(game)` (`src/core/classifier/baselines.ts`) pairs each id with its label (core's `random` is "Random (uniform)"), and every place that names a player uses it: match headers (`seats[].label`), `pnpm match --list`, the proxy's `GET /players?game=` (so live mode) and the history page. An id without a label is shown as the bare id | `{ scripted: 'Scripted bot', human: 'Human (live mode)' }` |
| `createBaseline?(id, deps)` | Builds one of `baselines` as a `Decider`. `deps` has the `clock`, an optional `delayMs`, the seat's own `prng` (never the game's) and game-specific `extra` | `createFighterBaseline` |
| `estimate` | Numbers for the cost estimate (below) | `fighterEstimate` |
| `create(seed, config)` | A fresh state. Same seed and config, same state | `createMatch` |
| `clone(state)` | A deep copy that shares nothing | `structuredClone` |
| `hash(state)` | 16 lowercase hex chars over a canonical encoding of the whole state. Replays and tests compare it | `hashState` (FNV-1a 64 over a hand-written serialization) |
| `view(state, seat)` | The state a decider for that seat is sent: a JSON object (`JsonObject`, JSON-safe values; the proxy refuses anything else). Both seats get the same information | `buildView` |
| `question(state, seat)` | `{ key, question }` with the options in canonical order, or null when the seat has nothing to answer (e.g. the game is over). The scheduler orders the options per match and key | `{ key: 'next_move', question: FIGHTER_QUESTION }` until the match is over |
| `result(state)` | `{ over, winner, scores }`: `winner` is a seat, `'draw'`, or null while running | rounds won |
| `logConfig(config)` | The config as JSON for the header | every `EngineConfig` field |
| `configFromLog(logged)` | The inverse: the config a replay passes to `create`. Throws, naming the game, on a malformed one | validates each field |

`GamePromptConfig` is `{ version, questionName, primer, options, stateFormatVersion }`. `options` is
the canonical option list, or `'per-question'` when options come from game data (a clue board, say).
`promptConfigHash(config)` is FNV-1a 64 of its canonical (sorted-key) JSON. The option-order rule is
not part of it: that is core's, logged separately in every header.

`GameEstimate` is `{ decisionsPerSeat: { typical, worst }, decisionsPerSeatByPlayer?, inputTokens,
fallbackInputTokens }`. `decisionsPerSeatByPlayer` overrides the counts for a provider whose speed
changes them (a real-time game keeps one request in flight, so a slower provider decides less
often). `inputTokens` is measured tokens per call by provider id; `fallbackInputTokens` covers the
rest. `src/core/estimate.ts` adds one warm-up call per provider seat.

### Real-time games (`RealtimeGame<S, C>`)

| Member | What it must do | Fighter |
|---|---|---|
| `cadence` | `{ kind: 'realtime', tickRate }` | 60 |
| `tick(state)` | Ticks simulated so far | `state.tick` |
| `canAsk(state, seat)` | Whether the seat can usefully be asked now | only while a round is being fought |
| `answerRetiresKey?` | True when an applied answer retires its question key, so the scheduler doesn't re-ask that key on the tick the answer is applied ([core.md](core.md#real-time-realtimets)) | absent (it asks one key all match); Inbox Invaders sets it |
| `step(state, inputs)` | Simulates one tick, mutating `state`. `inputs` is one `{ choice, questionKey }` or null per seat. Returns `{ settlements, events }` | `stepFighter` |
| `maxTicks(config)` | An upper bound on match length; offline runs and replays stop there | `defaultMaxTicks` (18,451 by default) |

`step` must report what happened to every input it was given, as a `Settlement` `{ seat, choice,
outcome: 'applied' | 'dropped', reason?, correct? }`, on the tick it is decided (not necessarily
the tick it was fed). The scheduler matches each settlement to the oldest waiting answer from that
seat with the same choice, so settle each input once and drop older inputs of a kind first. Drop
an input whose `questionKey` is stale. `events` are JSON-safe `{ kind, … }` payloads for the log
and the viewer.

### Turn games (`TurnGame<S, C>`)

| Member | What it must do |
|---|---|
| `cadence` | `{ kind: 'turns' }` |
| `turn(state)` | Turns played so far |
| `applyTurn(state, answers)` | Plays one turn, mutating `state`. `answers` is `{ choice, latencyMs }` or null (a miss) per seat. Returns `{ correct, events }`, `correct` null for a seat that gave no answer |
| `maxTurns(config)` | An upper bound on match length |

`latencyMs` is the logged value (rounded to 0.1 ms), so a game may use it (as a tie-breaker, say)
and still replay exactly. A null answer (a timeout, an error or a refusal) scores whatever the
game gives a miss. In every game, real-time or turns, timeouts and refusals never count toward
match validity and transport errors over 2% do; timeouts are checked over the whole published run
instead ([core.md](core.md#validity-validityts)).

Clue Clash (game version 2) is the turn example: each of its 16 words is asked at three reveal
steps, a third, two thirds, then all of the definition, so a match is 48 turns and every step
scores. All three steps ask the same question under the word's key `t<word>`, so the option order
holds across them, and a decision line's turn gives back its word (`floor(turn / 3)`) and step
(`turn % 3 + 1`).

### Rules every game follows

- **Pure and deterministic.** The engine (`src/games/<id>/engine/`) has no wall clock, timers, DOM
  or `Math.random`, and imports nothing from `src/web`, `src/server` or `src/cli`; ESLint enforces
  both. Randomness comes from `src/core/util/prng.ts` (sfc32) seeded from the match seed and kept
  in the state, so it is hashed.
- **Same information for both seats.** The view is written from each seat's own point of view, and
  a mirrored position gives both seats the same view. Precompute what models are bad at
  (distances, ranges, counts) instead of leaving them to arithmetic.
- **One prompt, never tuned for one model** (RULES.md). If a game is dull, change the game and bump
  its `version`.

## Add a game

The fighter's files are named in each step.

1. **Pick the id and the cadence.** The id follows `GAME_ID_RE`. Real-time if the game should not
   wait for the models; turns if both seats answer the same thing each turn.
2. **Write the engine** in `src/games/<id>/engine/`: the state type, `create`, `step` or
   `applyTurn`, `clone` and `hash`. Keep every number integer if it must hash the same in Node and
   browsers. Fighter: `src/games/fighter/engine/` (`sim.ts` for `createMatch`, `step` and
   `cloneState`; `hash.ts` for `hashState`).
3. **Write the view** in `src/games/<id>/view.ts`: `view(state, seat)` returns the JSON object a
   model sees. Declare its type with `type`, not `interface`, so it is a `JsonObject`. Fighter:
   `view.ts`, `buildView`.
4. **Freeze the prompt config** in `src/games/<id>/prompt.ts` as a `GamePromptConfig`, and build
   the question from it (`question.ts`). Question names and option ids must match
   `/^[a-z][a-z0-9_]*$/`, with at least 2 options and non-blank descriptions. Then pin
   `promptConfigHash(<config>)` in a test, so any edit fails until the hash is deliberately
   updated. Fighter: `prompt.ts` (`FIGHTER_PROMPT_CONFIG`), `question.ts` (`FIGHTER_QUESTION`),
   hash pinned in `test/games/fighter/question.test.ts`.
5. **Write the game object** in `src/games/<id>/game.ts` implementing `RealtimeGame<S, C>` or
   `TurnGame<S, C>`, including the question keys, the settlements or `correct` flags, the events
   and `result`. Fighter: `game.ts`, `fighterGame`.
6. **Log and rebuild the config.** `logConfig` writes every field the rules depend on;
   `configFromLog` validates and rebuilds it, so a replay runs the same rules. Fighter: every
   `EngineConfig` field, each an integer with a minimum.
7. **Add baselines** in `src/games/<id>/baselines.ts` where a heuristic makes sense. List their ids
   in `baselines`, give each a label in `baselineLabels`, and build them in
   `createBaseline(id, deps)`. A baseline reads only the view (what a model sees), waits
   `deps.delayMs` (default `BASELINE_DELAY_MS`, 200 ms) on `deps.clock`, and uses `deps.prng` for
   any randomness. Fighter: `scripted` and `human` in `baselines.ts` and `human.ts`, labelled by
   `FIGHTER_BASELINE_LABELS`.
8. **Write the estimate** in `src/games/<id>/estimate.ts`: decisions per seat (typical and worst
   case), per-provider counts if speed changes them, and input tokens per call measured from a
   smoke run's logs, with a fallback. Fighter: `estimate.ts` (from the API spike's p50 latency and
   tokens, [decision-apis.md](../research/decision-apis.md#spike-findings-2026-10-07)).
9. **Register it** in `GAMES` (`src/games/index.ts`). `pnpm match --game <id>`, the proxy, `pnpm
   index-results`, `pnpm leaderboard`, the leaderboard at `/` and `/<id>` pick it up from there.
10. **Write the renderer** in `src/web/games/<id>/` implementing `GameRenderer`
    ([core.md](core.md#game-renderers-gamesindexts)), and add it to `RENDERERS` in
    `src/web/games/index.ts`. Draw only from the `FrameInfo` (no clock, no `Math.random`), so a
    frame depends only on the log and the frame index. Fighter: `src/web/games/fighter/renderer.ts`
    (`fighterRenderer`).
11. **Write the tests.**
    - Contract: identity, `configFromLog` inverting `logConfig`, same seed same hash, a stable hash
      across `clone` with an independent clone, both seats asked the same valid question under the
      same key, JSON-safe views, a full match with no answers. The `contract:` block in
      `test/core/game.test.ts` is the checklist; the fighter's version is
      `test/games/fighter/game.test.ts`.
    - Determinism: the same seed and inputs give the same final hash twice and from a mid-match
      clone (fighter: `test/determinism/determinism.test.ts`). Committed logs replay to their
      `match_end` hash automatically in `test/determinism/replay.test.ts`; add the game to
      `e2e/replay.spec.ts` for the browser check.
    - The prompt hash pin from step 4, view tests and renderer tests (`test/web/games/<id>/`).
    - If a question can have more options than a provider's `maxOptions`, that provider answers
      `error` for it. Check before relying on a provider (OpenAI is confirmed up to 16,
      [providers.md](providers.md#the-option-limit-checked-per-question)).
12. **Commit simulated logs.** Play a few free baseline matches on a simulated clock, index them
    and feature one:

    ```sh
    pnpm match --game <id> --a random --b scripted --sim --seed 7
    pnpm index-results --featured <match id>
    ```

    `--featured` records the game's featured match in `results/featured.json`; later runs of
    `pnpm index-results` read it from there, and `pnpm leaderboard` keeps it while the game has no
    valid head-to-head and the pick is still a valid match of the game's current version (then
    the closest head-to-head replaces it). Commit `results/<id>/matches/*.jsonl`,
    `results/featured.json` and `results/index.json`. Fighter (before its head-to-head): seeds 7,
    42 and 2026, random vs scripted both ways, scripted vs random (seed 2026) featured.
13. **Document it** in `docs/architecture/<id>.md` (rules as built, view, options, prompt hash,
    baselines), and list any art in `docs/assets.md` and any data source and its license in
    `data/NOTICE.md`.

Any later change to a game's view, prompt config, options, engine or cadence goes in the PR
description, and affected results are rerun (RULES.md, fairness).
