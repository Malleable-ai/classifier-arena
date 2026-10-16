# Clue Clash

Clue Clash's rules as built: a turn-based reverse dictionary. Both models see the same definition
and pick the word it defines from the same 16 close-meaning words. Each definition is revealed in
three steps, and both models pick at every step, so knowing a word early scores more. Where this
page and the code disagree, the code wins and this page gets fixed.

- Engine: `src/games/clues/engine/` (`types.ts`, `engine.ts`, `hash.ts`)
- On the game contract: `src/games/clues/game.ts` (`cluesGame`); view, prompt and data beside it
- Data: `data/clues/boards.json`, built by `pnpm data:clues` (`src/cli/build-clues-data.ts`,
  `src/games/clues/data-build.ts`)
- Renderer: `src/web/games/clues/`

`cluesGame.version` is 2 (version 1 asked each word once, with its whole definition). Any rule
change bumps it, which makes older logs unreplayable on purpose.

## A match

- **The board.** `create` picks one of the 29 committed boards by seed, then shuffles the order its
  16 words are asked in with the same seeded stream (sfc32 Fisher–Yates). Every word is asked once.
- **Progressive reveal.** A definition split on whitespace into n words shows its first ceil(n/3)
  words at step 1, ceil(2n/3) at step 2 and all n at step 3 (a short definition can show the same
  text at two steps). Turn t asks word `floor(t / 3)` at step `t % 3 + 1`: 16 words × 3 steps =
  **48 turns**, 48 decisions per model.
- **Scoring.** Both models pick at once at every step, and every right pick scores +1. Both can
  score on the same step, so knowing a word from its first step is worth 3 points. A timeout or an
  error scores nothing.
- **Result.** After 48 turns the higher score wins. A tie goes to the lower mean latency over
  correct answers (each latency rounded to whole ms, compared exactly with integers; a seat with
  no correct answer loses to one with any); then a draw.
- **Timing.** The core turn scheduler: both seats are asked at once with the same 1,000 ms deadline
  from the start of the turn, and the next turn starts 100 ms after both have answered or missed.

**Events:** `clue` every turn (`turn`, `word`, `step`, whether each seat was right) and, after a
word's third step, `reveal` (`turn`, `word`, `answer`).

**Validity:** as a turn game, a match is invalid only when a seat's transport errors pass 2% of
its decisions, or on a stall (a turn that ends more than 3 s past its deadline, or a logged request
longer than the timeout plus 3 s). A timeout scores 0 instead. A refusal scores 0 too and never
counts toward validity. The 2% miss limit (timeouts and errors, not refusals) is also checked per
player over the whole published run ([core.md](core.md#validity-validityts)).

## On the game contract (`game.ts`)

- A `TurnGame`, graded. No baselines of its own, so `random` (core) is the only one.
- **Question:** `which_word`, keyed `t<word>` (the word's place in the seeded order, 0 to 15), with
  all 16 board words as options. All three steps of a word ask under the same key, so the option
  order (core's rule) holds across them, and both seats get the same order.
- **Config:** the board set's identity, `{ boardsSha256, boardCount }`, never the boards. A replay
  refuses a log made with other boards.

## What the models see (`view.ts`)

```json
{ "definition": "a light brief snowfall …", "part_of_speech": "noun", "reveal_step": "1/3" }
```

`definition` is the revealed words, with a trailing ` …` while some are hidden. Nothing else: no
board words (they are the options), no board id, no score, no turn number. State format version 2
(version 2 added `reveal_step`).

## The question and the prompt (`prompt.ts`)

`CLUES_PROMPT_CONFIG`: `version: 2`, `questionName: 'which_word'`, `options: 'per-question'` (the
board's words), `optionTemplate: 'The word "<lemma>".'`, `stateFormatVersion: 2`. An option's id is
the word itself (a–z only); its description is the template with the word filled in. The primer:

> Reverse dictionary: the state gives a definition and its part of speech. Pick the one word on the
> board that this definition defines. The board words are close in meaning, so read the definition
> carefully. Exactly one option is correct.

The prompt is the same at every step. Its hash, `promptConfigHash(CLUES_PROMPT_CONFIG)`, is
**`6417698321204bea`**, pinned in `test/games/clues/prompt.test.ts`. Version 2 added the option
template to the config so the hash covers the option text; the text models see didn't change.

## The boards

29 boards of 16 nouns each, from Open English Wordnet 2025, core edition (CC BY 4.0, derived from
Princeton WordNet 3.1 under the WordNet License). A board's words are kinds of one thing (the
hyponyms of one hypernym and their close neighbours), and each word's definition is the gloss of
one of its common senses. The build rejects any word whose gloss gives it away (the word, a form
of it, a compound part, a root or a Latin genus name). Every board was read by AI reviewers
(Claude, neither of the competing models), one board at a time against a written guide, over four
rounds; no person read every board. A board where a careful reader could defend a second word for
any definition was fixed or dropped. Adjective and verb boards didn't survive the review, because their glosses are written
with near-synonyms. Full method: [game-data.md](../research/game-data.md#clue-clash-board-review-2026-10-07);
credits, changes and the WordNet License: [data/NOTICE.md](../../data/NOTICE.md).
`test/games/clues/data.test.ts` pins the board set's hash and counts.

## Originality

Clue Clash is an original game. It has no teams, no clue-giver, no hidden key or card, and no
single clue that points at several words, and it uses none of the names or terms of the team
word-association board game it could be mistaken for. `test/originality.test.ts` holds that list
(the one file that spells it out), fails the build if any term appears anywhere in the repo, and
the board build filters the same terms from words and definitions by hash
(`src/games/clues/originality.ts`).

## Cost estimate

48 decisions per seat in every match. Input tokens per decision, measured in the live smoke
matches (2026-10-08): Jev 630, OpenAI 320; 650 for an unmeasured provider. Jev vs OpenAI comes to
about $0.003 a match.

## Renderer (`src/web/games/clues/`)

- The stage is 1920 × 1080 logical px. A turn game has no ticks, so the timeline makes its own
  frames at 60 fps: each step is prompt → each answer landing at that model's logged latency (1 ms
  of latency is 1 ms on screen, capped at 1 s) → score, at least 1.2 s in all, then the word's
  reveal (1.5 s) after its third step. At typical latencies a match runs about 82 s.
- The look is a dictionary entry with its headword hidden: the definition in a serif band on top,
  its hidden words blacked out until their step, a "Clue n / 3" marker. Under it, one 4 × 4 board
  per model: every tile is a board word, shaded by that model's API-reported probability for the
  step on screen. Each board marks the model's three steps on the word and pops "+1" when a step
  scores; the right word is revealed after the third step.
- The panel shows the top 3 probabilities. Chapters are each word's first step.
- Drawn in code, with no image files ([assets.md](../assets.md)).
