# Data notices

Code MIT; files under data/ keep their own licenses.

The code in this repository is under the MIT license (`LICENSE`). The datasets under `data/` are
not: each section below gives a dataset's credit, license and the changes we made. Every dataset is
also listed in `docs/assets.md`.

## Inbox Invaders: SMS messages

Files: `data/inbox/messages.json` (built by `pnpm data:inbox` from `src/cli/build-inbox-data.ts`)
and `data/inbox/exclude.json` (ids dropped after the label review and the content sweep).

> Contains a sample of the SMS Phishing Dataset for Machine Learning and Pattern Recognition by
> Sandhya Mishra and Devpriya Soni (Mendeley Data, V1, 2022, https://doi.org/10.17632/f45bkkt8pr.1),
> CC BY 4.0. That dataset includes the SMS Spam Collection by Tiago A. Almeida and José M. Gómez
> Hidalgo (UCI Machine Learning Repository, 2011, https://doi.org/10.24432/C5CC84), CC BY 4.0.

Changes:

- A seeded, stratified sample of 600 messages: 300 legit, 150 spam and 150 smishing.
- Labels lower-cased; `ham` renamed `legit`. The dataset's URL, EMAIL and PHONE flag columns are
  not used.
- Dropped before sampling: texts labelled both spam and smishing, duplicates (after case and
  whitespace folding), rows with encoding garbage (U+FFFD, stray cp1252 control bytes, mis-decoded
  characters), and every row with an HTML-escaped NUS SMS Corpus placeholder such as `&lt;#&gt;`
  or `&lt;TIME&gt;`. Only legit messages had those placeholders, so they would have given the
  label away.
- `&amp;` unescaped to `&`, typographic quotes and dashes changed to ASCII, and whitespace
  collapsed.
- Personal names, email addresses and phone numbers masked as `<name>`, `<email>` and `<phone>`,
  including numbers the source had already blanked out (such as `07xxxxxxxxx`).
- URLs defanged (`hxxp://`, `example[.]com`); the domain text is kept. A space is added after `@`
  in `@handles` so they don't become mentions.
- Messages that became identical after masking were dropped.
- Messages longer than 240 characters cut at a word boundary and ended with `…`.
- The label review and the content sweep were done by AI reviewers (Claude), each reading one
  message at a time against a written guide; no person read every item.
- Items whose label the review disagreed with, and OCR garbage, are dropped (never relabelled) and
  replaced from the same class. So are items with offensive, explicit or crude content (a content
  sweep on 2026-10-08). Their ids and the reasons are in `data/inbox/exclude.json`.

The message texts were written by third parties. The CC BY 4.0 grants cover only the rights the
dataset authors hold; as the Mendeley record notes, further permission may be required for content
that belongs to a third party.

Licenses and sources:

- SMS Phishing Dataset for Machine Learning and Pattern Recognition:
  https://doi.org/10.17632/f45bkkt8pr.1 (CC BY 4.0)
- SMS Spam Collection: https://doi.org/10.24432/C5CC84 (CC BY 4.0)
- CC BY 4.0: https://creativecommons.org/licenses/by/4.0/

## Clue Clash: Open English Wordnet

> Contains material from Open English Wordnet 2025 (https://en-word.net), © 2019–present The Open
> English Wordnet Team, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
> Open English Wordnet is derived from Princeton WordNet 3.1, © 2011 Princeton University, used
> under the WordNet License below. Modified: subset selected; decoys derived from relations.

Source: the Open English Wordnet 2025 core edition (not "Plus"), JSON release
`english-wordnet-2025-json.zip`, from
https://github.com/globalwordnet/english-wordnet/releases/tag/2025-edition. The file
`data/clues/boards.json` is built from it by `pnpm data:clues` (`src/cli/build-clues-data.ts`),
which also reads the board review's lists, `data/clues/exclude.json` and `data/clues/drop.json`.

### Changes

- **Subset selected.** 29 boards of 16 single-word lemmas each, all of nouns. Each board's words
  come from one part of the Wordnet: the hyponyms of one hypernym and their close neighbours. The
  other words, senses and relations are not included.
- **One sense per word.** Each word keeps one of its most common senses, shown by that synset's
  first gloss. Usage examples, pronunciations and relations are dropped.
- **Glosses tidied.** Whitespace and trailing punctuation are normalised. The wording is
  otherwise unchanged.
- **Words left out.** Words with offensive, crude or slang usage labels or glosses, words on a
  hand-built blocklist, and some sensitive or technical topics.
- **Definitions don't give their word away.** The rule is that a word's gloss never contains the
  word or a form of it (an inflection, a derived or Latin form such as "architectural" or
  "Geraniaceae", or half of a compound), nor another word on its board. The build enforces it
  with a text check that rejects any word whose gloss breaks it, and the board review checked the
  boards too. A text check can miss an unusual form; one that slipped through would be a bug in
  the data, to be fixed by a rebuild.
- **Board review.** Every board was read by AI reviewers (Claude), one board at a time against a
  written guide; no person read every board. Words that let a gloss fit two board words were taken
  off that board (`data/clues/exclude.json`) and replaced from the same part of the Wordnet;
  boards still ambiguous after a second reading, or flagged in a final full re-read, were dropped
  (`data/clues/drop.json`). The review is described in `docs/research/game-data.md`, "Clue Clash
  board review".
- **Ids added.** Board ids (`b001`), word ids (`w01`) and a board label taken from the hypernym.

### WordNet License

The license text as shipped with Open English Wordnet (`WNDB_License.txt`), with its line-number
prefixes removed:

```text
This software and database is being provided to you, the LICENSEE, by
the Open English Wordnet team under the Creative Commons Attribution 4.0
International License (CC-BY 4.0).

Open English Wordnet 2023 Copyright 2023 by the Open English Wordnet team.

Permission to use, copy, modify and distribute this software and
database and its documentation for any purpose and without fee or
royalty is hereby granted, provided that you agree to comply with
the following copyright notice and statements, including the disclaimer,
and that the same appear on ALL copies of the software, database and
documentation, including modifications that you make for internal
use or for distribution.

WordNet 3.1 Copyright 2011 by Princeton University.  All rights reserved.

THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON
UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON
UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANT-
ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT
INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR
OTHER RIGHTS.

The name of Princeton University or Princeton may not be used in
advertising or publicity pertaining to distribution of the software
and/or database.  Title to copyright in this software, database and
any associated documentation shall at all times remain with
Princeton University and LICENSEE agrees to preserve same.
```

### Citation

John P. McCrae, Alexandre Rademaker, Francis Bond, Ewa Rudnicka and Christiane Fellbaum. 2019.
"English WordNet 2019 – An Open-Source WordNet for English". In _Proceedings of the 10th Global
Wordnet Conference (GWC 2019)_, pages 245–252, Wrocław, Poland. Global Wordnet Association.
https://aclanthology.org/2019.gwc-1.31
