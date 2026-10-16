# Classifier Arena

Two decision APIs play each other in three small browser games: Jev from
[TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (model `jev-latest`) and
[OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) (model `gpt-6-luna`).
A decision API doesn't write text. It takes a state and a question with a fixed list of options,
and returns its pick plus a probability for every option. All three games run on one game-agnostic
classifier core, so both models get the same state, prompt, options and timing everywhere. Every
decision is logged, and every match replays exactly from its log.

- **Fighter** (real time, 60 ticks a second): a 2D fight between two identical fighters, best of
  three rounds. Each model picks one of 11 moves at a time. The game never waits for an answer, so
  a faster model gets more moves. [Rules](docs/architecture/fighter.md).
- **Inbox Invaders** (real time): text messages fall down two lanes, one per model. Each model
  labels the lowest message in its lane as legit, spam or smishing before it lands. A wrong answer
  or a landed message costs health, and smishing costs three times as much.
  [Rules](docs/architecture/inbox.md).
- **Clue Clash** (turn based): a reverse dictionary. Both models see the same definition and pick
  the word it defines from the same 16 close-meaning nouns. Each definition is revealed in three
  steps, both models pick at every step, and every right pick scores a point: 16 words, 48 picks
  each. [Rules](docs/architecture/clues.md).

## Results

| Model                         | Overall | Fighter                  | Inbox Invaders           | Clue Clash               |
| ----------------------------- | ------- | ------------------------ | ------------------------ | ------------------------ |
| Jev (TypeSafe)                | 83.0%   | 75.0% (62.3–84.5%, n=56) | 92.3% (81.8–97.0%, n=52) | 81.7% (70.1–89.4%, n=60) |
| OpenAI Decisions (gpt-6-luna) | 17.0%   | 25.0% (15.5–37.7%, n=56) | 7.7% (3.0–18.2%, n=52)   | 18.3% (10.6–29.9%, n=60) |

Each game column is the head-to-head win rate against the other model, with its 95% Wilson
interval and the number of valid matches. A draw counts as half a win. Overall is the mean of the
three games' win rates.

| Game           | Model            | Accuracy   | Refusal rate | p50 latency | p95 latency | Cost per 1,000 decisions |
| -------------- | ---------------- | ---------- | ------------ | ----------- | ----------- | ------------------------ |
| Fighter        | Jev              | not graded | 0.0%         | 147 ms      | 238 ms      | $0.049                   |
| Fighter        | OpenAI Decisions | not graded | 1.6%         | 188 ms      | 385 ms      | $0.077                   |
| Inbox Invaders | Jev              | 95.7%      | 0.0%         | 164 ms      | 240 ms      | $0.024                   |
| Inbox Invaders | OpenAI Decisions | 95.0%      | 0.0%         | 196 ms      | 326 ms      | $0.034                   |
| Clue Clash     | Jev              | 81.3%      | 0.0%         | 159 ms      | 215 ms      | $0.028                   |
| Clue Clash     | OpenAI Decisions | 78.4%      | 0.4%         | 208 ms      | 385 ms      | $0.035                   |

These cover each model's valid matches in that game, against the other model and the baselines.
Latency is wall time per answered request, from the machine that ran the matches.

The matches ran from 2026-10-12 to 2026-10-16. In each game, each model played 10 scheduled
matches against each baseline and 50 scheduled head-to-heads. Some counts are higher because
matches that were rerun under earlier validity rules now count alongside their reruns. Each game's
featured match is its closest valid head-to-head. To replay one, run `pnpm dev` and open:

- Fighter: `/fighter?match=20261015-235712-fighter-jev-vs-openai-1` (Jev wins 2–1 in rounds).
- Inbox Invaders: `/inbox?match=20261012-214212-inbox-jev-vs-openai-1` (Jev wins with 2 health
  left to 0).
- Clue Clash: `/clues?match=20261012-212303-clues-openai-vs-jev-1` (33–33; Jev wins the tiebreak
  on lower mean latency over correct answers).

The full leaderboard, the baselines and every invalid match are in
[results/leaderboard.md](results/leaderboard.md) and each game's summary:
[results/fighter/summary.md](results/fighter/summary.md),
[results/inbox/summary.md](results/inbox/summary.md) and
[results/clues/summary.md](results/clues/summary.md).

The square video cut (1080 × 1080, 55 s, no audio) is at
[public/media/arena-square.mp4](public/media/arena-square.mp4). `pnpm cut --square` renders it again
from the logs, to `renders/arena-square.mp4` (see "Video" below).

Every number comes from the committed match logs and the exclusion list in
`results/excluded.json` (see "How fair is this?"). Each match is one JSONL file in
`results/<game>/matches/`, and `results/featured.json` names each game's featured match. To replay
any match, start the viewer (below) and open `/<game>?match=<match id>`. `pnpm leaderboard`
rebuilds every summary and the leaderboard from the logs, and `pnpm test:determinism` replays every
committed log to its recorded final state, in Node and in the browser.

## Quick start

You need Node 24 and pnpm 10.

### Without keys

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. Nothing here calls an API.

- `/` is the leaderboard.
- `/fighter`, `/inbox` and `/clues` list every committed match of that game, with the featured
  match ready to play.
- `/<game>?match=<id>` plays a match: the game on top, and each model's decisions underneath
  (latency, API-reported probabilities, status and running cost).

Also free and offline: `pnpm match --game fighter --a random --b scripted --sim` plays a baseline
match on a simulated clock, and `pnpm tune --game fighter` (or `inbox`) runs the offline tuning.

### With keys

Copy `.env.example` to `.env` and fill in `TYPESAFE_API_KEY` and `OPENAI_API_KEY`. `RUN_LOCATION`
is an optional label for where matches run.

```sh
pnpm live                                        # key proxy on 127.0.0.1:8787 + viewer; open /live
pnpm match --game fighter --list                 # a game's players, and whether their keys are set
pnpm match --game inbox --a jev --b openai       # one match, after printing its cost estimate
pnpm match --game clues --a jev --b openai --estimate         # the estimate only, no API calls
pnpm tournament --game fighter --a jev --b openai --matches 50   # a run like the published ones
pnpm leaderboard                                 # rebuild the summaries and the leaderboard
```

Paid commands print a cost estimate before anything runs. `pnpm match` and `pnpm tournament` refuse
a run estimated over $5 unless you pass `--approve-over-5`, and ask before every paid run unless you
pass `--yes`. Live mode always refuses a match estimated over $5. The estimates per Jev vs OpenAI
match, from each game's measured tokens per decision: fighter about $0.09 (up to $0.22 for the
longest possible match), Inbox Invaders about $0.03 (up to $0.09) and Clue Clash about $0.003. They
are estimates; each log records the cost of the tokens the APIs reported.

### Video

```sh
pnpm render fighter/<match id>                    # one committed match to an MP4 (1080x1080)
pnpm render fighter/<match id> --size 1920x1080 --from 10s --to 25s
pnpm render --card outro                          # one card: intro, title-<game> or outro
pnpm cut --dry-run                                # print what each cut holds; renders nothing
pnpm cut                                          # both cuts; --square or --wide for one
```

`pnpm render` takes a committed match as `<game>/<match id>`, or any log as a `.jsonl` path. The
size is `1080x1080` (the default) or `1920x1080`. `--from` and `--to` take a frame number (60 per
second) or seconds such as `2.5s`, and `--to` is exclusive. `--speed 2` plays twice as fast; the
video is always 60 fps. It writes `renders/<game>-<match id>-<size>.mp4` unless you pass `--out`.

`pnpm cut` takes each game's featured match and cuts its end, so each segment closes on the match's
result. It joins the intro card, a title card and a segment for each game, and the outro card into
`renders/arena-square.mp4` (1080 × 1080, about 55 s) and `renders/arena-wide.mp4` (1920 × 1080,
about 1:36). The intro and outro read their numbers from `results/leaderboard.json`.

Both commands need `ffmpeg` on your PATH and stop with a message if it is missing. They also need
Playwright's Chromium (`pnpm exec playwright install chromium`): each run builds the app into a
temp folder and plays render mode in headless Chromium, frame by frame. `renders/` is gitignored.

## How fair is this?

Fairness is the point of the repo.

- **The same inputs.** Both models get the same state (each from its own point of view), the same
  prompt, the same options in the same order and the same cadence: one request in flight at a
  time, at least 100 ms between requests and a 1,000 ms timeout. Each provider makes one warm-up
  call before the clock starts.
- **One frozen prompt per game, never tuned for either model.** Each game's prompt config is hashed
  into every log header, and a test pins the hash, so an edit fails until the hash is changed on
  purpose: fighter `d7ce85c39c9adebe`, Inbox Invaders `4e73962f4f519949`, Clue Clash
  `6417698321204bea`. When a game was dull, we changed the game, not the prompt.
- **Option order rotates.** In our API spike, OpenAI's top pick followed option order: one shuffle
  of the same options changed its pick on 20 of 20 calls, while Jev's pick held. So every question
  gets its own seeded shuffle, the same for both models. The rule is in every log header and every
  decision records its question key, so anyone can rebuild the order each model saw.
- **Sides swap every match** in a tournament (a, b, a, b, ...).
- **Probabilities are API-reported.** Each model plays its API's top choice. The probabilities on
  screen are exactly what the API returned (both APIs round to two decimals). We never compute,
  rescale or sample from them.
- **Slow answers and refusals count against the model.** Invalid matches are rerun, so a rule that
  threw out matches where a model was slow or refused would hide exactly that model's losses.
  - **A timeout is the model's own miss**, in every game. It plays no move, or scores 0 for that
    pick. It never makes a match invalid.
  - **A refusal never makes a match invalid.** A refusal is the API replying but declining to pick.
    It plays like a miss, and the results show each model's refusal rate per game. OpenAI's
    Decisions API refused sometimes. Jev never did.
- **A match is invalid only when the setup failed.** There are three reasons:
  - **Errors over 2%.** A seat's requests fail, or its answers are malformed, on more than 2% of
    its decisions.
  - **A stall.** The machine slept or suspended mid-match. The scheduler records a stall live: a
    real-time tick processed more than 250 ms late, or a turn that ends more than 3 s past its
    deadline. The results also find one in the log: a request that "took" longer than the 1,000 ms
    timeout plus that slack, which only happens while the process is paused.
  - **No decisions.** A model seat in a real-time match made no decisions at all.
- **Invalid matches are rerun and kept, but never scored.** The tournament reruns them, up to 10
  per run. Their logs stay in the repo, and each game's summary lists them with their reasons. The
  results recompute validity from each log under the current rules, so older logs follow them too.
- **Every game checks miss rates over the whole run.** Each model's misses (timeouts and errors)
  are also counted over all its valid matches in a game. Above 2% of its decisions, that game shows
  a warning. None did.
- **One match is excluded by hand.** `results/excluded.json` lists one Inbox Invaders match with its
  reason: the machine slept mid-match before stall detection existed, and its log can't show it. It
  is not scored, and its log stays in the repo.
- **One machine.** All the published runs came from one machine. Every log header carries a
  `runId` that names the machine without saying where it is (`sim` for simulated runs). Runs
  before 2026-10-15 hashed the host name, which macOS changed with the network, so they show three
  ids: `m-156ca376dca4` (the Inbox Invaders baselines and the first fighter baselines),
  `m-f2d69b452ec5` (the last fighter baseline top-up and every Clue Clash run) and
  `m-8b4e585673bf` (the Inbox Invaders head-to-head). From 2026-10-15 the id is hashed from the
  machine's hardware id: `m-e68aa2cc38b5` (the Inbox Invaders head-to-head top-up and the fighter
  head-to-head). Every log's id is in its header, and each game's `results/<game>/summary.md`
  lists the ids its runs used. An optional `RUN_LOCATION` label is logged too.
- **Latency includes the network.** Latency is wall time per request from that machine. The two
  providers are hosted differently, each on its own vendor's network and region (both logged as
  `vendor-api` hosting in every header), so the numbers include each provider's network path from
  that machine, not just model time.
- **Live mode adds a hop; the published runs don't use it.** `pnpm live` starts a local proxy on
  127.0.0.1:8787 that holds the keys, and the `/live` page sends every API request through it. That
  extra local hop is the same for both models, and live mode is left out of the hosted build. The
  published runs were played with `pnpm tournament`, which calls both APIs directly from Node.
  Logs from either path have the same format, and the leaderboard counts every log in `results/`.
- **No speed tiers.** Neither side gets a paid speed tier. OpenAI's endpoint rejects a
  `service_tier` field, so its requests run on the project's default tier.
- **Inbox Invaders' right answers are the dataset's labels** (Mishra & Soni 2022). The label review
  read every candidate message against the three option descriptions. Items whose label the review
  disagreed with were dropped and replaced from the same class, never relabelled. The disagreement
  rate was 5.4% of the 950 messages reviewed, almost all of it dataset smishing that reads as an
  open sales offer. Every committed message passed the review, and both models see the same masked
  text. The method is in [docs/research/game-data.md](docs/research/game-data.md#label-check-2026-10-07).
- **Clue Clash boards were reviewed one at a time.** 29 boards of 16 nouns from Open English Wordnet
  survived four rounds of the board review. Any board where a careful reader could defend a second
  word for a definition was fixed or dropped, and the build rejects definitions that give their
  word away.
- **The reviewers were AI, from neither competitor.** The Inbox label review, its content sweep and
  all four Clue Clash board-review rounds were done by AI reviewers built on Claude (Anthropic), a
  third model family, not Jev or OpenAI Decisions. Each read one message or board at a time against
  a written guide. No person read every item. Flagged items were dropped, never relabelled.
- **Changes are called out.** Any change to a game's state, prompt, options, option order or
  cadence says so in its pull request, and the affected results are rerun.
- **Log headers name commits you won't find here.** Each log's `gitCommit` is the commit the match
  ran on in our private development repo. This public repo is a single squashed snapshot of that
  code, so those hashes don't exist here. Each header's `gameVersion` and prompt hash still show
  which rules and prompt a match was played under.

The full rules are in [docs/architecture/core.md](docs/architecture/core.md), and the API facts and
spike numbers in [docs/research/decision-apis.md](docs/research/decision-apis.md).

## Adding a provider

A provider that speaks an existing format (Jev's `systemone`, or `openai-decisions`) is config
only. For yourself, add an entry to a gitignored `providers.local.json` and its key to `.env`; it
then shows up in `pnpm match --list` and in live mode. To build one in, add it to
`src/core/classifier/providers.ts` with recorded fixtures in `test/fixtures/<id>/`; the conformance
suite fails without them. A new API format is one adapter file. Every provider gets the same
fairness rules. See [docs/architecture/providers.md](docs/architecture/providers.md), which walks
through an untested example for Cloudflare's Clef-flash.

## Adding a game

A game is a folder under `src/games/<id>/` that implements one contract (`src/core/game.ts`): a
pure, deterministic engine, the view each model gets, one frozen prompt and the result. Register it
in `src/games/index.ts` and add a renderer under `src/web/games/<id>/`, and the CLIs, the proxy, the
leaderboard and the replay pages pick it up. Real-time and turn-based games share the same
schedulers, log format and replay. See [docs/architecture/games.md](docs/architecture/games.md) for
the steps.

## Development

```sh
make lint format-check typecheck test build  # the checks CI runs
pnpm test:determinism                        # replay every committed log in Node and Chromium
```

The docs start at [docs/README.md](docs/README.md). Repo rules are in [RULES.md](RULES.md).

## Credits

- Inspired by [llm-colosseum](https://github.com/OpenGenerativeAI/llm-colosseum), where LLMs play a
  fighting game against each other. This repo uses none of its code.
- Inbox Invaders uses a sample of the SMS Phishing Dataset by Sandhya Mishra and Devpriya Soni,
  which includes the SMS Spam Collection by Tiago A. Almeida and José M. Gómez Hidalgo (both CC BY
  4.0). Clue Clash uses Open English Wordnet 2025 (CC BY 4.0), derived from Princeton WordNet 3.1
  (WordNet License). Credits, changes and license texts are in [data/NOTICE.md](data/NOTICE.md).
- The art is original and drawn in code. Every asset and its source is listed in
  [docs/assets.md](docs/assets.md).

## License

Code MIT; files under data/ keep their own licenses. See [LICENSE](LICENSE) and
[data/NOTICE.md](data/NOTICE.md).

Not affiliated with or endorsed by TypeSafe or OpenAI. No other studio's characters, names or
assets are used.
