# Inbox Invaders

Inbox Invaders' rules as built: real-time SMS triage at 60 ticks per second. Text messages fall
down two lanes, one per model, and each model labels the lowest message in its own lane as
`legit`, `spam` or `smishing` before it lands. The game never waits, so a faster model clears more
messages. Where this page and the code disagree, the code wins and this page gets fixed.

- Engine: `src/games/inbox/engine/` (`types.ts`, `schedule.ts`, `sim.ts`, `hash.ts`)
- On the game contract: `src/games/inbox/game.ts` (`inboxGame`); view, prompt, baselines, data
  and tuning beside it
- Data: `data/inbox/messages.json`, built by `pnpm data:inbox` (`src/cli/build-inbox-data.ts`)
- Renderer: `src/web/games/inbox/`

`inboxGame.version` is 1. Any rule or number change bumps it, which makes older logs unreplayable
on purpose.

## The stream

Both lanes get the same messages, in the same order, on the same schedule. Only the order depends
on the seed: `create` shuffles the 600 committed messages (sfc32 Fisher–Yates from the match seed)
and puts the first `streamLength` of them on the schedule.

| Setting (`INBOX_CONFIG`) | Value | Rule |
|---|---|---|
| `health` | 100 | Each lane's starting health |
| `damage` | 1 | Health lost for a wrong answer or a message that lands |
| `smishingMultiplier` | 3 | A smishing message answered wrong or landed costs 3 |
| `maxChars` | 240 | A longer text is cut to this many characters and ends in `…` |
| `streamLength` | 600 | Messages per match (all of them) |
| `spawn` | 20 → 7 ticks over 10,800 | Gap between spawns, shrinking linearly over the first 180 s |
| `fall` | 240 → 90 ticks over 10,800 | Time from spawn to landing, shrinking the same way |

The schedule depends on the config alone (`schedule.ts`). The last message spawns at tick 8,746
(about 146 s), when spawns are 10 ticks apart, and lands at tick 8,865, so the longest match is
8,866 ticks (`inboxMaxTicks`), about 148 s. Every setting, plus the messages' build hash
(`dataSha256`), is logged in the header; a replay refuses a log made with other messages.

## Tick order (`engine/sim.ts`, `stepInbox`)

1. Each seat's answer applies to its own lane. An answer for a message still falling resolves it:
   right clears it at no cost; wrong clears it and costs damage. Either way it settles `applied`
   with `correct`. Anything else settles `dropped`: `landed` (it hit the inbox first),
   `resolved` (already answered) or `unknown`.
2. The tick advances; messages due spawn into both lanes.
3. Messages due land in each lane that still has them, costing damage.
4. The match ends when a lane reaches 0 health, or every message has spawned and both lanes are
   empty.

**Result:** scores are each lane's health. Higher health wins; equal health goes to the higher
accuracy (correct over answered, a seat that answered nothing counts as 0); then a draw.

**Events:** `hit` (`seat`, `id`, `cause` `wrong` or `landed`, `damage`, `health`) and
`game_over` (`winner`, `health`). The renderer draws everything else from the decision lines.

**Validity:** core's rule ([core.md](core.md#validity-validityts)). A match is invalid when a
seat's transport errors pass 2% of its decisions, when a provider seat has no decisions, or on a
stall (a tick processed more than 250 ms late, or a logged request longer than the timeout plus
250 ms). Timeouts and refusals never count; timeouts are checked over the whole published run
instead. The stall rule reads three matches of the first head-to-head run as invalid from their
logs. One more match from that run is excluded by hand in `results/excluded.json`: the machine
slept mid-match before stall detection existed, and its log shows nothing. Its log stays.

## On the game contract (`game.ts`)

- A `RealtimeGame` at 60 ticks/s, graded.
- **Question:** `classify_message`, keyed by the message id, for the soonest-to-land message in
  the seat's lane; null when its lane is empty. Both seats get the same question for the same
  message, so the same option order (core's rule, per key).
- `canAsk` is true while the seat's lane has a message. `answerRetiresKey` is true: an answered
  message leaves the lane, so the scheduler doesn't re-ask its key on the tick the answer applies.

## What the models see (`view.ts`)

```json
{ "text": "Your parcel is held at the depot. Confirm delivery at hxxp://example[.]com", "seconds_to_land": 2.7 }
```

(An invented example.) `text` is the message as committed, cut to `maxChars`; `seconds_to_land` is
the ticks until it lands over 60, rounded to 0.1 s. Nothing about the other lane, the score or the
clock. State format version 1.

## The question and the prompt (`prompt.ts`)

`INBOX_PROMPT_CONFIG`: `version: 1`, `questionName: 'classify_message'`, `stateFormatVersion: 1`.
The primer says the model triages texts as they arrive, that a wrong answer or a landed message
costs health and smishing three times as much, what `seconds_to_land` means, and how names,
numbers, emails and links are masked. The three options, in canonical order:

| Option | Description (abridged) |
|---|---|
| `legit` | A normal message from a person or a real business. Not selling anything, not a scam |
| `spam` | Unwanted bulk marketing that sells something openly |
| `smishing` | SMS phishing: tries to trick you out of money or personal details |

The option descriptions are the ones the label review used, so they don't change without
redoing that review. Its hash, `promptConfigHash(INBOX_PROMPT_CONFIG)`, is **`4e73962f4f519949`**,
pinned in `test/games/inbox/prompt.test.ts`.

## The data

`data/inbox/messages.json` holds 600 messages, 300 legit, 150 spam and 150 smishing, sampled from
the SMS Phishing Dataset (Mishra & Soni 2022, CC BY 4.0), which includes the UCI SMS Spam
Collection. Names, emails and phone numbers are masked, links are defanged, and AI reviewer agents
(Claude, neither of the competing models) read every candidate, one message at a time against a
written guide: first against the three option descriptions, then again for offensive content. No
person read every item. The right answer is the dataset's label: items whose label the review
disagreed with were dropped and replaced from the same class, never relabelled. The disagreement rate was 5.4% (51 of 950
reviewed), almost all of it dataset `smishing` texts that read as open sales offers. Full method:
[game-data.md](../research/game-data.md#label-check-2026-10-07); credits and changes:
[data/NOTICE.md](../../data/NOTICE.md).

## Baselines

Labels: "Random (uniform)" (core) and "Always legit".

- **`random`** (core): a uniform pick over the three options after 200 ms.
- **`scripted`** ("Always legit", `baselines.ts`): always `legit`, the majority class, after 200 ms.
  It ignores the state.

## Cost estimate

Typical: one decision per message (600 per seat). Worst case: one request per 100 ms floor for
the longest match (1,478 per seat). Input tokens per decision, measured live: Jev 555 (the smoke
match, 2026-10-08), OpenAI 343 (the watchability match, 2026-10-12); 600 for an unmeasured
provider. Jev vs OpenAI comes to about $0.035 typical, $0.085 worst case.

## Tuning

`pnpm tune --game inbox [--matches n]` (`src/games/inbox/tune.ts`) plays simulated players through
the real-time scheduler on a simulated clock: no network, no keys. A simulated player answers
after a fixed latency, right with a given probability. Targets: a 180 ms player at 90% accuracy
lasts 2–3 minutes; a 300 ms player at 90% falls behind clearly sooner; `random` and "Always legit"
die within about 30 s. For the config above, 40 seeds:

| Player (against a perfect, never-dying opponent) | Mean survival | Died |
|---|---|---|
| 180 ms at 90% | 142.9 s | 39/40 |
| 300 ms at 90% | 73.5 s | 40/40 |
| `random` | 31.8 s | 40/40 |
| "Always legit" | 33.1 s | 40/40 |

Head to head, 180 ms at 90% beat 300 ms at 90%, `random` and "Always legit" 40–0 each. Accuracy
alone can't separate a 2–3 minute player from a 30 s one, so speed does it: a seat clears about one
message per latency, and once spawns come faster than that, messages land.

## Renderer (`src/web/games/inbox/`)

- The stage is 1920 × 1080 logical px; a frame is a tick. Two lanes of falling message cards, each
  lane's health and accuracy, the clock, and a banner at the end.
- The timeline replays the match with the core replay cursor; answered cards, landings and health
  pulses come from the frame's decision lines and logged events, so a jump draws exactly what
  playing up to it does.
- Chapters: the start, the first hit and the first landing (just before each), then every 30 s.
- Drawn in code, with no image files ([assets.md](../assets.md)).
