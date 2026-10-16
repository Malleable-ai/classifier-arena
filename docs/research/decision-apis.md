# Decision APIs: what we know (as of 2026-10-07)

What the two APIs do, what they cost, what's been built with them, and what's still unknown. Each fact
says where it came from. **Official** means the vendor's own docs. **Secondary** means a third-party
article or a search summary, so confirm it before relying on it. **Spike** means our own calls on
2026-10-07, summarized in [Spike findings](#spike-findings-2026-10-07).

## Jev (TypeSafe AI)

- **What it is:** a "System One" decision model, not an LLM. You send a state (a string or JSON) and
  a set of typed questions (choice, score, yes/no), and it returns a typed answer for each one. It
  doesn't generate text. Launched in early access on Sep 15, 2026. (Official launch post; secondary
  sources disagree on whether there's still a waitlist.)
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>` and
  model `jev-latest`. Responses name the concrete version, e.g. `jev-1.13.0`. (Official API docs.)
- **Choice question shape:** questions are an object keyed by question name. Each choice question has
  `type: "choice"`, `instructions`, and `criteria`, a map of option name to option description. Up to
  255 options. (Official API docs.)
- **Choice answer shape:** `choice` (the top option), `probabilities` (every option mapped to a
  probability, summing to 1) and `confidence`, plus `usage.input_tokens`. (Official API docs.)
- **Price:** $0.042 per million input tokens. Output is free. (Official launch post.)
- **Latency:** TypeSafe claims 70–500 ms. OpenRouter telemetry on Oct 1 showed p50 0.21 s, p95 0.34 s,
  p99 0.75 s. (Secondary: Firecrawl.)
- **Rate limits:** set per organization by tier, shared across all keys in the org, and shown in
  the TypeSafe console (the responses carry no rate-limit headers). Over the limit it returns
  `429 Too Many Requests`; back off and retry. (Official.)
- **Billing:** prepaid balance; requests stop when it runs out, so the balance is a hard cap. API
  keys are organization-scoped. (TypeSafe console.)
- **Context:** 32K on OpenRouter, 64K per TypeSafe's docs. (Secondary.)
- **Input:** text or JSON only. No images. (Secondary: Firecrawl.)
- **Weaknesses TypeSafe documents:** counting and arithmetic, comparing dates, multi-hop reasoning,
  long or noisy context, contradictory criteria, and instructions injected into the data. (Official
  model-jaggedness page.) **Design consequence:** give it precomputed fields (distance, range bucket,
  ticks until a fireball hits) rather than raw coordinates it has to subtract.
- **Also available on:** OpenRouter (`typesafe/jev-1.13`). That adds a network hop, so don't use it
  for timed matches unless both models go through the same kind of router.
- **Launch demand:** TechCrunch reported the API briefly couldn't serve everyone at launch.

## OpenAI Decisions API

- **What it is:** the same idea from OpenAI. It answers predefined questions with typed answers and
  no generated text. Previewed at DevDay on Sep 29, 2026, and opened to all developers as a **public
  beta on Oct 6, 2026**. OpenAI says GA is "in the coming weeks". It is not GA yet. (Official docs.)
- **Endpoint:** `POST /v1/decisions` on `https://api.openai.com`, model `gpt-6-luna` (the only
  model). (Official docs.)
- **Choice question shape:** `questions` is an array. Each choice question has `type: "choice"`, a
  `name`, `instructions`, and `choices`, an array of `{ value, description }`. The state goes in
  `input`. (Official docs.)
- **Choice answer shape:** `answers` is an array of `{ type, name, choice, probabilities, confidence }`.
  Here `probabilities` is an array of `{ value, probability }`. (Official docs.)
- **Price:** $0.10 per million input tokens. No output, cache-read or cache-write charges. (Official
  docs.)
- **Latency:** OpenAI's published figure is 150 ms, against 1.6 s for regular GPT-6 Luna. (Secondary
  reports of the launch material.)
- **Rate limits:** not published. Each response reports the project's limits in `x-ratelimit-*`
  headers (see Spike findings). (Spike.)
- **Speed tiers:** OpenAI projects can allow non-standard service tiers (Flex, Fast, Ultrafast; the
  project default is Standard). This repo uses Standard only, for fairness. (OpenAI console,
  2026-10-07.) The Decisions endpoint rejects a `service_tier` field (400 `unknown_parameter`), so
  requests omit it and run on the project default. (Spike, 2026-10-07.)
- **Spend cap:** project spend limits can be enforced as a hard limit (requests fail with 429 once
  reached). (OpenAI console, 2026-10-07.)
- **Context and option limits:** not published. (Unknown.)
- **Input:** text, or images as inline base64 data URLs. Hosted image URLs and file ids aren't
  supported. (Official docs.)
- **Caveat from early testers:** choice probabilities looked poorly calibrated and sensitive to option
  order. (Secondary: OpenAI developer community thread.) **Design consequence:** both models get the
  same option order every time, reshuffled by seed for each question. The spike confirmed the order
  sensitivity (below), and the decision panel labels the numbers "API-reported".

## Cloudflare Clef and Clef-flash (Workers AI)

Not tested or used by this repo. It uses Jev's format, so it can be added as a provider by config;
`docs/architecture/providers.md` walks through it as the example.

- **What it is:** Cloudflare's first in-house decision models, released Oct 1, 2026. Clef (27B, from
  Qwen3.8-27B) and Clef-flash (9B, from Qwen3.5-9B), open weights under Apache 2.0 on Hugging Face,
  hosted on Workers AI. (Official changelog; sizes and bases: secondary.)
- **API format:** follows TypeSafe's System One API, so Cloudflare says a Jev integration switches
  by changing only the endpoint and model. Same question types (`noul`, `choice`, `score`), up to 64
  questions per request. The binding example takes `state` and `questions.<name>.criteria` and reads
  `answers.<name>.choice`. (Official changelog.) **Unverified:** the REST call is
  `POST https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/clef-flash`
  with a Workers AI API token, and Cloudflare's REST API usually wraps responses in
  `{ result, success, errors }`. Whether the answer is wrapped, and whether `usage.input_tokens` is
  returned, are unconfirmed; this repo doesn't check them.
- **Models:** `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`, 64K context. Text, JSON and up
  to four images. (Official changelog.)
- **Price on Workers AI:** Clef $0.24 and Clef-flash $0.09 per million input tokens. (Secondary,
  read Oct 3; confirm on the Workers AI pricing page.)
- **Latency:** Cloudflare-run, across 43 benchmark runs: Clef-flash median 38.8 ms, p95 122.4 ms;
  Clef median 209.3 ms; Jev median 524.1 ms in the same run. (Official changelog, vendor-run.)
  Workers AI runs at the edge, close to the caller, so part of that lead is network distance. That's
  why the repo records each provider's hosting.

## Other decision models (not supported yet)

The class is converging on the same three question types. None of these ship in the repo; they're
here so the provider registry's shape fits them. (All secondary, Digital Applied, read Oct 3.)

- **Strands Decider 2B** (Amazon Strands Labs, Oct 1): Apache 2.0, weights plus training data and
  scripts. Runs locally through the `strands-decider` CLI, about 115 ms on an RTX 3090 and 153 ms on
  an M3 MacBook (Amazon-run). 4,096-token serving window, text only. Its API format would need its
  own adapter, and it would be a `local` provider with no network hop.
- **Tev1 4B** (Together, experimental): on OpenRouter at $0.042 per million input tokens. Keeps a
  language-model head and returns one answer letter with log-probabilities, not a probability per
  option, so it sits at the edge of the class.
- **Laya, Kev 9B and others:** smaller open releases. Cloudflare's run measured Laya at a 5.8 ms
  median and Kev 9B at 51.4 ms.

## Side by side

|                          | Jev                         | OpenAI Decisions            |
|--------------------------|-----------------------------|-----------------------------|
| Input price              | $0.042 / M tokens           | $0.10 / M tokens            |
| Output price             | free                        | free                        |
| Typical latency          | 170 ms p50, 251 ms p95 (spike, direct) | 184 ms p50, 282 ms p95 (spike) |
| Inputs                   | text, JSON                  | text, base64 images         |
| Per-option probabilities | yes                         | yes                         |
| Status                   | early access                | public beta                 |
| Rate limits              | per-org tier (console); no headers | per project (`x-ratelimit-*` headers) |

## Spike findings (2026-10-07)

Before the harness existed, a throwaway script made 185 sequential calls from one Mac: 92 to Jev
and 93 to OpenAI Decisions, all with the fighter's sample state, its 11 options and the same
instructions. The script and its raw numbers were removed at launch (they stay in git history).
What still matters is below. The requests and responses it recorded are the conformance fixtures
in `test/fixtures/jev/` and `test/fixtures/openai/`, and the fighter's frozen prompt is its exact
wording. (Our measurements.)

### Shapes

- **Jev: confirmed.** `POST /v1/systemone` with `model: "jev-latest"`, `state` (a JSON object is
  accepted as is) and `questions.next_move = { type: "choice", instructions, criteria }`. The
  response has `model`, `answers` and `usage`, with no `id`. `answers.next_move` has `type`,
  `choice`, `confidence` and `probabilities`, an object keyed by option name that does **not**
  come back in request order, so map by name. `usage` has `input_tokens` and `output_tokens`
  (output was reported, 107, but is free). No rate-limit headers.
- **Jev error:** a request without `questions` returns **422, not 400**, a FastAPI-style
  `{ detail: [{ type: "missing", loc: ["body", "questions"], msg, input }] }` that echoes the
  request body (`choice-error-422.json`).
- **OpenAI: confirmed, except `service_tier`.** `POST /v1/decisions` with `model: "gpt-6-luna"`,
  `input` (the state as a JSON string) and `questions: [{ type: "choice", name, instructions,
  choices: [{ value, description }] }]`. **Sending `service_tier` returns 400 `unknown_parameter`**
  (`service-tier-error-400.json`), so requests omit it and run on the project's default tier,
  Standard. The response has `model` (`gpt-6-luna`, with no dated version), `answers` and `usage`;
  `answers[0].probabilities` is an array of `{ value, probability }` in request order; `usage` has
  `input_tokens`, `input_tokens_details` (`cached_tokens`, `cache_write_tokens`), `output_tokens: 0`
  and `total_tokens`.
- **OpenAI error:** a request without `questions` returns 400 `{ error: { message, type:
  "invalid_request_error", param: "questions", code: "missing_required_parameter" } }`.
- **Model versions reported:** Jev `jev-1.13.0`; OpenAI `gpt-6-luna`.
- **Probabilities are rounded to two decimals** by both APIs, and `confidence` is not the top
  probability (Jev 0.66 against 0.69; OpenAI 0.41 against 0.46).

### Latency

50 sequential calls each, timed with `performance.now()` around `fetch`, body included. No
errors, no retries. Every one of the 50 calls picked the same move (Jev `fireball`, OpenAI
`heavy_punch`).

|                  | p50    | p95    | p99    | mean   | min    | max    |
| ---------------- | ------ | ------ | ------ | ------ | ------ | ------ |
| Jev              | 170 ms | 251 ms | 345 ms | 179 ms | 129 ms | 345 ms |
| OpenAI Decisions | 184 ms | 282 ms | 365 ms | 193 ms | 147 ms | 365 ms |

The first call to each was slower (Jev 960 ms, OpenAI 625 ms), which is why every match makes one
warm-up call per provider before the clock starts. With 50 samples, p99 is the slowest call. The
fighter's cost estimate still uses these p50s (`src/games/fighter/estimate.ts`).

### Tokens per decision

The same text counts differently: **Jev 1,166 input tokens, OpenAI 782**, identical on every call.
The whole spike cost about $0.012 from reported tokens (Jev about $0.0045, OpenAI about $0.0073).

### Rate-limit headers

- **OpenAI** returns `x-ratelimit-limit-requests` and `x-ratelimit-limit-tokens`, the matching
  `remaining` and `reset` headers (resets like `28ms` and `3ms`, which suggest a per-minute window)
  and `openai-processing-ms`.
- **Jev** returns no rate-limit headers, only standard Cloudflare ones, so the console is the only
  place to see the limits.

### Order sensitivity

20 calls with the canonical option order and 20 with one fixed shuffle
(`throw, block_low, fireball, walk_back, uppercut, jab, jump_in, walk_forward, sweep, heavy_punch,
block_high`), same state. Probabilities are mapped back by option name.

|                                            | Jev                     | OpenAI Decisions                              |
| ------------------------------------------ | ----------------------- | --------------------------------------------- |
| Top choice, canonical order                | `fireball` 20/20        | `heavy_punch` 20/20                           |
| Top choice, shuffled order                 | `fireball` 20/20        | `sweep` 20/20                                 |
| Shuffled top choice differs from canonical | 0/20                    | 20/20                                         |
| Mean absolute probability shift per option | 0.035                   | 0.102                                         |
| Largest shift                              | `fireball` 0.71 → 0.52  | `sweep` 0.04 → 0.38, `block_high` 0.28 → 0.01 |
| Run-to-run spread, same order              | up to 0.07 (`fireball`) | 0 (identical every call)                      |

OpenAI is deterministic for a fixed input, but its pick depends on option order; Jev is slightly
noisy but kept its pick. This is one state, so it's an indication, not a calibration study. It is
why both models always get the same option order, and why that order is reshuffled by seed for
every question key (`src/core/classifier/order.ts`), so no fixed order favours either model.

## Cost model

- **Fighter** (estimated on 2026-10-07): the spike's tokens per decision, about 3–4 decisions per
  second per fighter, and up to about 3 minutes per best-of-3 match. Tokens per fighter per match:
  Jev about 1,166 × 3.5 × 180 ≈ 735K, OpenAI about 782 × 3.5 × 180 ≈ 493K. Jev about $0.031 and
  OpenAI about $0.049 per match: **about $0.08 per head-to-head match**. The game's estimate in
  code agrees: $0.088 typical, $0.22 for the longest possible match.
- **Inbox Invaders and Clue Clash** are priced from tokens per decision measured in live matches
  (Inbox: Jev 555, OpenAI 343; Clue Clash: Jev 630, OpenAI 320): about $0.035 per head-to-head
  match for Inbox Invaders ($0.085 worst case) and $0.003 for Clue Clash.
- Worst case if prompts grew to ~5K tokens at 10 calls/s: about $1.30 per fighter match. That's why
  every paid command prints its estimate first (`pnpm match --estimate` prints it and stops) and
  asks before any run estimated over $5.
- Spend is capped on both sides: a monthly hard limit on the OpenAI project and a prepaid balance
  on TypeSafe (above).

Nothing else costs money. The games are our own (no ROM or emulator), the art is drawn in code, and
the replay page is static on Vercel.

## Prior art

- **llm-colosseum** (OpenGenerativeAI, MIT, 2024): LLMs fight each other in Street Fighter III
  through the DIAMBRA emulator. The state is converted to text and the LLM picks moves. It's the
  inspiration for this repo, so credit it in the README. We don't use it: it needs a ROM, and it
  compares generative LLMs, not decision models.
  https://github.com/OpenGenerativeAI/llm-colosseum
- **jevbox:** a 3D browser boxing game with a "Street Fighter-style roster", where Jev makes every
  decision. It polls about once a second and samples from Jev's distribution over 22 actions. There
  is no comparison against other models. https://github.com/duc-minh-droid/jevbox
- **jev-arcade:** single-file browser games where you play against Jev. https://github.com/codaaiteam/jev-arcade
- **"Jev Plays Street Fighter 2"** (YouTube): exists, but the details couldn't be confirmed.
  https://www.youtube.com/watch?v=lz_JW_F2lJk
- **TypeSafe's Doom demo:** Jev plays Doom from structured game state about 10 times a second.
  (Secondary.)
- None of these has the two decision APIs fight in the same harness. That's this repo's angle.

## Sources

- TypeSafe launch post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- TypeSafe API docs: https://docs.typesafe.ai/api and quickstart https://docs.typesafe.ai/introduction/quickstart
- TypeSafe model jaggedness (weaknesses): https://docs.typesafe.ai/model-jaggedness/jev-1.13
- Jev on OpenRouter: https://openrouter.ai/typesafe/jev-1.13
- Jev rate limits (secondary): https://jevaiguide.com/jev-rate-limits/
- OpenAI Decisions guide: https://developers.openai.com/api/docs/guides/decisions
- OpenAI public beta announcement thread: https://community.openai.com/t/decisions-api-is-now-available-in-public-beta/1403877
- Firecrawl, Decisions API vs Jev: https://www.firecrawl.dev/blog/openai-decisions-api-vs-jev
- Unite.AI on the public beta: https://www.unite.ai/openai-releases-decisions-api-in-public-beta-powered-by-gpt-6-luna/
- Cloudflare Clef changelog (Oct 1): https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/
- Digital Applied, open decision models compared (Clef, Decider 2B, Jev): https://www.digitalapplied.com/blog/open-decision-models-compared-clef-decider-jev
- MarkTechPost on Clef: https://www.marktechpost.com/2026/10/01/cloudflare-releases-clef-and-clef-flash/
- TechCrunch on Jev (Sep 18): https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/
