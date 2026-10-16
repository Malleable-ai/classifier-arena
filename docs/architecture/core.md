# Core

How the game-independent parts work, as built: the classifier core, option order, the two
schedulers, the log, results, replay, the live proxy and the web shell. Games plug into this through
one contract ([games.md](games.md)); each game has its own page ([fighter.md](fighter.md),
[inbox.md](inbox.md), [clues.md](clues.md)). Providers have their own page
([providers.md](providers.md)).

## Layout and the rules ESLint enforces

```
src/core/      classifier/ (questions, formats, providers, deciders, option order), sched/ (real-time
               and turn schedulers, validity), log/ (schema v2), replay/, results/ (paths, the
               exclusion list), util/ (prng, hash, clock), stats/ (Wilson, percentiles, summaries,
               leaderboard), game.ts (the contract), estimate.ts
src/games/     <id>/engine/ (pure rules), <id>/game.ts, view.ts, prompt.ts and, where the game has
               them, baselines, estimate, data and tune files; index.ts (the registry: GAMES,
               getGame)
src/server/    proxy.ts (live mode's key holder)
src/cli/       match.ts, tournament.ts, play.ts (the one match both share), run-id.ts,
               leaderboard.ts, index-results.ts, tune.ts (offline tuning, with tune-worker.ts's
               worker threads), build-*-data.ts, render.ts and cut.ts (video; video/ holds their
               parts)
src/web/       main.ts, route.ts, logs.ts, debug.ts, render-mode.ts, shell/ (pages, player, panel,
               video layouts), games/ (one renderer per game, index.ts registry), cards/ (video
               cards), live/
```

`eslint.config.js` enforces:

- **Purity.** `src/core/**` and `src/games/*/engine/**` may not use `Date`, `performance`, `window`,
  `document`, timers (`setTimeout`, `setInterval`, `setImmediate`, `requestAnimationFrame` and their
  `clear*`) or `Math.random`. Time comes from an injected `Clock`, randomness from the seeded PRNG.
  A short allow-list names each exception and what it may use: `util/clock.ts` (`realClock`:
  `performance`, `setTimeout`, `clearTimeout`), `sched/drive.ts` (Node pacing: `setTimeout`,
  `setImmediate`), and `classifier/http.ts`, `provider-decider.ts`, `remote.ts` (`performance`, to
  measure real request latency). None of them may touch the DOM.
- **No `Math.random`** in `src/web/games/**`, `src/web/shell/**` and `src/web/cards/**` either, so
  replays and renders are reproducible.
- **Layering.** `src/core/**` may not import `src/games`, `src/web`, `src/server` or `src/cli`
  (type-only imports included). Engines may not import `src/web`, `src/server` or `src/cli`.

`test/smoke.test.ts` lints probe files in both trees to prove these rules fire.

## Classifier core (`src/core/classifier/`)

### Questions and answers (`types.ts`, `question.ts`)

- A `Question` is `{ name, instructions, options: { id, description }[] }`. Option order is part of
  the question.
- A `Decider` is `{ player, decide(state, question, signal, ctx?) }`. `state` is the game's view
  for one seat, opaque to core. `ctx` is `{ seq }`, the seq of the decision line the request
  becomes; the schedulers always pass it, and the warm-up never does. `decide` resolves to a
  `DecisionResult`: `choice` (an option id or null),
  `probabilities` (keyed by option id, in question order, or null), `confidence`, `latencyMs`,
  `inputTokens`, `costUsd`, `costEstimated?`, `status` (`ok`, `timeout`, `error`, `refusal`),
  `error?`, `modelVersion?` and `raw?` (request and response, never headers). `refusal` means the
  API answered but declined the question: no choice, and never a transport failure.
- `validateQuestion(q)` throws unless the name and every option id match `/^[a-z][a-z0-9_]*$/`,
  there are at least 2 options, ids are unique and no description is blank. The leading letter
  matters: the `systemone` format sends options as object keys, and JavaScript moves integer-like
  keys ("1", "02") to the front, which would silently reorder the options. `orderOptions` calls
  it, so every question a scheduler hands a decider has passed. The proxy calls it on every
  `/decide` body.
- Player ids (`PLAYER_ID_RE`, `/^[a-z0-9_]+$/`) go into match ids and file names, so no hyphens,
  dots or capitals.

### Formats (`formats/`)

A `DecisionFormat` reshapes a `(state, question, model)` into one API's request body and parses the
response. It never adds, drops or reorders options. Two exist:

| Format | Request | Response |
|---|---|---|
| `systemone` (Jev) | `{ model, state, questions: { [name]: { type: 'choice', instructions, criteria } } }`, `criteria` maps option id → description in question order | `{ model, answers: { [name]: { choice, confidence, probabilities } }, usage }` |
| `openai-decisions` | `{ model, input: JSON.stringify(state), questions: [{ type: 'choice', name, instructions, choices: [{ value, description }] }] }` | `{ model, answers: [{ name, choice, probabilities: [{ value, probability }], confidence }], usage }` |

`parseBody` throws `InvalidAnswer` when the choice is not one of the options (never sampled), and
`Refusal` (a kind of `InvalidAnswer`) when OpenAI returns a `refusal`. The choice is always the
API's top pick; probabilities are logged and
drawn, never used to choose. `extractShared` pulls instructions, options and state back out of a
body, so the conformance suite can prove both formats carry the same content.
`openai-decisions` never sends `service_tier` (the endpoint rejects it), and its `serviceTier` is
logged as `default`.

### Providers, deciders and baselines

- `providers.ts`: the registry (`jev`, `openai`) plus a gitignored `providers.local.json`. See
  [providers.md](providers.md).
- `provider-decider.ts`: one decider per provider entry. **`maxOptions` is checked per question:**
  a question with more options than `capabilities.maxOptions` answers `error`
  (`too many options: <n> > <max>`) at once, with latency 0 and cost 0, and nothing is sent.
  Errors start with `http <status>` so the schedulers can back off on 429 and 5xx; 401 and 403
  drop the provider's message (it can echo part of the key). A `Refusal` answers with status
  `refusal` and `error: "invalid answer: refusal"` (`REFUSAL_ERROR`, the message refusals had
  before the status existed). Any other unusable answer is an `error` starting `invalid answer:`.
  Both are still charged the call's reported input tokens.
- `http.ts`: the only place deciders talk HTTP. It measures latency with `performance.now()` around
  the whole request, body included, and never returns request headers.
- `cost.ts`: input tokens × the entry's dated input price. Unknown tokens cost 0.
- `random.ts`: the `random` baseline every game gets. After `BASELINE_DELAY_MS` (200) on the
  injected clock it picks uniformly by index over the question's options (so it follows the
  question's order), from its own PRNG seeded `randomDeciderSeed(matchSeed, seat)`, never the
  game's.
- `baselines.ts`: `RANDOM_BASELINE` and `gameBaselines(game)`, which lists `random` then the
  game's own baselines, each labelled from `game.baselineLabels` (the bare id when it has none).
  Headers, `pnpm match --list`, the proxy's `/players?game=` and the history page all take their
  baseline labels from it. It imports nothing else, so the web build can use it without the
  provider registry.
- `players.ts`: `listPlayers(env, providers, baselines)` and `createPlayer(id, deps)`. `random`
  comes from core; other baselines come from the game (`deps.baselines`, built from
  `game.createBaseline`); anything else is a provider.
- `remote.ts`: live mode's browser decider. It POSTs `{ game, state, question, snapshot? }` to the
  proxy and measures latency around the whole proxy call, the same way for every provider. The
  snapshot is named by `ctx.seq`, so `<seat>-<seq>.json` matches the log line even when a seq
  passes with no request (a turn seat's backoff miss); a call without `ctx` (the warm-up) is not
  saved.

## Option order (`order.ts`)

Both seats always get the same options in the same order for the same question. The order changes
per match and per question key, because the API spike found OpenAI's top choice follows option order
([decision-apis.md](../research/decision-apis.md#spike-findings-2026-10-07)).
The rule, logged verbatim in every header as `optionOrderRule`:

```
sfc32((matchSeed ^ 0x6f70746e ^ low32(fnv1a64(utf8(questionKey)))) >>> 0) fisher-yates over the
game's canonical options; same order for both seats
```

Step by step (`orderOptions(q, matchSeed, questionKey)`):

1. `h = fnv1a64(utf8(questionKey))`, 16 hex chars; `low32` is its last 8 hex chars as a u32.
2. Seed sfc32 with `(matchSeed ^ 0x6f70746e ^ low32) >>> 0`. `0x6f70746e` is "optn", a salt so the
   stream differs from the game's own PRNG for the same seed. sfc32 starts at
   `a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed` and discards 15 outputs.
3. Fisher–Yates over a copy of the canonical options: for `i` from `n − 1` down to 1, swap `i` with
   `j = nextBelow(i + 1)` (rejection sampling: draw u32s until one is below
   `2^32 − (2^32 mod n)`, then take it mod `n`).

There is no seat input. The schedulers memoise the ordered question per key
(`createQuestionOrder`), so both seats get the same `Question` object. A key names one question
for the whole match: each later ask under it must have the same name, instructions and options
(ids and descriptions, as a set), or the scheduler throws. Every decision line records
its `questionKey`, so with the header's seed anyone can rebuild the order a seat saw. A game that
asks one key all match (the fighter's `next_move`) keeps one order per match; a game that asks the
same question over several turns can keep its order by asking it again under the same key.

## Schedulers (`src/core/sched/`)

Both schedulers use the same values for both seats (`shared.ts`):

| Setting | Value | Meaning |
|---|---|---|
| `FLOOR_MS` | 100 | Real-time: least time between a seat's sends. Turns: pause between turns |
| `TIMEOUT_MS` | 1,000 | Real-time: from send. Turns: from the start of the turn |
| `BACKOFF_START_MS` / `BACKOFF_MAX_MS` | 250 / 2,000 | After an `http 429` or `http 5xx`, doubling; an `ok` resets it |
| `WARMUP_TIMEOUT_MS` | 10,000 | Cap on each provider seat's warm-up call |
| `MAX_MISS_RATE` | 0.02 | Per match: the most transport failures a seat may have. Per run: the most misses (validity.ts) |
| `REALTIME_STALL_MS` | 250 | Real-time: a tick processed later than this is a stall (the match is invalid) |
| `TURN_STALL_SLACK_MS` | 3,000 | Turns: a turn that ends later than this past its deadline is a stall |

The last three live in `validity.ts` with the rule they feed; `shared.ts` re-exports the stall
thresholds.

### Warm-up and header

Before the clock starts, every provider seat (not baselines) makes one warm-up call, all at once:
the game's first question for seat 0's view of a fresh state, in this match's option order, capped
at 10 s on the injected clock. The warm-up only opens the connection before the clock starts, so
it succeeds when the answer is `ok` or a `refusal` (`warmUpSucceeded`): a refusal is a well-formed
answer from a working API, and it is logged in the header with status `refusal` (approved
2026-10-12). It fails on a timeout or an error (network, HTTP, malformed): then `WarmupError` names
every failed seat and the match never starts. The log file is created on its first write, so a
failed warm-up leaves no log. Then the header is written (with each warm-up's record and reported
model version; a refusal still reports the model) and the clock starts. `startTime` is read at that moment. Warm-up spend counts toward `match_end.costUsd`.

### Real-time (`realtime.ts`)

`createRealtimeRunner(opts)` drives a `RealtimeGame`. It is DOM- and Node-free: the caller paces it
by calling `advance(clock.now())`.

- **Accumulator.** Tick `T` is due at `startMs + T × 1000 / tickRate`. `advance(now)` processes
  every tick due by `now` (with a 1e-6 ms tolerance for float rounding), so a late call catches up
  and the timeline never drifts.
- **Per processed tick `T`:**
  1. Each seat's `ok` answer that arrived since the last tick becomes this tick's `step` input
     `{ choice, questionKey }`. Its `appliedTick` is `T`: the first tick processed after the answer
     arrived.
  2. Both seats are polled for a new request, seat 0 first on even ticks and seat 1 first on odd
     ticks (tick parity), so neither seat always sends first. A seat sends only if its controller
     can, `game.canAsk(state, seat)` is true and `game.question(state, seat)` is not null. It is
     sent `game.view(state, seat)` (the state before `T` is simulated) with `sentTick = T`. A game
     with `answerRetiresKey` (Inbox Invaders: an answered message leaves the lane) skips a seat
     whose step-1 input answers the very key it would be asked, so that seat is asked on `T + 1`
     instead of being re-asked a key its answer is about to retire.
  3. `game.step(state, inputs)`; its settlements are matched to answers and its events written as
     `event` lines with `tick = T`.
- **One controller per seat (`SeatController`).** At most one request in flight. A seat may send
  when nothing is in flight, no `ok` answer is waiting to be fed, at least `floorMs` has passed
  since its last send, and it is not backing off. The timeout runs on the injected clock, so
  simulated matches time out on simulated time; a late answer is discarded. A decider that throws,
  synchronously or not, is an `error`; an `ok` without a choice becomes an `error`.
- **Settlement matching (FIFO).** Each `ok` answer fed to the game waits, per seat and in order,
  for a `Settlement`. A settlement is matched to the oldest waiting answer from that seat with the
  same choice. `applied` writes the line with status `ok`; `dropped` writes status `dropped` and
  `error: "dropped: <reason>"`. `correct` is copied when the game reports it. A settlement that
  matches nothing throws. This is exact for any game that settles each input once and drops older
  inputs of a kind first.
- **Decision lines.** Every answered request gets exactly one line, written when its outcome is
  final. Timeouts and errors are written on arrival with `appliedTick: null`. Fed answers keep
  `appliedTick = T` whether applied or dropped, because a replay needs to feed them on that tick.
- **Estimated costs.** A request that was sent but never answered is still billed, with unknown
  usage. Timeouts, and requests still in flight when the match ends, are logged at the seat's last
  `ok` cost (seeded from its warm-up) with `costEstimated: true`.
- **Match end.** Once the game is over or `maxTicks` is reached: a request still in flight and an
  answer not yet fed are logged as `dropped` with `error: "matchOver"` (cost counted, not a decision
  for validity); answers fed but never settled are `dropped` with `error: "dropped: unresolved"`.
  Then `match_end`.
- **Pacing.** In Node, `driveRealtime` (`drive.ts`) sleeps with `setTimeout` until a couple of ms
  before the next tick, then spins on `setImmediate`. On a `SimClock` it jumps simulated time to
  each tick's due time, so an offline match takes seconds. In the browser, live mode calls
  `advance` from a ~4 ms timer, not `requestAnimationFrame`: a seat can send at most once per
  `advance`, so tying it to frames would cap decisions at the frame rate.
- **Stalls.** Each `advance(now)` measures how late it runs: from when the next tick was due to
  `now`, on the injected clock (so tests can simulate a jump). Over `REALTIME_STALL_MS` (250 ms)
  it records a stall, `{ atTick, gapMs }`: the first tick processed late and how late, in whole
  ms. The stalls go in `match_end.stalls`, and any stall makes the match invalid. Why 250 ms:
  normal jitter (a busy event loop, a GC pause) is tens of ms, and the Node driver runs about once
  a tick (16.7 ms at 60 Hz). Past 250 ms the machine itself held the scheduler up (sleep, suspend,
  a clock jump). The game clock then catches up in one burst, 15 ticks or more at 60 Hz, in which
  no answer can land and each seat can send at most once. This happened: three Inbox matches ran
  while the Mac slept, the inboxes drained with almost no requests sent, and the matches still
  read as valid. It measures lateness, not the time between calls, so a game whose ticks are
  further apart than 250 ms is not flagged. A browser tab in the background is throttled to one
  timer a second, so a live match there is a stall too.

### Turns (`turns.ts`)

`createTurnRunner(opts)` drives a `TurnGame`. Per turn, until the game is over or `maxTurns`:

1. The deadline is `now + timeoutMs`, the same for both seats. Each seat with a question is asked
   at once (seat 0's request dispatched first on even turns, seat 1's on odd turns) with its own
   view and the ordered question.
2. When both have answered or missed, `applyTurn` gets `{ choice, latencyMs }` per seat, or null
   for a timeout, an error or a seat with no question. `latencyMs` is the logged, rounded value
   (0.1 ms), so a replay feeds the same number.
3. Both decision lines are written with `sentTick = appliedTick = turn` and `correct` from
   `applyTurn`. An `ok` answer is never `dropped` here. Then the turn's events.
4. The runner waits `floorMs`, then starts the next turn.

A turn always ends by its deadline: the timeout races every request. So a turn that ends more
than `TURN_STALL_SLACK_MS` (3 s) past its deadline, on the injected clock, means the machine held
the scheduler up (sleep, suspend, a clock jump). It is recorded as a stall, `{ atTick: turn,
gapMs }` with `gapMs` the time past the deadline, and the match is invalid. The slack is generous
so only a real pause counts. A shorter one shows as both seats timing out.

A timeout scores nothing (the game gets null) and, as in real time, does not count toward
validity (see Validity). Backoff works as in real time, but the deadline doesn't move: a seat whose
backoff runs past the deadline misses the turn without sending (`error`, `BACKOFF_MISS`, no cost). The miss still uses a
seq, which is why requests carry their seq (`ctx.seq`) rather than deciders counting calls. A
decider that throws, synchronously or not, is an `error`. Timeouts get an
estimated cost the same way. `driveTurns` runs a turn match to the end, moving a `SimClock` from
one sleeper to the next; it throws if the match stalls with nothing left to wake.

### Validity (`validity.ts`)

One rule for every game and both seats (approved by the maintainer on 2026-10-16). A match is
invalid when any of these holds (`invalidReasons(lines, cadence, facts)`; `isValidMatch` is "none"):

- **Transport and format failures** over 2% of a seat's decisions (`failureRate`; lines with
  `error: "matchOver"` are not decisions). A failure (`isFailure`) is an `error` line: an HTTP
  error, a `BACKOFF_MISS` after a 429 or 5xx, a network error, a malformed or unusable response,
  an `ok` without a choice, a decider that threw.
- **A stall.** One the scheduler measured (`match_end.stalls`, see the schedulers), or one the
  decision lines show by themselves (`logStalls`, given the header's `timing.timeoutMs`): a line,
  `matchOver` lines included, whose `latencyMs` is more than the timeout plus the cadence's stall
  slack (`REALTIME_STALL_MS` in real time, `TURN_STALL_SLACK_MS` in turn games). A request can't
  take longer than its timeout, which races it on the scheduler's clock, unless the process was
  paused. A stall is an infrastructure failure, not the models' play, so the tournament reruns the
  match. Older logs have no `stalls` field; the lines still show a pause.
- **Real-time: a provider seat with no decisions.** Defensive: a working provider seat always
  gets answers, and 0 failures of 0 decisions is not a valid match. A provider seat is a header
  seat with a `format` (baselines have null). Baseline seats and turn games are not checked.

**Timeouts never count**, in either cadence. A timeout is the model's own miss: no move in a
real-time game, 0 for that ask in a turn game. Real-time games used to count timeouts toward the
2%, so a match where the slower model timed out a lot was thrown out and rerun, which removed
exactly that model's losses (Jev won all ten such head-to-heads). The timeouts are still
reported, and checked over the whole published run instead (the run-level check below).

**Refusals never count** either, in either cadence, for either seat (approved by the maintainer
on 2026-10-12). A refusal (`isRefusal`: status `refusal`, or an older line with `status: "error"`
and exactly `error: "invalid answer: refusal"`) is the model's own no-answer. Gameplay treats it
like any miss: no move in a real-time game, no answer applied, and 0 for that ask in a graded turn
game. But counting it toward validity would make the tournament rerun exactly the matches where a
model refused, and hide that behaviour from the results, a bias toward the model that refuses. A
refusal does not back a seat off either: the call succeeded.

The rule is the same for both seats, and the denominator is every decision either way. A `dropped`
answer is never a miss: the API answered and the game played the answer out. Timeouts and
refusals are always reported: `match_end.missRates` counts every miss (timeouts and transport
failures), `match_end.timeoutRates` counts timeouts alone and `match_end.refusalRates` counts
refusals. Invalid matches are kept and flagged. `invalidReasonText` puts each reason in words
("stall", "stall (from the log)", "Jev (seat 0) made no decisions", "OpenAI (seat 1) had transport
errors on 3.1% of its decisions (limit 2%)"); the summaries list every invalid match with them,
and `pnpm match`, `pnpm tournament` and live mode print them.

**Re-scoring.** `match_end.valid` is written at match end by the rule in force then, and stays in
the log as that record. Everything that publishes results recomputes validity from the log
instead, with `isValidLog(log, excluded)` (`invalidReasonsOfLog` finds none: the same
`invalidReasons`, by the header's cadence, timeout and provider seats and the recorded stalls):
the summaries and the leaderboard, the featured match, the run-level check, `results/index.json`
and the history page. `excluded` is the exclusion list (below): a match on it is never valid. The
argument is required, as it is for `summarizeGame`, `buildResultsIndex`, `buildMatchList` and
`withLog`, so no caller can forget it. So a rule change re-scores the logs already written, and
`summary.md` lists every match whose recomputed validity differs from its log. The tournament's
reruns use the `match_end.valid` the scheduler just wrote, by the same rule, so it reruns
transport failures, stalls and empty real-time provider seats, and never a timeout or a refusal.

**Excluded by hand (`results/excluded.json`).** Some failures leave no trace in the log. Inbox
matches ran while the Mac slept, before stall detection existed, and three were listed here by
hand. Since 2026-10-16 the stall rule reads the lines too: it catches two of those three by
itself (both seats' last requests were logged `matchOver` 15 to 17 minutes after they were sent),
and a fourth that was never listed (`20261012-231244-inbox-openai-vs-jev-1`, scored until then).
The third listed match (`20261012-234726-inbox-openai-vs-jev-1`) shows nothing in its lines, its
longest request 531 ms, so it stays on the list. Such a match goes on a committed list, with its
reason:

```json
{ "matches": [{ "id": "<match id>", "reason": "<short reason>" }] }
```

An excluded match counts as invalid everywhere `isValidLog` is used: the summaries, the
leaderboard, the featured choice, the run-level check, `results/index.json` (`valid: false` and
`excluded: "<reason>"`) and the history page (an EXCLUDED badge with the reason as its tooltip).
`summary.md` and `leaderboard.md` list excluded matches under their own heading, "Excluded by
hand", with each reason, apart from the invalid and re-scored ones. The log itself stays.
`src/core/results/excluded.ts` reads the file strictly: only `matches`, only `id` and `reason`,
each id once, each reason non-empty. `pnpm leaderboard` and `pnpm index-results` stop, writing
nothing, when an id names no log under `results/*/matches/`, so a typo can't silently exclude
nothing. They read the file from the results root, so `--root` works.

Use it only for an infrastructure failure the log can't show, such as machine sleep before stall
detection existed that left no over-long line. A match the rule already catches comes off the
list, so it holds only what the log can't show. Never use it to drop a result someone dislikes.
Every entry needs a reason a reader can check, and the file's history is in git.

**Run-level check (every game).** A timeout is the model's own miss and never makes a match
invalid, so the 2% limit on misses is checked over the whole published run instead
(`runCheckOf` in `src/core/stats/summary.ts`): for each player, misses (timeouts and transport
failures, not refusals) over decisions across every valid match of the game's current version in
`results/`, seats pooled and `matchOver` lines not counted. If any player is above 2%, the game's
summary has `runCheck.passed: false` with each failing player's rate, and `summary.md`,
`leaderboard.md` and the leaderboard page show a warning for that game; the results are still
shown.

## Log schema v2 (`src/core/log/`)

One JSONL file per match, the same for every game: a `header`, then `decision` and `event` lines as
they happen, then a `match_end`. `writer.ts` appends lines synchronously (Node only, so a crash
keeps every line written), `memory.ts` keeps them in memory, and `read.ts` parses them back with
hand-written guards that report the line and field (`line 3: seats[1].hosting must be …`). Only
`schemaVersion: 2` is read; a v1 log is rejected with a message to regenerate it.

**`header`**

| Field | Contents |
|---|---|
| `type`, `schemaVersion` | `'header'`, `2` |
| `game`, `gameVersion` | The game id and its `version` (bumped on any rule change) |
| `matchId`, `startTime` | See "Results layout"; ISO time the clock started (after warm-up) |
| `gitCommit` | The commit the match ran on, in the private development repo (the public repo is a squashed snapshot, so these hashes don't resolve there) |
| `runId` | Which machine ran the match, without saying where it is (see "Run id" below): `m-` and 12 hex digits from the machine's own stable identifier, `h-` and 12 hex digits from the host name when no identifier is readable, or `sim` for a simulated run. Computed in Node only (`src/cli/run-id.ts`, for `pnpm match`, `pnpm tournament` and the live proxy, which hands it to the browser through `GET /players`). Added after v2 shipped, so a header without it still reads, as `unknown` (`sim` when its `runLocation` is `sim`) |
| `runLocation` | An optional free-text label: `RUN_LOCATION` when set, else `sim` for a simulated run, else `unspecified`. Nothing requires it |
| `seed` | The match seed (u32) |
| `cadence` | `{ kind: 'realtime', tickRate }` or `{ kind: 'turns' }` |
| `timing` | `{ floorMs, timeoutMs }`, the same for both seats |
| `promptConfigHash` | FNV-1a 64 of the canonical JSON of the game's prompt config |
| `optionOrderRule` | The rule string above |
| `config` | `game.logConfig(config)` |
| `seats` | Two entries: `seat`, `player`, `label`, `format`, `hosting`, `model`, `serviceTier`, `modelVersion` (from the warm-up), `price` (`{ inputPerMTokUsd, outputPerMTokUsd, asOf }`), `warmup` (`{ latencyMs, status, costUsd, error? }`, status `ok` or `refusal`). Baselines have null for every provider field |

**Run id.** The operating system keeps a random identifier per machine that survives reboots and
network changes. `readMachineIdentifier` reads it without a shell (`execFileSync`, 2 s timeout):
macOS `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice`, Linux `/etc/machine-id` (else
`/var/lib/dbus/machine-id`), Windows `MachineGuid` from `reg query
HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`. A malformed or all-zero value doesn't
count. The id is `m-` and the first 12 hex digits of SHA-256 over `classifier-arena run id v2:`
and the identifier, lowercased. The prefix separates this hash from any other hash of the same
identifier, so the raw value can't be looked up elsewhere. The raw identifier is never printed or
logged. When none is readable, the id falls back to the host name: `h-` and the same hash over
`classifier-arena run id v2:hostname:<host>`. The `h-` says it can change. Logs before
2026-10-15 carry v1 ids: `m-` and 12 hex digits of FNV-1a 64 over `classifier-arena|<hostname>`.
Those changed whenever macOS renamed the host on a new network, and a guessable host name could
be hashed and confirmed. The published logs carry three v1 ids (`m-156ca376dca4`, `m-f2d69b452ec5`
and `m-8b4e585673bf`, from the runs of 2026-10-12 and 2026-10-13) and one v2 id
(`m-e68aa2cc38b5`, from 2026-10-15 on). Each game's `summary.md` lists the ids its runs used.

**`decision`**: `seat`, `seq` (per seat, from 0), `questionKey`, `sentTick`, `appliedTick`,
`latencyMs` (rounded to 0.1 ms), `choice`, `probabilities`, `confidence`, `inputTokens`, `costUsd`,
`costEstimated?` (present only as `true`), `probabilitiesPartial?` (present only as `true`),
`status` (`ok`, `timeout`, `error`, `refusal`, `dropped`), `error?` and `correct?`. A `refusal`
line has no choice and `error: "invalid answer: refusal"`. Logs written before the status existed
(2026-10-12) logged a refusal as `status: "error"` with that exact `error`; the reader reads such a
line as `refusal`, so everything downstream sees one kind of refusal. Any other `error` stays an
error. For turn games `sentTick`
and `appliedTick` are the turn index. `probabilities` are logged exactly as the API reported them;
when they have no entry for the choice, the writer (`decisionLine`) sets `probabilitiesPartial:
true` rather than patching them. The reader also checks that an `ok` line has a choice, and that
the choice is a key of `probabilities` when both are present unless `probabilitiesPartial` is
`true`.

**`event`**: `{ type: 'event', tick, game: { kind, … } }`. `tick` is the tick simulated or the turn
played. The payload belongs to the game (the fighter logs `round_end`).

**`match_end`**: `winner` (`0`, `1`, `'draw'` or null), `scores`, `totalTicks` (ticks simulated or
turns played), `finalStateHash`, `valid` (by the rule in force when the match was played, see Validity; real-time
games counted timeouts until 2026-10-16; the stats re-score it), `missRates` (timeouts and transport failures over decisions, per
seat; logs written before 2026-10-12 counted refusals here too), `timeoutRates` (timeouts alone;
written since 2026-10-12, optional in the reader, which checks each is at most its seat's miss
rate), `refusalRates` (refusals over decisions, per seat, not part of `missRates`; written since
the refusal rule on 2026-10-12, optional in the reader, which checks each is from 0 to 1),
`decisions` (counted decisions per seat), `costUsd` (every decision plus the warm-ups) and
`stalls` (since 2026-10-15: every stall the scheduler measured, `{ atTick, gapMs }`, in order;
written only when there was one, and then `valid` is false, which the reader checks; absent in
older logs).

## Results layout and match ids (`src/core/results/paths.ts`)

```
results/<game>/matches/<matchId>.jsonl             one log per match (committed)
results/<game>/summary.{json,md}                   per-game summary (pnpm leaderboard)
results/leaderboard.{json,md}                      every game (pnpm leaderboard)
results/index.json                                 every finished match (pnpm index-results)
results/featured.json                              each game's featured match id (committed)
results/excluded.json                              matches excluded by hand, with reasons (committed)
results/states/<game>/<matchId>/<seat>-<seq>.json  full request/response snapshots (gitignored)
```

Paths are pure `/`-joined strings, shared by the CLIs, the proxy and the web build. Match ids are
`<yyyymmdd>-<hhmmss>-<game>-<a>-vs-<b>-<n>`, where `a` and `b` are the seat 0 and seat 1 player ids
and `n` tells apart matches started in the same second. `parseMatchId(id, gameIds)` splits on the
known game ids (longest first) and `-vs-`. `pnpm index-results` scans every
`results/*/matches/*.jsonl`, checks each header's game and match id against its path, and writes
`results/index.json` (schema 2: per match its game, file, players, labels, winner and winning seat,
scores, valid, featured, seed, start time, ticks or turns, final hash and cost, plus `excluded`
with the reason for a match on `results/excluded.json`). Its `valid` is recomputed from the log
(`isValidLog`), not copied from `match_end.valid`, and is false for an excluded match. The featured
flags come from `results/featured.json`, `{ "<game>": "<match id>" }`, so the choice survives
regenerating the index (`pnpm leaderboard` recomputes it, see Scores). `--featured <id>`
(repeatable, one per game) sets that match's game in the file and writes it back. A featured id
that isn't a finished match of its game, or is excluded, stops the run, naming the file.

## Replay (`src/core/replay/replay.ts`)

A log replays on the game and version that recorded it: `assertReplayable` refuses a different
game id, game version or cadence. The header's seed and `configFromLog(header.config)` create the
start state, and the decisions drive it:

- **Real-time:** every line with a non-null `appliedTick` is fed to `step` on that tick as
  `{ choice, questionKey }`, `dropped` lines included (the game re-derives the drop, and a dropped
  input still replaced whatever was waiting). If a seat has several lines on one tick, the last in
  log order wins.
- **Turns:** on turn `t`, each seat's line for `t` becomes `{ choice, latencyMs }` if `ok`, else null.

`replayLog` runs to the end and compares the hash with `match_end.finalStateHash`.
`createReplayCursor` gives the viewer random access: it keeps a cloned keyframe every 600 ticks or
turns and re-simulates from the nearest one on `seek`. A decision line resolves at `appliedTick`,
else at `sentTick + ceil(latencyMs × tickRate / 1000)` (when its answer or timeout arrived); for
turns, once its turn is played. The panel shows lines from that frame on.

## Cost estimate (`src/core/estimate.ts`)

Per provider seat: (the game's worst-case decisions per seat + 1 warm-up) × the game's measured
input tokens per call for that provider (or its fallback) × the provider's input price. Baselines
cost 0. `pnpm match` and live mode print it before any paid run, and both refuse a run whose worst
case is over $5 (`APPROVAL_LIMIT_USD`): the CLI without `--approve-over-5` (passed only once the
maintainer has approved that run, as for `pnpm tournament`; `--yes` only skips the y/N question it asks
before any paid run), live mode always. The typical case is printed for information.

## Scores (`src/core/stats/`) and `pnpm leaderboard`

Every number on the leaderboard comes from the committed logs alone, through pure functions:

- `wilson(successes, n, z = 1.96)`: the Wilson score interval `{ p, low, high }`. `successes` may
  be fractional, because a draw counts as half a win.
- `percentile(values, q)`: nearest rank, the value at rank ⌈q × n⌉, never an interpolation.
- `summarizeGame(game, logs, excluded)` → `GameSummary` (`results/<game>/summary.json`). Only
  matches of the game's current version (`game.version`, `gameVersion` in the summary) count: a
  log of an older version is listed in `olderVersion` ("older version, not scored") and counted as
  `matches.olderVersion`, adding only its spend; a log of a newer version than the code stops the
  run. Only valid matches count, by the current rule recomputed from each log
  (`invalidReasonsOfLog`, see Validity); invalid ones are counted and listed with their reasons in
  `invalidMatches` (`{ id, reason }`, the reasons in words joined by "; "), unfinished logs
  counted. Excluded matches (`results/excluded.json`) are counted with the invalid ones and as
  `matches.excluded`, and listed apart in `excluded` with their reasons, never in
  `invalidMatches` or `rescored`. `rescored` lists each finished match whose
  recomputed validity differs from its `match_end.valid` (`{ id, loggedValid, valid }`). A pairing
  is an unordered pair of players with a record from the first id's side (seat 0's in a mirror
  pairing); a head-to-head is two different providers. Per player: decisions as `validity.ts`
  counts them, misses (timeouts and transport failures), refusals and the refusal rate (refusals
  are not misses), accuracy over lines with `correct` (graded games), p50/p95 latency of `ok` and
  `dropped` decisions, and cost per 1,000 decisions (every billed line plus warm-ups). `runIds` lists the
  distinct run ids of the valid matches with a provider seat. The featured match is the valid
  head-to-head with the smallest score margin, then the longest, then the earliest id; it carries
  `winner`, so equal scores won on a tiebreak (Clue Clash's latency) never read as a draw
  (`formatResult`: "Jev wins on the tiebreak (33–33)"). Every game gets `runCheck` (the run-level
  miss check, see Validity). Schema version 5 (3: refusals and `rescored` added, validity
  recomputed; 4: `excluded` and `matches.excluded`; 5: timeouts never invalid and stalls from the
  log, `invalidMatches` with reasons, `runCheck` for every game, `gameVersion` and `olderVersion`,
  `featured.winner`).
- `buildLeaderboard(summaries)` → `Leaderboard` (`results/leaderboard.json`): one row per provider
  with each game's head-to-head win rate and interval, accuracy, refusals and refusal rate, latency
  and cost; overall = the
  mean of the per-game head-to-head win rates, every game weighted equally, games without one left
  out (`OVERALL_FORMULA` says so in words); each model's record against each baseline; each
  baseline's own numbers; `runIds` over every game; each game's `runCheck`. `leaderboardNotes`
  gives the honesty notes (API-reported probabilities, the machine latency was measured from by
  run id, or every run id when there is more than one, pointing to "Run id" above for the older
  ids, different hosting, what valid means, that a timeout is the model's own miss and never makes
  a match invalid, that a refusal is not a miss and validity is recomputed, the run-level check,
  and the exclusion list). `runCheckWarning(check)` is the one warning text the Markdown and the
  page show for a failed check. Each game carries `matches.excluded` and `excluded` (id and
  reason), which `leaderboard.md` and the page list under the game. Schema version 5 (3: per-game
  refusals; 4: the exclusion list; 5: `runCheck` for every game, never null).
- `markdown.ts` writes the `.md` twin of each file as GitHub tables (a failed run-level check is a
  `> [!WARNING]` block at the top of `summary.md`, under the overall table and in the game's
  section of `leaderboard.md`). `summary.md` has a refusal rate beside each player's miss rate,
  lists each invalid match with its reasons, then the re-scored matches, the excluded ones and any
  older-version ones; `leaderboard.md` has a refusal rate in each game's model table;
  `format.ts` prints numbers the same way for the Markdown and the page (`formatUsd` never in
  exponent form; `formatResult` for match results).

`pnpm leaderboard` (`rebuildResults`) scans `results/*/matches/*.jsonl` and reads
`results/excluded.json`, then builds every file in memory first: every registered game's summary,
the leaderboard, the featured matches and the index (`prepareIndex`, which checks each featured
id). Only once everything has passed does it write `results/<game>/summary.{json,md}`,
`results/leaderboard.{json,md}`, `results/featured.json` and `results/index.json`, so an unknown
excluded id, a newer log version or a bad featured id stops it with `results/` untouched.
Featured matches (`featuredFor`) are recomputed for every game: its closest valid head-to-head. A
game with none keeps its current pick only while that is still a valid, finished match of the
game's current version: a hand pick made with `pnpm index-results --featured`, such as a baseline
match picked so the history page has a replay before any head-to-head exists. Anything else (an
invalid, excluded, older-version or missing match) is stale and dropped, and the game has no
featured match; the command prints what it dropped. The output has no timestamps, so a rerun with
no new logs writes the same bytes.

## Tournament (`src/cli/tournament.ts`)

`pnpm tournament --game <id> --a <p> --b <p> --matches <n> [--seed-base n] [--sim] [--yes]
[--approve-over-5]` plays the published runs:

1. It prints the worst-case estimate for `n` matches plus `MAX_RERUNS` (10) reruns before anything
   else, with the run id every log will carry (this machine's, or `sim`). An `h-` id prints a
   note that it came from the host name and can change.
2. A paid run (a provider in either seat) refuses a worst case over $5 without `--approve-over-5`
   (printing exactly what the maintainer must approve and the command to run once they have), and
   asks y/N on stdin unless `--yes`. Baselines-only runs skip both. `RUN_LOCATION` is optional.
3. Seats swap every match (a, b, a, b, …) and match `k` plays seed `seed-base + k`. Matches run
   strictly one at a time through `playOneMatch` (`play.ts`, which `pnpm match` uses too).
4. Invalid matches (by the `match_end.valid` just written, the rule in Validity) are rerun after
   the scheduled ones, in the same seats with the next seeds, up to 10 in total. Timeouts and
   refusals never make a match invalid, so neither is ever rerun away: a match where the slower
   model timed out a lot stands. A transport failure over 2% does, and so does a stall, and
   rerunning is right for both: they are infrastructure failures. Each invalid result line names
   its reasons ("INVALID (stall)"). A stalled match also prints one warning line under its result ("the
   machine paused mid-match ..., likely sleep; keep it awake and on power"), as `pnpm match`
   does. Their logs stay and are marked invalid in the index.
5. It then runs `pnpm leaderboard`'s rebuild and prints the game's summary table and the run's
   spend from the logs. A failed warm-up stops the run after rebuilding what was played; a refused
   warm-up is not a failure, so the match plays.

## Live proxy (`src/server/proxy.ts`)

`pnpm live` starts the proxy on `127.0.0.1:8787` next to the Vite dev server. It loads `.env` and
holds the keys, so the browser never sees one. It knows no game: games come from the registry, and
state and questions pass through untouched.

| Endpoint | What it does |
|---|---|
| `GET /players[?game=]` | Every provider (id, label, header metadata, whether its keys are set, never the keys); with a game, also `random` and that game's baselines. Plus `gitCommit`, `runLocation` and `runId` (this machine's), which live mode writes into its log headers |
| `GET /estimate?game=&a=&b=` | The estimate for that pairing from the game's estimate: `{ totalUsd, typicalUsd, limitUsd, text }` |
| `POST /decide/:player` | Body `{ game, state, question, snapshot? }`. The player must be a provider with keys set; `game` must be registered, `state` a JSON object, and the question well formed and valid. Runs the provider (10 s cap), aborts it if the browser hangs up, and returns the `DecisionResult` without `raw`. With a valid `snapshot` (`{ matchId, seat, seq }`, the match id naming `game`) it writes the raw request and response to `results/states/…` |
| `POST /log/:matchId` | v2 JSONL lines. Every line must pass the core reader. A header must come first, name this match id and a registered game, and the match id must name that game; the file is then created (409 if it exists). Later chunks only append to logs this process created (404 before the header, 409 for someone else's log or after `match_end`) |

Guards: loopback only; the `Host` header must name the proxy (DNS rebinding); a request with an
`Origin` must come from `ARENA_ORIGINS` (comma-separated, default `http://localhost:5173` and
`http://127.0.0.1:5173`), and every `POST` must carry one; bodies are capped at 1 MB; match ids
match `/^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/` and are at most 120 characters (no dots or slashes).
Errors return `{ error }` with no stack and no headers.

## Web shell (`src/web/`)

### Routes (`route.ts`, `main.ts`)

| Path | Page |
|---|---|
| `/` | The leaderboard (`shell/leaderboard.ts`): overall table, a section per game, baselines, the formula and notes, a link to each game |
| `/<game>` | The game's match history and player |
| `/<game>?match=<id>` | The same, with that replay picked and playing |
| `/<game>?match=<id>&render=1` | Render mode (`&size=<W>x<H>`: a video layout) |
| `/?card=<name>&render=1` | Render mode for a video card |
| `/live` | Live mode (dev builds only) |
| `/fighter?sandbox=1[&p1=random][&seed=<u32>]` | The fighter's dev sandbox |

`vercel.json` rewrites every path except `/assets/` to `index.html`, so deep links work on the
hosted page.

### Logs (`logs.ts`)

`import.meta.glob('../../results/*/matches/*.jsonl', { query: '?raw' })` turns each committed log
into a lazy chunk keyed `<game>/<id>`, the same in `pnpm dev`, `vite build` and Vitest. No Vite
config and no `public/` copy. `results/index.json` is loaded eagerly. Live mode adds logs while the
dev server runs; the module accepts its own hot update so the running match isn't reloaded.

### Game renderers (`games/index.ts`)

The shell knows no game. Each game registers a `GameRenderer`:

| Member | Purpose |
|---|---|
| `gameId` | The game it draws |
| `stage` | `{ width, height }` in logical px; the shell draws the decision panel (680 px) below it |
| `timeline(log)` | `{ frames, at(frame), hash() }` at 60 fps. Real-time games: frame = tick. A frame (`FrameInfo`) is a pure function of the log and the frame index: tick or turn, state, seat labels, seat colors (`colors`: each player's, below), resolved decisions, the latest per seat, each seat's request in flight (`inFlight`: seq, question key and sent tick, never the answer; set by `frameBase` from the log, so replays only), events so far, an optional note. A finished match holds its end for `END_HOLD_FRAMES` (150, 2.5 s; `shell/frames.ts`) more frames, counted in `frames`: the tick, state and panel stay final while the stage plays the end out (the fighter's K.O. fall; Inbox freezes; Clue Clash's result hold is the same length) |
| `draw(ctx, frame, view)` | Draws the stage area; `view.cssScale` lets text grow on phones (every stage raises must-read text to `legibleFloor(cssScale)`, 10 CSS px, in `shell/theme.ts`); `view.size` is the area to fill when it isn't `stage` (`squareStage`) |
| `headline?(d)` | Which decisions can be a seat's headline in the panel. Default every one; the fighter keeps only applied moves (`status: 'ok'`) |
| `droppedLabel?(d)` | The plain word the panel, the video cards and the tickers use for a `dropped` answer, from its logged reason: the fighter's "busy" (it arrived mid-move; a waiting answer a newer one replaced is busy too) or "round over", Inbox's "too late" (it arrived after the message landed). Default "dropped" |
| `squareStage?` | The logical stage size drawn in the square video layout, if narrower than `stage`. The fighter's (1768 × 1080) gives the stage 61% of the square, and it draws the arena through a camera on the fighters |
| `optionLabel(id)` | Plain-text label for an option, used by the panel |
| `chapters(log)` | Jump points under the player (the fighter's round starts) |
| `probabilityBars?` | Bars per decision in the panel; default all options up to 6, else the top 5 |
| `live?()` | Live mode frames for a running match (e.g. effects from each step) |
| `human?()` | Keyboard controls for a game's `human` baseline |

`rendererFor(id)` returns null for a registered game with no renderer yet; it is listed, not linked.

**Colors follow the model, not the seat** (`shell/theme.ts`): Jev is always teal and OpenAI
Decisions always amber, whichever seat it sits in; a baseline (or a human) takes a neutral color
by seat (slate, violet), never a model's. Seats keep their places (P1 left, P2 right). `frameBase`
sets `FrameInfo.colors` from the header's players (`playerColors`), `panelHeaderOf` sets
`PanelHeader.colors`, and every stage (bars, boards, lanes, fighters, effects, the winner's line
in a result banner), the panel, the video cards, the tickers and the outro draw from them.

### Pages and the panel (`shell/`)

- `leaderboard.ts`: `/`, drawn from `results/leaderboard.json` (bundled through `logs.ts`). Before
  any head-to-head it lists the games and their baselines and says there are no published runs.
  A game that failed its run-level miss check gets a warning under its title (with each failing
  player's rate) and "⚠ miss check failed" in its overall-table cells. A game with matches excluded
  by hand lists them under its status, each with its reason and a link to its replay, as
  `leaderboard.md` does. Each game's model table has a refusal-rate column.
  In dev builds `?fixture=1` shows fake numbers from `test/fixtures/web/results-fixture.ts`, with a
  banner; `vite build` drops it.
- `history.ts`: every committed log of one game, with All / Head to head / Baselines filters. A
  summary above the list (from `results/<game>/summary.json`) gives the head-to-head record and
  win rate, each player's accuracy and latency, and the featured match. Without published
  head-to-head results it says "No published head-to-head results yet." (about the published
  results, not the listed matches: a local head-to-head log isn't one).
  `results/index.json` supplies featured, valid and the result; logs it doesn't list show as local
  and fill in as they load. Valid (the INVALID badge) is the current rule's, recomputed from the
  log (`isValidLog`), whether it comes from the index or the log. A match on
  `results/excluded.json` (bundled by `logs.ts`) shows an EXCLUDED badge instead, with its reason
  as the tooltip, and stays invalid when its log loads. Picking a row pushes `/<game>?match=<id>`. Without `?match`, the
  featured (or newest) match is picked and waits for Play. Rows show each seat's label (from the
  index or the log header; before a log loads, the game's baseline labels or a provider's short
  name), and the result names the winner by the short form of that label (`shortLabel`, "Scripted
  bot" → "Scripted wins 2–0"), as the panel's ticker does; a win on equal scores says "on the
  tiebreak" (`formatResult`).
- `player.ts`: plays a log through its renderer with play/pause, 0.5x/1x/2x and chapter buttons.
  rAF time only decides which frame to show.
- `panel.ts`: one panel per seat (label, latest choice with its badge, latency, decisions per
  second over the last 5 s of game time, the match's running cost including the warm-up, labelled
  "match cost $0.0224" so it doesn't read as a per-answer price, API-reported probability bars)
  and a ticker of the last 6 decisions, each in its player's color. It is a pure function of the decision
  lines, the tick and the frame's requests in flight, so replay, live and render mode show the
  same thing. It reads the frame's decisions in the order `frameBase` resolved and sorted them,
  and sorts nothing itself. What it shows:
  - **Headline.** The big choice, its latency and probabilities: the seat's latest decision, or
    the latest one the renderer's `headline` filter keeps. The fighter's keeps the moves the
    engine applied, so the headline is what the fighter is doing; a newer answer the filter skips
    (about half the fighter's answers arrive while it is busy and are dropped) is the seat's
    `note`, a small muted "skipped (busy): throw" line ("busy: throw" where that won't fit; on the
    stats row in the viewer when it fits, its own row in the video cards), and stays in the
    ticker. The panel flashes when the headline
    changes, not on a dropped answer.
  - **Badge.** A status only when it isn't `ok` (`timeout`, `error`, `refusal`, or a dropped
    answer in the game's word, `droppedLabel`: BUSY, TOO LATE; an older log's refusal, an `error`
    line, shows as `refusal` too). The model keeps both: `status` and its plain `statusText`. For an `ok` answer in a graded
    game, a ✓ RIGHT / ✗ WRONG badge (solid
    fill, white mark and word, so it reads without colour), also as a ✓/✗ dot in the ticker.
    Real-time: when the answer resolves. Turns: once its turn is played (the frame's own `tick`),
    so the panel never shows a verdict before the stage does. Clue Clash plays a turn at each
    step's score phase, the frame its boards mark the step ✓/✗ and pop "+1", so the panel's verdict
    appears with those marks on every step and stays through the word's reveal; while a step is
    asked and answering, its answer shows without a verdict.
  - **Requests the match end cancelled** (`error: "matchOver"`) count for cost only: the panel,
    the ticker and the rate skip them, so the last frame shows each seat's last real answer.
  - **Thinking.** A seat with a request in flight on a new question shows "thinking…" and its last
    answer under "Previous answer" (with its badge), instead of the last answer as if it answered
    the new question. Turn games: from when the turn's request is out until its line is in the
    frame (Clue Clash lands it at its latency). Real-time games ask all the time, so the last
    answer stays up for `THINKING_AFTER_TICKS` (30, 0.5 s) after it lands, and only a request on a
    new question key still out after that shows "thinking…"; a game that asks one key all match
    (the fighter) never does. Live mode has no future log lines, so nothing is in flight there.
    Clue Clash's timeline counts a turn as played at its score phase, the same tick as the next
    step's prompt, so `frameBase` alone would call the next request out during the score phase and
    the reveal. The timeline sets `inFlight` itself (`stepInFlight`): a seat's request is out from
    the step's prompt until its answer lands, and nothing is out during the score phase, the
    reveal or the end hold, where the panels show the step's answers and verdicts.
- `stage.ts`: one canvas, stage on top and panel below, scaled to fit at the device pixel ratio.

### `window.__arena` (`debug.ts`)

Dev builds only (`import.meta.env.DEV`), on every page that shows a match (replay, render mode,
live, the sandbox). Read-only getters return fresh deep-frozen copies: `game`, `tick` (real-time)
or `turn` (turn games), `frame`, `state`, `latestDecisions`, `inFlight`, `panel` (the panel model
on screen: each seat's choice, status, verdict, thinking and previous answer, and the ticker;
replays and render mode), `events`, `paused`. Methods: `hash()`,
`pause()`, `resume()`, `stepFrames(n)`, `seek(frame)` (replays only). Controls change only which
frame is shown, never the match. Tests and the dev-loop read state here instead of guessing from
pixels; `e2e/replay.spec.ts` checks every committed log's final hash through it, for every game
with logs in `results/<game>/matches/`.

### Render mode (`render-mode.ts`)

`/<game>?match=<id>&render=1` loads one committed log, draws frame 0 and sets
`window.renderInfo = { frames, width, height }` (the logical canvas, stage plus panel; the fighter
is 1920 × 1760) and `window.renderFrame(n)`, which moves to frame `n` (clamped), draws it
synchronously and returns the frame reached. There is no clock and no loop: the caller (Playwright,
`pnpm render`) drives every frame.

- **`size=<W>x<H>`** (even sides, 240–3840) draws into a canvas of exactly W × H pixels in a video
  layout (`shell/render-layout.ts`, pure and tested) and `renderInfo` reports that size. Square
  (narrower than 1.4 : 1, the 1080 × 1080 cut): the stage fills the width on top and the two seat
  cards sit side by side under it, the panel keeping at least 35% of the height. A renderer's
  narrower `squareStage` gets more of it: the fighter's stage takes 660 of the 1080 px, and its
  camera (`cameraFor` in `games/fighter/canvas.ts`, a function of the fighters' positions only)
  zooms in up to 1.25× while both fighters fit, with the top bar and banner laid out across the
  box. Wide (1920 × 1080): the stage at three quarters of the width on the left, the seat cards
  stacked on its right, the ticker under the stage. The cards (`shell/compact-panel.ts`) draw the
  same `PanelModel` as the viewer's panel (label, headline with its badge, the fighter's note row,
  the answer's latency, the top three API-reported probabilities) at output pixels, with no text
  under 28 px (10 CSS px when the square plays 390 px wide on a phone); no running cost (beside a
  latency it read as a per-answer price; the outro gives cost per 1,000 decisions); a long answer
  beside a verdict keeps its word and shrinks the badge to its ✓/✗. The stage gets a `cssScale`
  for the screen the layout is made for (a 390 px phone, a 960 px desktop player): in the square
  every stage raises must-read text to about 28 px of the frame (`legibleFloor`; its probability
  legend stays small, and a board's latency chip goes when its label won't fit beside it, since
  the cards say the same), and `test/web/legibility.test.ts` checks it. Above that floor (the
  square, a phone) Inbox sets its messages larger on three lines (`messageLayout`, about 34 px of
  the frame), and Clue Clash switches to its tall layout (`cluesLayout`): a taller band with the
  definition white at about 40 px of the frame, and wider tiles. A board word always fits one line
  (`fitWord`: shrink, condense, then smaller, to about 25 px of the frame; never a hyphen inside a
  word; two lines only at a real space or hyphen).
  Without `size`, the viewer's tall layout, as large as fits the window and centred in it.
- **`log=<url>`**, dev builds only (`import.meta.env.DEV`): fetch the log from that URL instead of
  the committed ones (it must name the route's game and match). `pnpm render` uses it for a log
  outside `results/`. `vite build` and `build:web` drop the branch.

### Video cards (`cards/`)

`/?card=<name>&render=1[&size=<W>x<H>]` (default 1920 × 1080) renders one card with the same
`renderInfo` and `renderFrame(n)`. A card is a deterministic canvas animation, a pure function of
the frame and its data, with captions and no audio, the models' names and numbers in their colors:
`intro` (4 s, whole from its first frame so the video's thumbnail is the card: "Jev vs OpenAI
Decisions", "Jev (TypeSafe) vs OpenAI Decisions", "three games · same prompt for both", and a result
teaser computed from `results/leaderboard.json` when it renders, `cards/intro-model.ts`: "Jev won
139 of 168 head-to-head matches (83%)" from the published results), `title-<game>` (1.5 s each: the
game and the decision it asks for) and `outro` (7.5 s, from `results/leaderboard.json`: each model's
overall score and, per game, head-to-head win rate, p50 latency and cost per 1,000 decisions, the
legend on up to two lines, then the repo link, the whole table and link on screen for the last 5 s
and more; "Results pending" before any head-to-head). In dev builds `fixture=1` draws the intro's
teaser and the outro from the fake fixture (`test/fixtures/web/results-fixture.ts`).

### `pnpm render` and `pnpm cut` (`src/cli/render.ts`, `cut.ts`, `video/`)

`pnpm render <match.jsonl | game/id> [--size 1080x1080|1920x1080] [--from <frame|Ns>] [--to
<frame|Ns>] [--out <path>] [--speed 1]` and `pnpm render --card <name> [--fixture]` check that
`ffmpeg` is on the PATH, build the app once in development mode into a temp folder (so `log=` and
`fixture=1` work; never `dist/`), start `vite preview` on a free loopback port, open render mode
in headless Chromium at exactly the video size, read each frame's canvas back as PNG and pipe it
to `ffmpeg -f image2pipe -r 60 -i - -c:v libx264 -pix_fmt yuv420p -movflags +faststart`. A log
outside `results/` is copied next to the build and opened with `log=`. `--to` is exclusive;
`--speed 2` shows every other frame (the video is always 60 fps). Default output:
`renders/<game>-<id>-<size>.mp4` or `renders/card-<name>-<size>.mp4` (gitignored). Progress prints
every 5 s; the browser, server and temp build go away at the end, error or not.

`pnpm cut [--square] [--wide] [--dry-run]` takes each game's featured match (else its first valid
head-to-head; before the published runs, its first committed log, flagged as development only;
never picked for its result) and cuts its end (`video/segments.ts`): every segment ends where the
match's timeline ends, so it closes on the match's actual result, the deciding moment and then
the end hold with the result banner (2.5 s). 13 s per game for the square cut, 26 s for the wide
one; Clue Clash windows hold whole words. A game's activity per frame (`video/activity.ts`, read
through its web timeline in Node) only gives the turn bounds, the hold and the activity the plan
prints. It prints each segment's match, frames and result, renders intro → (title → segment) × 3
→ outro (three clips at a time) and joins them with ffmpeg's concat demuxer into
`renders/arena-square.mp4` (1080 × 1080, about 55 s) and `renders/arena-wide.mp4` (1920 × 1080,
about 1:36).

The square cut of the published results is committed at `public/media/arena-square.mp4` (54.7 s,
12.1 MB, H.264, no audio). Vite copies `public/` into every build, so the built app serves it at
`/media/arena-square.mp4`. Rerun `pnpm cut --square` and copy the file there when the results
change.

### Live mode (`live/`)

`/live`, dev builds only. Pick a game (registered and with a renderer) and two players from
`GET /players?game=`. Baselines and `human` are free. A paid pairing shows the estimate from
`GET /estimate` and needs a confirm box; over $5 worst case it won't start. The match runs in the
browser on the core runner for the game's cadence, on the real clock. Provider seats use the
remote decider; `random` and the game's baselines run in the page (a `human` seat is logged with
latency 0). Log lines are buffered and POSTed to `/log/:matchId` every second, the header and
`match_end` at once. If the proxy refuses the header, the match stops after the warm-up. If the
runner throws mid-match (a game bug, such as a settlement that matches no answer), the loop stops,
requests in flight are aborted (`runner.abort()`), the page shows the error and Start works again;
the log keeps what was written, without a `match_end`. When the match ends, the result line names
the winner (`formatResult`) and, for an invalid match, why (`liveInvalidNote`, by the same rule
that wrote `match_end.valid`): a stall gets the warning to keep the tab in front and the machine
awake (a background tab runs its timers once a second), anything else its reason. Logs land in
`results/<game>/matches/`.

Live mode adds a hop: browser → proxy → API, and the remote decider measures latency around the
whole proxy call, so it includes the local hop (the same for both seats). `pnpm match` and
`pnpm tournament` call the APIs directly from Node (`http.ts`), and the published runs are played
with `pnpm tournament`. The log format is the same either way, and `pnpm leaderboard` counts every
log under `results/`, so a live-mode log left there counts in a local rebuild.

### Builds

`pnpm build` type-checks and builds the dev-capable app. `pnpm build:web` (`vite build --mode
web`, what Vercel runs) drops live mode: `main.ts` only imports `live/live.js` when
`import.meta.env.MODE !== 'web'`, so the chunk is tree-shaken away. CI greps `dist/` for `/decide/`,
`TYPESAFE` and `OPENAI_API_KEY` and fails if any appear.
