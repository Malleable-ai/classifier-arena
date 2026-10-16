# Providers

A provider is one decision API that can play a seat in any game: an entry in the registry
(`src/core/classifier/providers.ts`) that names its wire format, endpoint, model, key variable,
hosting, option limit and a dated price. Two formats exist (`src/core/classifier/formats/`):

| Format             | Used by                                  | State goes in              | Options go in                                   |
| ------------------ | ---------------------------------------- | -------------------------- | ----------------------------------------------- |
| `systemone`        | Jev (TypeSafe); Cloudflare Clef claims compatibility | `state` (JSON object)      | `questions.<name>.criteria` (id → description) |
| `openai-decisions` | OpenAI Decisions                         | `input` (JSON string)      | `questions[].choices` (`{ value, description }`) |

Only `jev` and `openai` are built in:

| Provider | Label | Model sent | Hosting | Input price (as of) |
|---|---|---|---|---|
| `jev` | Jev (TypeSafe) | `jev-latest` | `vendor-api` | $0.042 / M tokens (2026-10-07) |
| `openai` | OpenAI Decisions (gpt-6-luna) | `gpt-6-luna` | `vendor-api` | $0.10 / M tokens (2026-10-07) |

Output is free for both. Each header also records the model version the warm-up call reported
(`modelVersion`). Both are vendor APIs, each on its own vendor's network, so latency measured from
one machine includes a different network path to each. `hosting` is logged in every header so that
a provider at the edge or on the local machine is never compared with them without saying so.

Every player is `argmax`: its choice is the API's top `choice`. Probabilities are logged and drawn,
never used to choose.

## Fairness rules every provider inherits

- A provider gets the game's `view` for its seat as the state, the game's question (name,
  instructions and options from its frozen prompt config) and core's option order
  (`src/core/classifier/order.ts`). The schedulers memoise each ordered question by key, so both
  seats get the same `Question` object. An adapter only reshapes the state and question; it never
  adds, drops or reorders.
- `test/core/classifier/conformance.test.ts` checks every built-in provider: its request body for
  the fighter's sample state and canonical question equals its recorded
  `test/fixtures/<id>/choice-ok.request.json` byte for byte, its recorded answer parses to one of
  the options, and its recorded `choice-error-<status>.json` maps to status `error`. For every pair
  of providers, `extractShared` returns identical instructions, options (ids, descriptions, order)
  and state, for the canonical and a rotated option order. A 16-option question with a non-fighter
  state is also carried intact by every format (a shape check; no API is called).
- Keys reach a decider only through `deps.env`. Nothing in `src/core/` reads the process
  environment, and request headers are never logged, returned or stored in snapshots.
- No paid speed tier one side gets and the other doesn't. (`service_tier` isn't sent to OpenAI; the
  endpoint rejects it.)

## The option limit, checked per question

`capabilities.maxOptions` is the most options one question may have. The provider decider checks it
on every question: a question with more options is answered at once with status `error`
(`too many options: <n> > <max>`), latency 0 and cost 0, and no request is sent. The scheduler
logs it like any other error, so it counts as a miss. An entry with `maxOptions` under 2 is
rejected when the provider is resolved.

| Provider | `maxOptions` | Source |
|---|---|---|
| `jev` | 255 | TypeSafe's API docs |
| `openai` | 16 | OpenAI publishes no limit. The API spike confirmed 11 (the fighter) and Clue Clash's live smoke matches (2026-10-08) confirmed 16. Above 16 is untested |

## Add a provider

### Path 1: it speaks an existing format (config only)

Either:

- **Local, for yourself:** add an entry to `providers.local.json` in the repo root. It's gitignored,
  read by `loadProviders()` in Node (`pnpm match` and the live proxy both call it), and validated
  field by field. It can't reuse a built-in id and must name an existing format. In code, pass the
  merged list to `listPlayers(env, providers, baselines)` and `createPlayer(id, deps)`.
- **Built in, for everyone:** add the entry to `PROVIDERS` and record its fixtures in
  `test/fixtures/<id>/`: `choice-ok.request.json` (the body for the sample state), `choice-ok.json`
  (a real answer) and at least one `choice-error-<status>.json`. The conformance suite fails for a
  provider without fixtures, so none can be registered without a recorded response.

Entry fields:

| Field              | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `id`, `label`      | Player name on the CLI (lowercase `a-z`, `0-9` and `_` only: it goes in match ids), and the display label |
| `format`           | `systemone` or `openai-decisions`                                                      |
| `url`              | Endpoint. May hold `{ENV_NAME}` placeholders, each listed in `extraEnv`                |
| `model`            | Model id sent in the body                                                              |
| `auth`             | `{ header, scheme, keyEnv }`: e.g. `authorization` / `Bearer` / `MY_KEY`; scheme `""` sends the bare key |
| `extraEnv`         | Other env vars the URL needs (an account id, say)                                      |
| `responseEnvelope` | `"result"` unwraps `body.result` (Cloudflare's REST convention); omit or `null` otherwise |
| `hosting`          | `vendor-api`, `edge` or `local`, recorded in every match header                         |
| `capabilities`     | `{ probabilities, maxOptions }`. `maxOptions` is checked per question (above); under 2 is rejected |
| `price`            | `{ inputPerMTokUsd, outputPerMTokUsd, asOf, source }`. Cost is input tokens × price     |

### Path 2: a new format

Add `src/core/classifier/formats/<id>.ts` implementing `DecisionFormat` (`buildBody(state,
question, model)`, `parseBody(body, question)`, `extractShared(body)`, and its `serviceTier`), add
its id to `FormatId` and `FORMAT_IDS`, register it in `formats/index.ts`, and add format tests next
to `test/core/classifier/formats/`. `parseBody` must throw `InvalidAnswer` for a choice that isn't
one of the question's options, and never sample. When the API declines to answer, it throws
`Refusal`, so the decider logs a `refusal` (which never counts toward validity) rather than an
error. Then add the provider as in path 1, with
fixtures.

## Worked example: Cloudflare Clef-flash (untested by this repo)

> **Untested.** This repo has never called Clef. The REST URL, the `{ result }` envelope and whether
> `usage.input_tokens` comes back are unconfirmed. Check Cloudflare's Workers AI docs
> (<https://developers.cloudflare.com/workers-ai/>) and pricing page before relying on it, and
> don't compare its latency with the vendor APIs without noting it runs at the edge.

`providers.local.json`:

```json
[
  {
    "id": "clef_flash",
    "label": "Clef-flash (Cloudflare Workers AI)",
    "format": "systemone",
    "url": "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash",
    "model": "@cf/cloudflare/clef-flash",
    "auth": { "header": "authorization", "scheme": "Bearer", "keyEnv": "CLOUDFLARE_API_TOKEN" },
    "extraEnv": ["CLOUDFLARE_ACCOUNT_ID"],
    "responseEnvelope": "result",
    "hosting": "edge",
    "capabilities": { "probabilities": true, "maxOptions": 11 },
    "price": {
      "inputPerMTokUsd": 0.09,
      "outputPerMTokUsd": 0,
      "asOf": "2026-10-03",
      "source": "Secondary report; confirm on the Workers AI pricing page"
    }
  }
]
```

Then set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.env` and pick `clef_flash` as a
player. Its option limit is unpublished, so the entry claims only the fighter's 11; a question with
more options gets `error` for that seat until the limit is confirmed and raised. If the response
has no `usage.input_tokens`, its cost is logged as 0.
