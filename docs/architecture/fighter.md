# Fighter

The fighter's rules as built: a small, deterministic arcade-style 2D fighting game at 60 ticks per
second between two identical fighters. Each model picks one of 11 moves at a time, in real time: the
game never waits for an answer, so a faster model gets more moves and a slow answer is acted on late.
Where this page and the code disagree, the code wins and this page gets fixed.

- Engine: `src/games/fighter/engine/` (`constants.ts`, `types.ts`, `moves.ts`, `sim.ts`,
  `combat.ts`, `fighter.ts`, `rounds.ts`, `hash.ts`, `run.ts`)
- On the game contract: `src/games/fighter/game.ts` (`fighterGame`); view, prompt, question,
  baselines and estimate beside it
- Renderer: `src/web/games/fighter/`

`ENGINE_VERSION` (2) is the game's `version`. Any rule or number change bumps it, which makes
older logs unreplayable on purpose. Version 2 is the tuned move table (see "Tuning").

## Units and the stage

- All engine numbers are integers. Positions and velocities are in sub-units: 1 unit = 100
  sub-units. Times are in ticks (60 per second).
- The stage is 1,000 units wide. Fighters start at 350 and 650 and always face each other.
- Each fighter's pushbox is 60 units wide, so centers stay at least 60 units apart and at least 30
  units from each end of the stage. Fighter 0 always stays left of fighter 1 (no cross-ups). An
  overlap is split evenly; against a wall the other fighter takes all of it; an odd sub-unit goes
  to the fighter with more room behind it, so mirrored positions resolve to mirrored positions.
- Both fighters are drawn the same, in the color of the player driving it, whichever seat it is in
  (`shell/theme.ts`: Jev teal, OpenAI Decisions amber, a baseline slate or violet), each named with
  that player's plain-text label.

## Rounds and the match

| Setting (`EngineConfig`) | Default | Rule |
|---|---|---|
| `maxHealth` | 100 | Health at the start of each round |
| `roundTicks` | 3,600 | A 60 s round clock |
| `roundsToWin` | 2 | Best of three |
| `maxRounds` | 5 | After this many rounds without a winner, the match is a draw |
| `bufferTicks` | 6 | How long a busy one-shot waits (below) |
| `roundPauseTicks` | 90 | The pause between rounds, part of the simulation |

- **KO:** a fighter at 0 health loses the round. Both at 0 on the same tick is a double KO, a drawn
  round. A KO on the clock's last tick is a KO, not a timeout.
- **Timeout:** when the round clock runs out, the fighter with more health wins; equal health is a
  drawn round.
- Drawn rounds don't count toward the two wins. The match ends as soon as a fighter has two round
  wins, or after five rounds (wins and draws mixed) as a draw.
- Between rounds: 90 ticks of pause, then fresh fighters at the start positions (health, cooldowns,
  waiting inputs, last moves and phases reset; rounds won kept), no fireballs, and the round clock
  at 0. The engine's PRNG carries on.
- The longest possible match is `5 × (3,600 + 90) + 1 = 18,451` ticks, about 307.5 s
  (`defaultMaxTicks`, the game's `maxTicks`).

All six settings are logged in the header (`logConfig`) and validated on replay (`configFromLog`:
integers, at least 1, or 0 for `bufferTicks` and `roundPauseTicks`; unknown fields are rejected).

## The 11 moves

Four holds and seven one-shots. `MOVE_IDS` in `engine/types.ts` lists them in canonical order, the
order of this table. Values from `engine/moves.ts`; startup / active / recovery in ticks, reach is
center to center in units, hitstun / blockstun in ticks.

| Move | Kind | Startup / active / recovery | Damage | Reach | Height | Hitstun / blockstun | Notes |
|---|---|---|---|---|---|---|---|
| `walk_forward` | hold | – | – | – | – | – | 3 units/tick toward the opponent |
| `walk_back` | hold | – | – | – | – | – | 3 units/tick away; does not block |
| `block_high` | hold | – | – | – | – | – | Stops mid, overhead and fireballs; not sweep or throw |
| `block_low` | hold | – | – | – | – | – | Stops mid, low and fireballs; not jump-in or throw |
| `jab` | one-shot | 4 / 3 / 8 | 4 | 120 | mid | 12 / 6 | Pushes 5 units on hit |
| `heavy_punch` | one-shot | 9 / 4 / 18 | 9 | 130 | mid | 16 / 10 | Pushes 20 units on hit |
| `sweep` | one-shot | 7 / 4 / 20 | 7 | 150 | low | knockdown 40 / 18 | |
| `fireball` | one-shot | 12 / 0 / 20 | 6 | – | projectile | 24 / 18 | 1 chip on block; 6 units/tick; 90-tick cooldown from spawn; one per fighter on screen |
| `uppercut` | one-shot | 3 / 6 / 50 | 10 | 90 | mid | 34 / 28 | Can't be struck for its first 6 ticks; hits airborne fighters |
| `throw` | one-shot | 3 / 1 / 22 | 10 | 80 | throw | knockdown 40 / – | Can't be blocked |
| `jump_in` | one-shot | 28 / 12 / 28 | 8 | 110 | overhead | 20 / 12 | A 40-tick arc (startup + active), peak 120 units, 5 units/tick forward; the kick is the last 12 ticks; recovery is the landing |

Hitstun is recovery + 4 and blockstun recovery − 2, except where the table says otherwise
(`heavy_punch`, `uppercut`, `jump_in` and the knockdowns). A move starting on tick 1 is in startup
for ticks 1…S, active for S+1…S+A, recovery after that, and idle again on S+A+R+1. These are engine
version 2's tuned values (see "Tuning"): a landed `heavy_punch`, `uppercut` or `jump_in` now
leaves the attacker minus.

### Counters

Every move has an answer, so no single move should win:

- The right block stops strikes; a throw beats either block.
- An uppercut beats a jump-in; a sweep beats `block_high`; a jump-in beats `block_low`.
- Jumping over a fireball beats it, and two fireballs cancel.
- Every whiffed move leaves a gap the opponent can punish.

### Hit rules (`engine/combat.ts`)

- A strike (mid, low or overhead) connects while active if the centers are within its reach and it
  hasn't hit yet: one hit per move.
- A defender blocks when it is idle or in blockstun, holding the block that stops that height. A
  blocked hit deals its chip damage (the fireball's 1, otherwise 0) and blockstun.
- A hit deals damage and hitstun, or a 40-tick knockdown for `sweep` and `throw`, and pushes the
  defender back by the move's push. It cancels the defender's one-shot; a held walk or block
  survives the stun.
- All hits on a tick are collected first and then applied, so same-tick hits trade.
- Only `uppercut` and `jump_in` hit an airborne fighter. Airborne fighters jump over fireballs and
  can't be thrown.
- A knocked-down fighter, or one still invulnerable (the uppercut's first 6 ticks), can't be struck
  and lets fireballs pass.
- A throw connects or misses on its one active tick, right after startup. It misses an airborne,
  stunned (hitstun, blockstun, knockdown) or invulnerable opponent, and loses to a strike that is
  already active. Two throws on the same tick are a throw tech: no damage, and the fighters are
  pushed 40 units further apart.
- A fireball spawns at the thrower's front (30 units ahead of center) on the tick startup ends, and
  hits once it is within 30 units of the target's center. Fireballs vanish at the stage ends, and
  two opposing fireballs within 20 units of each other cancel.
- A jump-in moves at most 5 units/tick and never past the opponent's front. If both fighters jump,
  they split the free room.
- A move whose active window ends without contact reports a `whiff`. Health never goes below 0.

### How decisions apply

- A **hold** (walk or block) lasts until the next decision. If the fighter is busy, the hold waits
  as `pendingHold` and takes effect on the first idle tick; it never expires and survives stun and
  knockdown.
- A **one-shot** starts at once if the fighter is idle (a fireball also needs its cooldown done and
  no fireball of its own on screen). Otherwise it waits up to 6 ticks, then is dropped (`busy`).
- A newer decision replaces a waiting one, which is dropped (`superseded`). A one-shot that starts
  replaces a pending hold. When a fighter becomes idle, a waiting one-shot that can start wins over
  a pending hold.
- After a one-shot or a knockdown ends, the fighter **stands without blocking** until its next
  decision, so a slow answer leaves it open. After hitstun or blockstun a held walk or block
  resumes.
- Decisions that arrive between rounds, and anything still waiting when a round ends, are dropped
  (`notFighting`).

### Tick order (`engine/sim.ts`, `step`)

1. Match over: nothing happens and the tick doesn't advance.
2. Between rounds: each input is dropped (`notFighting`), the pause counts down (the next round
   starts when it hits 0), the tick advances.
3. Fighting: inputs (seat 0, then seat 1; holds and one-shots as above), walking, combat (phase
   changes, waiting inputs, jump arcs, fireballs, hits, whiffs, timers), walls and pushbox, round
   clock, round and match end, then the tick advances.

Events carry the tick being simulated.

### State hash (`engine/hash.ts`)

`hashState` serializes every `MatchState` field by hand in a fixed order (integers as 4 bytes
little-endian, strings as length plus UTF-16 units) and folds the bytes through FNV-1a 64 with
integer-only math, so Node and every browser agree. Each object type has a writer table typed over
its keys, so a new field that isn't hashed is a compile error, and
`test/games/fighter/engine/hash.test.ts` checks there are no extra runtime keys.

## On the game contract (`game.ts`)

- `fighterGame` is a `RealtimeGame` at 60 ticks/s, not graded.
- **Question:** `next_move` under the key `next_move`, the same key all match, so one option order
  per match (core's rule). It is asked until the match is over, and `canAsk` is true only while a
  round is being fought, so nothing is sent during the pause between rounds.
- **Settlements:** the engine's own `applied` and `dropped` events settle each input (drop reasons
  `busy`, `superseded`, `notFighting`). An input with another question key is dropped as `stale`
  and an unknown move as `unknown_move`, without reaching the engine; neither happens in a real
  match.
- **Events:** each round end is logged as
  `{ kind: 'round_end', round, winner, reason, health: [seat0, seat1] }` (`reason` is `ko`,
  `doubleKo` or `timeout`). Hits, blocks, whiffs, throw techs and fireball clashes are not logged:
  the renderer replays the engine to draw them.
- **Result:** scores are rounds won; the winner is a seat or `'draw'`.
- **Validity:** core's rule ([core.md](core.md#validity-validityts)). A match is invalid when a
  seat's transport errors pass 2% of its decisions, when a provider seat has no decisions, or on a
  stall (a tick processed more than 250 ms late, or a logged request longer than the timeout plus
  250 ms). Timeouts and refusals never count; timeouts are checked over the whole published run
  instead.

## What the models see (`view.ts`)

Each seat gets compact JSON from its own point of view, with distances and ranges precomputed
because Jev documents weak arithmetic. This is the sample view the conformance fixtures send
(`test/games/fighter/sample-view.ts`):

```json
{
  "you": { "health": 72, "x": 410, "airborne": false, "action": "block_high", "phase": "active",
           "busy_ticks": 0, "fireball_ready": true, "last_moves": ["jab", "walk_forward", "block_high"] },
  "opponent": { "health": 65, "x": 590, "airborne": false, "action": "walk_forward", "phase": "active",
                "busy_ticks": 0, "fireball_ready": false, "last_moves": ["fireball", "walk_back", "walk_forward"] },
  "distance": 180,
  "range": "mid",
  "opponent_fireball": { "distance": 240, "ticks_to_hit": 40 },
  "your_fireball_on_screen": false,
  "round": 2,
  "round_clock_s": 41,
  "rounds_won": { "you": 1, "opponent": 0 }
}
```

| Field | Meaning |
|---|---|
| `x` | Whole units from the wall behind where the **viewing** fighter started: seat 0 sees engine x, seat 1 sees 1,000 − x (computed in sub-units, then floored), for both `you` and `opponent`. A mirrored position gives both seats the same view, and no view says which side it is on |
| `airborne` | In the jump arc |
| `action` | The current hold or one-shot; `stand` after a one-shot ends (not blocking) |
| `phase` | `idle`, `startup`, `active`, `recovery`, `stunned` (hitstun or blockstun) or `knocked_down`; a stable vocabulary even if engine phases change |
| `busy_ticks` | Ticks until that fighter can act (0 = now) |
| `fireball_ready` | Cooldown done and no own fireball on screen |
| `last_moves` | The last 3 applied moves, oldest first |
| `distance`, `range` | Center distance in whole units; `close` under 120, `mid` 120–350, `far` over 350 |
| `opponent_fireball` | The opponent's fireball heading at you: `distance` it still has to travel before it hits (units) and `ticks_to_hit` (rounded up); null when there is none or it has passed |
| `your_fireball_on_screen` | Whether your own fireball is out |
| `round`, `round_clock_s`, `rounds_won` | Round number, seconds left (rounded up), round wins for each side |

## The question and the prompt (`prompt.ts`, `question.ts`)

One choice question, `next_move`, with the 11 moves as options in canonical order; the scheduler
orders them per match with core's rule, the same for both seats. Each model plays the API's top
choice. The frozen prompt config is `FIGHTER_PROMPT_CONFIG`:

- `version: 2`, `questionName: 'next_move'`, `stateFormatVersion: 2` (2 since `x` moved to each
  seat's own frame). Version 2 has the same prompt text as version 1; it only dropped the
  option-order rule (now core's).
- The primer (the question's `instructions`): a short statement of the rules, the ranges, the
  counters, what `busy_ticks` means and when `opponent_fireball` is null.
- One description per option, saying what the move does, what it beats and what beats it.
- Its hash, `promptConfigHash(FIGHTER_PROMPT_CONFIG)`, is **`d7ce85c39c9adebe`**. Every fighter
  header records it and `test/games/fighter/question.test.ts` pins it. The wording is exactly what
  the API spike sent (`test/fixtures/<provider>/choice-ok.request.json`), and the test checks that
  too. The config no longer holds the option-order rule (it is core's, in every header); as
  version 1 with the rule back, the hash is the old `9553e0fcba75ec7d`, so the prompt text did not
  change.

The config is never tuned for one model (RULES.md). A change bumps its `version` and the pinned
hash, goes in the PR description, and affected results are rerun.

## Baselines

Labels (`FIGHTER_BASELINE_LABELS`, the game's `baselineLabels`): "Random (uniform)" (core),
"Scripted bot" and "Human (live mode)".

- **`random`** (core): a uniform pick over the 11 options after 200 ms, from the seat's own PRNG.
- **`scripted`** (`baselines.ts`): uses only the view, first matching rule wins, after 200 ms:
  1. an opponent fireball arrives in under 25 ticks → `jump_in`
  2. the opponent is airborne and close → `uppercut`
  3. the opponent is sweeping (startup or active) → `block_low`
  4. the opponent is striking (startup or active) → `block_high`
  5. the opponent is blocking and close → `throw`
  6. far and your fireball is ready → `fireball`
  7. mid → `walk_forward`
  8. close → `jab`
  9. otherwise (far, no fireball) → `walk_forward`
- **`human`** (`human.ts`, live mode only): keyboard moves through the same cadence as the models
  (one at a time, 100 ms floor, 1 s timeout), logged with latency 0. Keys: A / D walk, S block low,
  Shift block high, W jump-in, J jab, K heavy, L sweep, U uppercut, I fireball, O throw; with no key
  held the fighter guards high.

## Cost estimate (`estimate.ts`)

Real time keeps one request in flight per seat, so a provider makes about
`1000 / max(100 ms floor, p50 latency)` decisions per second. From the API spike (2026-10-07,
`docs/research/decision-apis.md`):

| Player | p50 latency | Input tokens per call | Decisions per seat, typical / worst |
|---|---|---|---|
| `jev` | 170 ms | 1,166 | 724 / 1,809 |
| `openai` | 184 ms | 782 | 669 / 1,672 |
| unmeasured provider | 100 ms (the floor) | 2,000 | 1,230 / 3,076 |

The worst case is the longest possible match (307.5 s) and is what the $5 guard uses. The typical
case (two full rounds and their pauses, 123 s) is for information. One warm-up call per provider
seat is added. Jev vs OpenAI comes to $0.2195 worst case ($0.0879 typical); Jev vs `random`
$0.0886 ($0.0355).

## Renderer (`src/web/games/fighter/`)

- The stage is 1920 × 1080 logical px; with the decision panel below, the canvas is 1920 × 1760.
  A frame is a tick.
- The log keeps only `round_end` events, so the timeline replays the engine through `stepFighter`
  (the same step the contract runs) to draw hit sparks, block flashes, fireballs, knockdown dust
  and clashes. A jump re-simulates the ticks just before it, so it draws exactly what playing up to
  it does.
- After a round ends the engine stands still (between rounds only the clock ticks; at match end
  nothing moves), so the stage draws `settledState` (`settle.ts`) instead: the K.O.'d fighter
  falls and stays down, the other finishes its move and stands, fireballs fly on, nobody can be
  hit, and health and rounds stay the decided ones. It runs the engine's own combat step on a copy,
  never the replay's state. A finished match holds for `END_HOLD_FRAMES` (2.5 s) past its last tick
  so the fall and the result banner are seen; `tick`, `state` and the hash stay final.
- The banner sits under the top bar, clear of the fighters: a big "K.O." / "TIME" / "DOUBLE K.O."
  (or "ROUND n" as one starts) and a line naming the winner by its label without the model id
  ("Round 1 · OpenAI Decisions wins", "OpenAI Decisions wins the match 2–0").
- Health bars keep each seat's colour at any health; at 30% or less the outline flashes red.
- In the square video the stage is 1768 × 1080 (`squareStage`) and the arena is drawn through a
  camera that follows the fighters (zooming in up to 1.25× while both fit), so they are about 250
  px tall in the 1080 square; the top bar is laid out across that box.
- Chapters are the round starts (R1, R2, …): tick 0, then each round end plus the pause.
- Option labels replace `_` with a space. The panel shows each decision's top 3 probabilities.
  Its headline is the last move the engine applied (`headline`); an answer dropped while the
  fighter was busy (about half of them) is a small "dropped: <move>" note and a ticker line.
- Fighters, stage and effects are drawn in code, with no image files (`docs/assets.md`).
- `/fighter?sandbox=1` is a dev sandbox: human (or `p1=random`) vs random, `seed=<u32>`, no
  deciders and no log.

## Tuning

`pnpm tune --game fighter` (`src/games/fighter/tune.ts`, CLI `src/cli/tune.ts`) plays offline
matches through the real-time scheduler on a simulated clock, the same path as `pnpm match --sim`:
every player answers 200 ms after it is asked, under the 100 ms floor and 1 s timeout, so a seat
decides about every 12 ticks. No network, no keys, no cost.

- **Players:** `random`, `scripted`, and one spam bot per move. On each decision a spam bot flips a
  fair coin from its own PRNG: heads its move, tails a uniform pick over the 11 options, so its
  move about 55% of the time.
- **Rows:** each spam bot against `random`, `scripted` against each spam bot, and `random` against
  `random`. A row plays seeds 1–2,000; the first-named player sits in seat 0 on even matches and
  seat 1 on odd ones, so a seat advantage cancels. A draw counts as half a win.
- **Pass:** every spam bot wins at most 65% against `random`; `scripted` wins at least 55% against
  every spam bot; `random` vs `random` is 45–55% for each seat. The command exits 1 otherwise.
- **n:** 2,000 matches per row (`--matches`), so each rate is within ±2.2 points at 95% (±3 needs
  1,068). The tuned table also passes on seeds 2,001–4,000 (`--first-seed 2001`), with no row more
  than 4 points from the run below.

Win rates (%) at n = 2,000 per row, seeds 1–2,000, for the starting numbers (engine version 1)
and the tuned ones (version 2):

| Row | v1 | v2 |
|---|---|---|
| `spam_walk_forward` vs `random` | 0.3 | 0.4 |
| `spam_walk_back` vs `random` | 0.4 | 0.7 |
| `spam_block_high` vs `random` | 18.4 | 23.2 |
| `spam_block_low` vs `random` | 19.4 | 18.4 |
| `spam_jab` vs `random` | 27.5 | 60.6 |
| `spam_heavy_punch` vs `random` | 40.9 | 56.7 |
| `spam_sweep` vs `random` | 25.6 | 53.9 |
| `spam_fireball` vs `random` | 8.0 | 27.8 |
| `spam_uppercut` vs `random` | **97.4** | 60.5 |
| `spam_throw` vs `random` | 55.6 | 56.3 |
| `spam_jump_in` vs `random` | **99.7** | 57.5 |
| `scripted` vs `spam_walk_forward` | 100.0 | 100.0 |
| `scripted` vs `spam_walk_back` | 100.0 | 100.0 |
| `scripted` vs `spam_block_high` | 99.8 | 99.2 |
| `scripted` vs `spam_block_low` | 99.8 | 99.2 |
| `scripted` vs `spam_jab` | **52.9** | 60.7 |
| `scripted` vs `spam_heavy_punch` | **42.6** | 66.2 |
| `scripted` vs `spam_sweep` | 90.3 | 99.6 |
| `scripted` vs `spam_fireball` | 98.6 | 99.8 |
| `scripted` vs `spam_uppercut` | **1.1** | 77.7 |
| `scripted` vs `spam_throw` | **40.2** | 93.5 |
| `scripted` vs `spam_jump_in` | 100.0 | 100.0 |
| `random` vs `random`, seat 0 / seat 1 | 49.2 / 50.8 | 49.8 / 50.2 |

Bold rows failed. Spamming a hold or the fireball still loses, which the criteria allow: they cap
how much one move can win, not how little.

What changed, all in `engine/moves.ts` (rules, view, prompt, question and cadence untouched):

| Move | Number | v1 | v2 | Why |
|---|---|---|---|---|
| `jab` | reach | 110 | 120 | It now reaches the whole `close` band (< 120) that the view and primer name; the scripted bot jabs at `close`, and its jabs at 110–119 whiffed |
| `heavy_punch` | reach | 160 | 130 | Still longer than the jab. At 160 a heavy spammer hit an opponent walking in from mid range again and again (its push keeps the opponent out there) |
| `heavy_punch` | hitstun / blockstun | 22 / 16 | 16 / 10 | −5 on hit and −11 on block (was +1 and −5) |
| `uppercut` | recovery | 30 | 50 | Stun stays 34 / 28, so −21 on hit, −27 on block. With 3 startup ticks and 6 invulnerable ones it beat everything at close range and was ready again before the opponent |
| `throw` | recovery | 20 | 22 | The most sensitive number: at recovery 20 / 22 / 24, `spam_throw` wins about 69 / 57 / 45% against `random` |
| `jump_in` | landing recovery (`JUMP_LANDING_RECOVERY`) | 8 | 28 | Only an uppercut or a jump-in hits a jumper, so `random` could rarely answer one; a landed or blocked jump-in can now be punished on the landing |

Damage was left alone: the option descriptions in the frozen prompt config state each move's
damage (and the fireball's chip), and none of the changed numbers appears in them, so the prompt
config and its hash (`d7ce85c39c9adebe`) are unchanged. The numbers were found with a greedy search
over about 30 move-table values on a few hundred shared seeds per row, then pruned to the changes
the criteria need and checked on the full run. `ENGINE_VERSION` went to 2, and the determinism
soak hash, `test/fixtures/baseline/fighter.json` and the committed simulated logs were regenerated.

**One description is now loose.** The frozen `heavy_punch` description says it "beats
walk_forward at mid range", but its reach is now 130 units and the view's `mid` band is 120–350
(`rangeOf` in `view.ts`), so it reaches only the first 10 units of that band (120–130); from the
rest of `mid` it whiffs. The prompt config is frozen (changing it changes its hash, a fairness
change that means rerunning every fighter result), so the description stays as it is. Both models
read the same text, so it misleads them equally; anyone reading the replays should know the line
overstates the move's reach.
