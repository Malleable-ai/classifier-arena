# Game data: sources and licenses (as of 2026-10-07)

Where the data for Inbox Invaders and Clue Clash comes from, what license each source carries, and
what we must ship with it. Every fact says where it came from. **Primary** means the dataset's own
record, repository, LICENSE file or release, or our own inspection of the file downloaded from that
record. **Secondary** means a search summary or a third-party page, so confirm it before relying on
it. Downloads used for the counts below live in `.scratchpad/data-raw/` (gitignored, never
committed). The links are collected under [Sources](#sources).

## Inbox Invaders data

### Chosen source: SMS Phishing Dataset (Mishra & Soni, 2022)

- **Record:** "SMS PHISHING DATASET FOR MACHINE LEARNING AND PATTERN RECOGNITION" by Sandhya Mishra
  and Devpriya Soni (Jaypee Institute of Information Technology), Mendeley Data, version 1, published
  2022-06-20, DOI `10.17632/f45bkkt8pr.1`. (Primary: [record][mendeley], [record API][mendeley-api].)
- **License: CC BY 4.0. Matches the earlier claim.** The record's licence field is "CC BY 4.0"
  (Creative Commons Attribution 4.0 International). No non-commercial clause and no redistribution
  ban. Mendeley's license note adds that "further permission may be required for any content within
  the dataset that is identified as belonging to a third party". (Primary:
  [record API][mendeley-api].)
- **Files:** `Dataset_5971.zip` (244,698 bytes, sha256 `9bbf3188…b233cc3`) holds one file,
  `Dataset_5971.csv` (595,987 bytes, sha256 `649844f1…a71e`). The record also has three small Python
  extraction scripts and three PDFs. We didn't run the scripts. (Primary: [record API][mendeley-api].)
- **How it was built:** the record's method lists six steps. The authors browsed the web, converted
  images and screenshots to text with "customized python code" (OCR), and labelled each message
  "based on the source of extraction". There's no per-message annotation and no agreement study.
  (Primary: [record API][mendeley-api], `method` field.)
- **Where the smishing came from:** the record links the UCI SMS Spam Collection, a Pinterest board
  called "smishing dataset", and Sonowal & Kuppusamy's paper ([doi:10.1093/comjnl/bxy039][sonowal]).
  It thanks "Tiago A. Almeida and Dr.Gunikhan Sonowal for making the text messages available".
  (Primary: [record API][mendeley-api].) So the smishing texts probably come from Pinterest
  screenshots plus Sonowal's set. That's our inference; the record doesn't say so outright.
- **Original senders' rights:** the record says nothing about them, which confirms the earlier
  "unaddressed" note. CC BY only covers rights the uploaders hold. Risk stays low: the texts are
  short, and most are spam that its senders broadcast. (Primary: [record][mendeley], by what it
  doesn't say.)
- **The paper the record asks you to cite:** the record asks users to cite a paper with the same
  title as the dataset. We found no paper with that title (Secondary: web search, 2026-10-07). The
  record lists three related papers by the same authors: FGCS 2020
  ([10.1016/j.future.2020.03.021][mishra-fgcs]), Neural Computing and Applications 2021
  ([10.1007/s00521-021-06305-y][mishra-nca]) and SN Computer Science
  ([10.1007/s42979-022-01078-0][mishra-sncs]). We didn't read them: Springer redirects to a login
  page. So the labelling method beyond "by source" is still undocumented.

### What the file contains (our inspection)

All counts come from `Dataset_5971.csv`. (Primary: [our inspection][sms-file].) No message text is
reproduced here.

- **Format:** UTF-8, CRLF line endings, a header row and 5,971 data rows. Every row has 5 fields.
- **Columns:** `LABEL`, `TEXT`, `URL`, `EMAIL`, `PHONE`.
- **Label strings, exactly as written:** `ham` 4,844, `Smishing` 616, `smishing` 22, `spam` 466 and
  `Spam` 23. Case-folded, that's **4,844 ham, 489 spam and 638 smishing**, which matches the record
  (81.1% / 8.2% / 10.7%). Lower-case the labels before use.
- **Flag columns:** each holds `No` or `yes` (lower-case "yes"). The table counts the `yes` values.
  The flags are unreliable: a simple URL pattern disagrees with the `URL` flag on 14 ham, 119 spam and
  123 smishing rows. Recompute the flags if you need them.

  | Flag    | ham | spam | smishing |
  | ------- | --: | ---: | -------: |
  | `URL`   |   8 |   99 |      100 |
  | `EMAIL` |   1 |    7 |       11 |
  | `PHONE` |   7 |  310 |      527 |

- **Duplicates and conflicts:** after case and whitespace folding there are 4,834 distinct ham
  texts, 469 spam and 562 smishing. **34 distinct texts are labelled both spam and smishing.**
- **Broken characters:** a literal U+FFFD replacement character appears in 117 ham, 2 spam and 26
  smishing rows. Some ham rows also contain stray cp1252 control bytes (U+0092, U+0093).
- **NUS placeholders, HTML-escaped:** `&lt;#&gt;` appears 238 times, `&lt;DECIMAL&gt;` 14,
  `&lt;TIME&gt;` 6, `&lt;URL&gt;` once and `&lt;EMAIL&gt;` once, across 200 rows. All of them are
  in ham. **Design consequence:** these tokens give away the label, so drop those rows or rewrite
  the tokens. Drop the U+FFFD rows too; they're encoding garbage.
- **Other class signals:** `£` appears in 5 ham, 94 spam and 184 smishing rows. That fits UK
  premium-rate texts like UCI's Grumbletext spam (our inference). The record doesn't say how UCI's
  747 spam messages were split between `spam` and `smishing`, so expect the spam/smishing boundary
  to be the noisiest part of the review.
- **Personal-data signals (counts only):** in ham, 1 row has an email address, 2 have an `http`/`www`
  link and 6 have a run of 7+ digits. As a rough name signal, 266 ham rows have a capitalised word
  mid-sentence that isn't an Open English Wordnet lemma. That's an upper bound for capitalised
  names; lower-case names, which are common in SMS, are missed. So the reviewer has to read every
  sampled ham message for names. Digit runs show up in 214 spam and 516 smishing rows; those are the
  scammers' or services' numbers. Mask them in every class anyway, so the `<phone>` token doesn't
  appear in one class only.
- **Enough for the planned sample? Yes.** After dropping duplicates, the 34 conflicting texts and
  U+FFFD rows, 4,717 ham, 433 spam and 502 smishing texts remain. That's well above 300/150/150,
  even if the review rejects a third of the spam and smishing.

### Provenance: UCI SMS Spam Collection

- **Record:** "SMS Spam Collection" by Tiago A. Almeida and José M. Gómez Hidalgo. UCI lists him as
  "Jos Hidalgo"; the introductory paper gives "J. M. G. Hidalgo". Donated 2012-06-21, 5,574
  instances, DOI `10.24432/C5CC84`. UCI cites it as "Almeida, T. & Hidalgo, J. (2011). SMS Spam
  Collection [Dataset]. UCI Machine Learning Repository." The introductory paper is Almeida, Gómez Hidalgo & Yamakami, "Contributions to the
  study of SMS spam filtering: new collection and results", ACM DocEng 2011. (Primary:
  [UCI page][uci], [UCI API][uci-api].)
- **License: CC BY 4.0. Matches the earlier claim.** UCI says the corpus was collected from "free or
  free for research sources". (Primary: [UCI page][uci].)
- **Where it came from:** UCI lists four sources. (Primary: [UCI page][uci]; the totals are our sums.)
  - 425 spam texts taken from the Grumbletext UK forum.
  - 3,375 ham texts from the NUS SMS Corpus.
  - 450 ham texts from Caroline Tagg's PhD thesis.
  - The SMS Spam Corpus v.0.1 Big: 1,002 ham and 322 spam.

  That's 4,827 ham and 747 spam.
- **Correction to the earlier note:** not all the ham is NUS. About 70% is (3,375 of 4,827). The
  other 1,452 ham texts come from the Tagg thesis and the v.0.1 corpus and never went through NUS's
  anonymisation. UCI's own sample rows include a ham text with a full phone number. (Primary:
  [UCI page][uci].)
- **"About 4,753 rows from UCI": unconfirmed.** Checking it means diffing against the UCI file, and
  we didn't download it for this pass. Mishra & Soni's 4,844 ham against UCI's 4,827 suggests
  nearly all the ham is UCI's. (Our inference.)

### Personal data in the NUS SMS Corpus

- **Confirmed: numbers, emails and URLs were replaced, but names were kept.** In Chen & Kan's paper,
  section 3.4 "Anonymization", the sender and recipient phone numbers are one-way enciphered.
  Regular expressions replace dates, times, decimals, numbers "with more than one digit", email
  addresses, URLs and IP addresses in the message text with placeholder codes. On names, the
  authors "do not try to remove or replace personal names". They also concede that regexes can't
  guarantee privacy. (Primary: [NUS paper, arXiv:1112.2468][nus-paper].)
- **Consent:** "All contributors were informed about the intended publishing of the resultant
  corpus." (Primary: [NUS paper][nus-paper].) UCI says the same of the volunteers. (Primary:
  [UCI page][uci].)

### Fallbacks

- **UCI SMS Spam Collection alone:** CC BY 4.0, but only two classes (ham and spam), with no
  smishing class. (Primary: [UCI page][uci].)
- **Nazario phishing corpus:** `LICENSE.txt` is the CC BY 4.0 legal code, and `README.txt` says
  "The license for these files is CC-BY-4.0". **Matches the earlier claim.** Both files were last
  modified 2026-02-20. It's email, in mbox files and yearly folders covering 2005 to 2025. It's
  phishing only (no legit or spam class), and hand-classified, so it "could contain errors".
  Earlier mailboxes were anonymised; later ones weren't. One file is named `private-phishing4.mbox`; leave it alone. (Primary:
  [listing][nazario], [LICENSE.txt][nazario-license], [README.txt][nazario-readme].)
- **"Phishing validation emails dataset"** (Miltchev, Technical University of Sofia; Rangelov,
  University of Twente; Genchev, Saxion), Zenodo, published 2024-08-29, DOI
  `10.5281/zenodo.13474746`: **CC BY 4.0, which matches the earlier claim.** It holds 2,000 emails
  labelled `Safe Email` or `Phishing Email`, "a mix of real-world email samples and artificially
  generated emails", in one CSV (203,107 bytes). The record doesn't say where the real-world emails
  came from. (Primary: [Zenodo record][twente].)

### Rejected

- **TREC 2007 Public Spam Corpus:** "Permission is NOT granted to publish this corpus or any material
  portion (including file names and judgements)." The usage agreement also prohibits disclosing
  personal information. **Confirmed.** (Primary: the corpus [about page][trec-about] and
  [agreement][trec-agreement], read through the Wayback Machine because the live URL now redirects
  to a 404.)
- **SpamAssassin public corpus:** no license. "Copyright for the text in the messages remains with
  the original senders." **Confirmed.** (Primary: [readme][spamassassin].)
- **Enron-Spam:** the readme has no license, and the raw ham comes from six Enron employees'
  mailboxes, named by person. **Confirmed.** (Primary: [readme][enron-spam],
  [directory][enron-spam-index].) **Ling-Spam** wasn't rechecked: the AUEB data index returns 403
  today. The earlier finding (no license) stands. (Secondary.)
- **zefang-liu/phishing-email-dataset (Hugging Face):** the card says LGPL-3.0 and calls itself "a
  direct copy" of a Kaggle set. That's a software license applied to emails the uploader didn't
  write. (Primary: [card][hf-zefang].)
- **ealvaradob/phishing-dataset (Hugging Face):** the card says Apache-2.0 but compiles four other
  people's datasets, including the Kaggle mail set and Mishra & Soni itself. Use the originals.
  (Primary: [card][hf-ealvaradob].)
- **Zenodo 8339691, "Phishing Email Curated Datasets"** (2023-09-13; it asks you to cite Champa,
  Rabbi & Zibran): the record says CC BY 4.0, but its files are `TREC_05/06/07`, `Enron`,
  `SpamAssasin`, `CEAS_08`, `Ling`, `Nazario` and `Nigerian_Fraud`. That includes TREC, which can't be republished.
  **Confirmed.** (Primary: [Zenodo record][zenodo-8339691].)
- **PhishFuzzer:** we couldn't find the repository today, so the earlier "no LICENSE" finding wasn't
  rechecked. (Secondary: web search.)

## Clue Clash data

### Chosen source: Open English Wordnet 2025, core edition

- **Release: confirmed.** The README says "2025 Edition (Released 31st December 2025)". The GitHub
  release `2025-edition` was published 2025-12-31T07:29:46Z. (Primary: [README][oewn-readme],
  [release][oewn-release].)
- **Editions:** there are three. (Primary: [README][oewn-readme], [release notes][oewn-release].)
  - **Open English Wordnet**, the core, holds common nouns, verbs, adjectives and adverbs.
  - **Open English Wordnet Plus** "also contains a selection of proper nouns from Open English
    Namenet that have been manually validated", based on Princeton WordNet 3.1's proper nouns plus
    the team's additions.
  - **Open English Namenet** "contains a very large number of entries derived from Wikidata".

  So the earlier claim ("Plus adds Wikidata-derived proper nouns") holds with one nuance: Plus adds
  a curated subset of the Wikidata-derived Namenet. Use the core.
- **Size: confirmed.** The README gives the core as 135,969 words, 107,519 synsets and 355,064
  relations; 2025 Plus has 161,875, 120,564 and 419,226. (Primary: [README][oewn-readme].) Our
  inspection matches the core exactly. The JSON has 107,519 synsets. The XML has 107,519 `Synset`
  and 135,969 `LexicalEntry` elements, and its relations total 355,064. (Primary:
  [our inspection][oewn-files].)
- **Proper nouns in the core:** no synset has an `instance_hypernym`, so it has no proper-noun
  instances. But 16,805 of its 128,009 distinct lemma strings start with a capital letter: Latin
  binomials, languages, nationalities, organisations and eponyms. **Design consequence:** filter out
  capitalised lemmas when building boards. (Primary: [our inspection][oewn-files].)

#### Release assets

The same files are mirrored at `https://en-word.net/static/<name>`. (Primary:
[release][oewn-release], [README][oewn-readme].)

| Asset (core edition)                         | Bytes      | Format                      |
| -------------------------------------------- | ---------- | --------------------------- |
| `english-wordnet-2025-json.zip`              | 9,986,555  | JSON (73 files, 72.4 MB)    |
| `english-wordnet-2025.xml.gz`                | 11,363,503 | WN-LMF 1.3 XML (89.2 MB)    |
| `english-wordnet-2025.ttl.gz`                | 17,760,615 | RDF (Turtle)                |
| `english-wordnet-2025.zip`                   | 9,618,697  | WNDB (legacy)               |
| `english-wordnet-2025-index.sense-fixed.zip` | 9,616,299  | WNDB with fixed sense index |

The Plus assets have the same names with `-plus`. Don't use them.

**Recommended: the JSON asset,** `https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip`
(sha256 `7d749f6e…a4b51`). It's plain `JSON.parse` in Node with no XML parser. (Primary:
[our inspection][oewn-files].)

- **Layout:** `noun.*.json`, `verb.*.json`, `adj.*.json` and `adv.all.json` are keyed by synset id
  (e.g. `01316379-n`). Each synset has `definition` (an array), `members`, `partOfSpeech`, `ili`, and
  optional `example`, `hypernym`, `similar` and other relation keys. `entries-*.json` map lemma →
  part of speech → `sense` (`id`, `synset`, plus sense relations such as `antonym`).
- **Hyponyms aren't stored.** Invert `hypernym` to get them.
- **The zip has no license file,** so `data/NOTICE.md` has to carry the license. The XML states
  `license="https://creativecommons.org/licenses/by/4.0"` on its `Lexicon` element.

#### Relations for close-meaning boards

All three are present. (Primary: [our inspection][oewn-files].)

- **Hypernym:** 88,075 synset → hypernym links in the JSON. The XML has 88,075 `hypernym` and 88,075
  `hyponym` relations.
- **Co-hyponyms (siblings under a shared hypernym):** derived from `hypernym`. 6,277 synsets have 4
  or more direct hyponyms.
- **"Similar to" (adjectives):** 23,176 `similar` links on 13,226 adjective synsets. The XML has
  23,176.
- **Also available:** sense-level `antonym` (7,774 in the JSON), `also`, `attribute`, the meronyms
  and `domain_topic`.
- **Definitions and examples:** 107,524 definitions (a few synsets have two) and 49,596 examples.
  47,298 of the examples (95%) contain one of the synset's own lemmas, so don't show examples. The
  game's "never contains the answer" rule has to be checked on definitions too.

### License

- **CC BY 4.0, derived from Princeton WordNet. Matches the earlier claim.** The README says "Open
  English Wordnet is released under CC-BY 4.0". (Primary: [README][oewn-readme].) `LICENSE.md` says
  the resource "is derived from Princeton WordNet under the WordNet License and further developed
  under the Creative Commons Attribution 4.0 International License", and that you may share and
  adapt it "providing attribution is given to both Princeton WordNet and the Open English Wordnet
  team". Its copyright line is "Copyright (c) 2019-present, The Open English WordNet Team". It
  points to `/WNDB_License.txt` for the Princeton terms. (Primary: [LICENSE.md][oewn-license], last
  changed 2025-12-30.) The site says the same. (Primary: [en-word.net][en-word].)
- **Glosses can be redistributed:** they're part of the CC BY 4.0 resource, so we can share them
  with attribution and a note of our changes. (Primary: [LICENSE.md][oewn-license].)
- **Spelling of the name:** the project writes "Wordnet" with a lower-case n because "WordNet" with
  a capital N is a trademark of Princeton University. (Primary: [rename commit][oewn-rename],
  2024-10-11.) Use "Open English Wordnet" in our notice and UI. The WordNet License also bars using
  Princeton's name in advertising or publicity.
- **The WordNet License file to copy:** [`WNDB_License.txt`][wndb-license]. Pinned to its last
  commit (2024-01-16):
  `https://github.com/globalwordnet/english-wordnet/blob/db221737a7cff86dd252d05b5b1e0c959b254652/WNDB_License.txt`.
  Raw: `https://raw.githubusercontent.com/globalwordnet/english-wordnet/main/WNDB_License.txt`.
  (Primary.) Two quirks:
  - Every line starts with a line number ("  1 ", "  2 " and so on). WNDB data files carry the
    license as numbered header lines, and the 2025 WNDB `data.noun` begins with exactly this text.
    Strip the numbers when copying. (Primary: [our inspection][oewn-files].)
  - It still says "Open English Wordnet 2023 Copyright 2023". It wasn't updated for 2025, and the
    2025 WNDB files ship the same text. Copy it as is.

  The text, line numbers and trailing spaces stripped:

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

- **Princeton's own license page, for reference:** it shows the WordNet 3.0 license. Open English
  Wordnet's file above swaps Princeton's opening paragraph for its own and has the 3.1 copyright
  line. The permission grant, the disclaimer and the name and title clauses are word for word the
  same. Princeton calls WordNet "unencumbered" and says it "may be used in commercial applications"
  under this license. (Primary: [Princeton license page][princeton], read through a Wayback snapshot
  from 2025-12-26 because the live page sits behind a JavaScript check.) The text, line-wrapped:

  ```text
  WordNet Release 3.0

  This software and database is being provided to you, the LICENSEE, by
  Princeton University under the following license. By obtaining, using
  and/or copying this software and database, you agree that you have
  read, understood, and will comply with these terms and conditions.:

  Permission to use, copy, modify and distribute this software and
  database and its documentation for any purpose and without fee or
  royalty is hereby granted, provided that you agree to comply with
  the following copyright notice and statements, including the disclaimer,
  and that the same appear on ALL copies of the software, database and
  documentation, including modifications that you make for internal
  use or for distribution.

  WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.

  THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON
  UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
  IMPLIED. BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON
  UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANT-
  ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
  OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT
  INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR
  OTHER RIGHTS.

  The name of Princeton University or Princeton may not be used in
  advertising or publicity pertaining to distribution of the software
  and/or database. Title to copyright in this software, database and
  any associated documentation shall at all times remain with
  Princeton University and LICENSEE agrees to preserve same.
  ```

- **Citation:** John P. McCrae, Alexandre Rademaker, Francis Bond, Ewa Rudnicka and Christiane
  Fellbaum. 2019. "English WordNet 2019 – An Open-Source WordNet for English". In _Proceedings of
  the 10th Global Wordnet Conference (GWC 2019)_, pages 245–252, Wrocław, Poland. Global Wordnet
  Association. https://aclanthology.org/2019.gwc-1.31. (Primary: [citation.bib][oewn-bib],
  [README][oewn-readme].)

### Rejected

- **Wiktionary:** CC BY-SA 4.0 dual-licensed with the GFDL, both share-alike, and messier to parse.
  The policy page carries an "outdated" banner, but every entry's footer says the same thing.
  **Confirmed.** (Primary: [Wiktionary:Copyrights][wiktionary].)
- **Cryptonite:** the Hugging Face loader sets `_LICENSE = "cc-by-nc-4.0"`. The GitHub repository has
  no LICENSE file. **Non-commercial, confirmed.** (Primary: [HF loader][cryptonite-hf],
  [GitHub][cryptonite-gh].) The clues come from The Times and The Telegraph. (Secondary: search
  summary of the [EMNLP 2021 paper][cryptonite-paper].)
- **George Ho's cryptic clues: contradiction.** The license isn't "non-commercial sharing". The
  README puts the database under the Open Database License (ODbL) v1.0 and the individual contents
  under the Database Contents License. The site metadata also says ODbL v1.0. (Primary:
  [README][cryptics-gh], [site metadata][cryptics-meta].) It's still rejected:
  - ODbL is share-alike for derived databases.
  - The clues were scraped from blogs and archives, including a New York Times `.puz` archive, The
    New Yorker and Times for the Times, and the compiler doesn't hold the clues' copyright.
    (Primary: [site][cryptics-site].)
  - Cryptic clues aren't plain definitions.
- **RiddleSense:** "Dataset provided for research purposes only". The card also says "You do not
  have the right to redistribute them" and bars commercial use. **Confirmed.** (Primary:
  [HF card][riddlesense].)
- **New York Times:** Terms of Service §4.1 bars scraping and automated collection, and bars using
  content to develop software, models or AI systems, without NYT's written consent. **Confirmed.**
  (Primary: [NYT Terms of Service][nyt-tos].)

## Required notice (`data/NOTICE.md`)

What `data/NOTICE.md` must contain, linked from the README:

1. **The README line:** "Code MIT; files under data/ keep their own licenses."
2. **The Open English Wordnet credit, corrected:**

   > Contains material from Open English Wordnet 2025 (https://en-word.net), © 2019–present The Open
   > English Wordnet Team, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
   > Open English Wordnet is derived from Princeton WordNet 3.1, © 2011 Princeton University, used
   > under the WordNet License below. Modified: subset selected; decoys derived from relations.

   Three changes from the draft:
   - "Wordnet" with a lower-case n, as the project writes it. (Primary: [rename commit][oewn-rename].)
   - Princeton WordNet is credited, because `LICENSE.md` requires attribution to both. (Primary:
     [LICENSE.md][oewn-license].)
   - The CC BY 4.0 URL is added, because the license requires a link to it.
3. **The full WordNet License:** the `WNDB_License.txt` text above, with the line numbers stripped.
   It carries the WordNet 3.1 copyright line, the disclaimer, and the Princeton-name and title
   clauses that must appear on all copies.
4. **The Open English Wordnet citation:** McCrae et al., GWC 2019, as above.
5. **The SMS credit:**

   > Contains a sample of the SMS Phishing Dataset for Machine Learning and Pattern Recognition by
   > Sandhya Mishra and Devpriya Soni (Mendeley Data, V1, 2022, https://doi.org/10.17632/f45bkkt8pr.1),
   > CC BY 4.0. That dataset includes the SMS Spam Collection by Tiago A. Almeida and José M. Gómez
   > Hidalgo (UCI Machine Learning Repository, 2011, https://doi.org/10.24432/C5CC84), CC BY 4.0.
   > Changes:
   >
   > - A stratified sample of about 600 messages.
   > - Labels lower-cased; `ham` renamed `legit`.
   > - Personal names, email addresses and phone numbers masked as `<name>`, `<email>` and
   >   `<phone>`.
   > - URLs defanged.
   > - Duplicates, encoding garbage and items whose label the reviewer disagreed with were dropped.

   The build drops every row with an NUS `&lt;#&gt;`-style placeholder; `data/NOTICE.md` lists
   that and the other changes as built.
6. **The third-party note:** the message texts were written by third parties, so the CC BY grants
   cover only what the dataset authors hold. This mirrors Mendeley's own note. (Primary:
   [record API][mendeley-api].)
7. **License URLs:** both datasets' DOIs and the CC BY 4.0 URL. Every dataset is also listed in
   `docs/assets.md`.

## Label check (2026-10-07)

Every item that could end up in the committed sample was read: the 600 first drawn plus the 350-item
reserve (450 legit, 250 spam, 250 smishing). Four AI reviewers (Claude subagents, neither of the two
competing models), one per quarter of the items, read each message one at a time against a written
guide, the game's three option descriptions. No person read every item. They gave each a verdict:
`ok`, `disagree` (a careful reader would pick another option), `ambiguous` (two options fit about
equally), `garbage`, `personal` (personal data left after masking) or `offensive`. They checked masking against
the unmasked source text, which never left `.scratchpad/`. (Our review.)

- **Final mix:** 300 legit, 150 spam, 150 smishing, every one reviewed `ok` here and in the content
  sweep below. The committed text is byte-identical to the text that was reviewed. Build hash in
  `data/inbox/messages.json`.
- **Dropped:** 198 ids, listed with their verdict in `data/inbox/exclude.json`: the 153 in the table
  below and 45 from the content sweep. They were dropped, never relabeled, and replaced from the
  reviewed reserve of the same class.

  | Verdict     | legit | spam | smishing | all |
  | ----------- | ----: | ---: | -------: | --: |
  | `ok`        |   428 |  192 |      177 | 797 |
  | `disagree`  |     0 |   10 |       41 |  51 |
  | `ambiguous` |     0 |   18 |       25 |  43 |
  | `personal`  |    20 |   13 |        4 |  37 |
  | `offensive` |     2 |   12 |        1 |  15 |
  | `garbage`   |     0 |    5 |        2 |   7 |

- **Disagreement rate:** **5.4% overall** (51 of 950). It's 16.4% for smishing (41 of 250), 4.0% for
  spam (10 of 250) and 0% for legit. Another 4.5% (43) were ambiguous. Almost every disagreement is a
  dataset `smishing` text that reads as an open sales offer (`smishing → spam`, 41). The others are
  `spam → legit` (8) and `spam → smishing` (2). This confirms the spam/smishing boundary is the
  dataset's noisiest part.
- **Personal data:** masking missed names in 37 items, mostly first names, including spam personas'
  names. All 37 were dropped. No committed item was flagged for personal data.
- **What it means for results:** the game's right answers are the dataset's labels, kept only where a
  reviewer agreed with them. The README quotes the disagreement rate.

### Content sweep (2026-10-08)

The texts appear in a public video and repo for a professional audience, so all 797 items reviewed
`ok` above were read again for offensive, explicit or crude content, ignoring labels. AI reviewers
(Claude, as above) flagged slurs and insults (`offensive`), sexual content beyond a mild chat-line
advert (`explicit`) and heavy profanity or graphic bodily content (`crude`), and flagged whenever
unsure. (Our review.)

| Verdict     | legit | spam | smishing | all |
| ----------- | ----: | ---: | -------: | --: |
| `ok`        |   405 |  170 |      177 | 752 |
| `offensive` |     9 |    0 |        0 |   9 |
| `explicit`  |     6 |   22 |        0 |  28 |
| `crude`     |     8 |    0 |        0 |   8 |

All 45 flagged items (23 legit, 22 spam) were dropped and replaced from the reviewed spares of the
same class. They are in `data/inbox/exclude.json` as `content-<verdict>`.

## Clue Clash board review (2026-10-07)

Every committed Clue Clash board was read before the set was frozen, by AI reviewers (Claude
subagents, as in the label check) reading one board at a time against a written guide. No person
read every board.

- **Method:** four AI reviewers split the boards and read each definition against its whole board.
  A board is fair only if each definition points at exactly one board word. A board where a careful,
  well-read reader could defend a second word for any definition was marked ambiguous; broken,
  offensive or nonsense content was marked bad. Rare words were fine.
- **Round 1:** all 192 built boards. 12 ok, 174 ambiguous, 6 bad. Enough words to break every
  flagged pair went into `data/clues/exclude.json` for the board's anchor, and the build refilled
  the gaps from the same neighbourhood, skipping candidates that share a sense or two gloss words
  with a board word.
- **Gloss-fragment filter:** the same rebuild takes off any word whose gloss can't stand alone as a
  clue. Open English Wordnet sometimes writes a gloss as a usage note, or as only what sets a word
  apart from its parent category, so it reads as a fragment without that parent. A board shows no
  parent, so such a gloss fits several words or none.
- **Round 2:** the 125 boards the rebuild changed were re-read, paying most attention to the new
  words. 62 ok, 63 ambiguous, 0 bad. The 63 ambiguous boards were dropped entirely, not refilled
  again.
- **After round 2:** 69 boards: 67 nouns, 1 verb, 1 adjective. That is the 62 boards passed in
  round 2 plus 7 that round 1 passed and nothing changed.
- **Give-away rebuild (2026-10-08):** a code review found glosses that hold a form of their own
  word the build's check missed: derived forms ("architectural" for architecture, "shaken" for
  shaker), Latin genus and family names ("Geraniaceae", "Albizia", "Thymus") and compound parts
  the stemmer cut short ("fires" for fireman, "berries" for raspberry). The build now also rejects
  a gloss with a word that shares the lemma's first five letters (four for lemmas of five letters
  or fewer, also with doubled letters collapsed), a capitalised genus or family name or
  "-aceous" adjective with the lemma's Latin root, and those compound parts. It runs in the repair
  step, so the draw is unchanged. 37 words on 26 of the 69 boards were taken off and refilled from
  the same neighbourhood. A code review also found one board where a definition fitted two of its
  words, and two words were excluded there. With one more board whose refill went to an earlier
  board of its anchor, 22 boards changed (34 new words) and 6 couldn't refill to 16 words and were
  dropped. One drop-list entry lost its listed word, so it now names its board by draw id too.
- **Round 3:** the 22 changed boards got the same re-read as round 2. 5 ok, 1 ambiguous, 16 bad.
  Most of the bad ones still had definitions that gave their word away in ways the check missed:
  short words ("tinplate" for tin, "public" for pub), compound parts ("bay rum" for bayberry,
  "basswood" for cottonwood, "fallen" for windfall), shared roots ("societies" for sociology,
  "geography" for cosmography, "trifoliate" for trefoil) and irregular forms ("taught" for
  teaching).
- **Give-away rule v3 (2026-10-08):** the build now splits each word into morphemes and rejects a
  gloss with any word that gives one away. The morphemes are the word itself; its compound parts,
  the start and end pieces of 3+ letters that are Open English Wordnet single-word lemmas where
  the other piece is a lemma too, or any piece of 5+ letters that is a lemma, whatever the other
  piece is (bay + berry, bar + tender, re + mover, huckle + berry), and a start piece that is a
  lemma with its last letter doubled before a lemma of 3+ letters (bel(l) + fry); its roots with
  common suffixes stripped, one and then one more that
  isn't an inflection (-ing, -er, -ist, -ics, -onics, -ology, -logy, -ography, -graphy, -ism,
  -ion, -ity, -ness, -ment, -al, -ous, -ic, -th, -y, -s, -es, -ed: "socio" for sociology, "tect"
  for tectonics, "slo" for sloth), with a doubled last letter undone ("lot" for lottery); and,
  from a short hand list, the words a clipping or blend was cut from (ginseng for sang,
  electronics for avionics). Each of these brings its roots and stem too. A gloss word gives a
  morpheme away if it contains it, it is inside it (4+ letters), they share their first four
  letters or a run of five, they share their first five letters when vowels count as one letter
  and doubled letters as one ("trifoliate" for trefoil, "Japan" for japonica, "Capparis" for
  caper), or one of the gloss word's own compound parts shares the morpheme's first four letters
  ("manuscripts", manu + script, for scribe). A 3-letter morpheme counts only as a whole word,
  the word plus one letter, a form of it or the start of a compound ("lots", "slow", "barroom",
  not "barely" or "embark"); a 3-letter compound part counts at the end of any gloss word too
  ("human" for mankind); and a 3-letter word counts at the start of any gloss word ("literature"
  for lit). Irregular forms of every morpheme count too, from Wordnet's own lists and a hand list
  ("taught" for teaching). Stopwords never count, and derived forms from Wordnet's links only
  count by containment or a shared start, since they end in suffixes unrelated words share. The
  earlier checks, Latin genus and family names among them, still run. Being strict only costs a
  candidate word, and it runs in the repair step, so the draw is unchanged. An audit of the
  rebuilt set (every gloss word that shares a run of three or more letters with its word, read by
  an AI reviewer) found five leaks the first version of the rule missed: "lots" for lottery, "slow" for
  sloth, "manuscripts" for scribe, "bells" for belfry and "human" for mankind; the rule above
  catches them. It found 58 words on 34 of the 63 boards. 52 words on 31 boards were swapped from
  the same neighbourhood (the flagged words, and four more that moved with the refills), and 4
  boards couldn't refill to 16 words and were dropped. One board that couldn't refill after round
  1, so never reached round 2, now refills and is back. Two more drop-list entries lost their
  listed word, so three now name their board by draw id too.
- **Round 4 (2026-10-12):** all 60 boards were re-read in full, because round 3 found leaks on
  boards it didn't re-read too. Four AI reviewers read them against the same standard, now also
  checking each definition for a give-away of its own word. 32 ok, 18 ambiguous, 10 bad. All 28
  flagged boards were dropped, not refilled, and that is final. The ambiguous ones had definitions
  generic enough to fit a sibling (eagle's definition fits vulture, gull's fits gannet). The bad
  ones mostly had give-aways the text check can't see because the spelling hides them ("air" for
  aeronautics, "flight" for fly, "drop" for drip, "line" for aligned). "Fall" for fell got past it
  too: the hand list of irregular forms maps fall to fell, but the check doesn't look it up the
  other way. One board was dropped for an offensive term for Roma people in a gloss.
- **Code review of the build (2026-10-12):** after round 4, a code review of the build tightened
  the rule in three ways. A derived form now counts when a gloss word's stem matches it, even if
  the word itself only matched loosely ("gametes" for agamic, through agamete). The vowel test
  also reads a run of vowels as one letter ("Phasianidae" for pheasant). And the blocklist now
  catches inflected forms of a blocked word in a gloss (-s, -es, -ies, -ed, -ing and irregular
  forms), unless the word can also come from a lemma that isn't blocked ("spices" from spice). A
  reviewed board the tighter rule changed would have been dropped, not refilled, but it changed
  none of them. It only took words off two boards that were already dropped. Three more boards
  were dropped directly (added to the drop list, not by the rule). One was the algarroba board (then b015), whose gloss calls it "the
  biblical carob", a give-away by spelling that the rule doesn't catch. The other two had a gloss
  that didn't suit a general audience: one tied a headdress to a single religion, and one was
  about underwear.
- **Current set:** 29 boards, all nouns.
- **Why adjectives and verbs fell out:** their boards are built from near-synonyms (an adjective's
  satellites, a verb's troponyms), and Wordnet glosses those with near-synonym wording. A refill
  from the same neighbourhood brings in more of the same, so most of these boards stayed
  ambiguous, and round 4 dropped the last one of each. Noun boards are kinds of one thing, and
  their glosses name what sets each apart.
- **Record:** `data/clues/exclude.json` holds the words excluded per anchor. `data/clues/drop.json`
  holds the dropped boards, each named by its anchor and one of its words, because a wide anchor
  can have several boards (or by its draw id, when a rebuild took that word off). The build reads
  both, and `test/games/clues/data.test.ts` pins the current set's sha256 and counts.

## Sources

All accessed 2026-10-07.

**Inbox Invaders**

- Mishra & Soni dataset record, Mendeley Data. Primary. https://data.mendeley.com/datasets/f45bkkt8pr/1
- The same record as JSON (licence, method, related links, file list). Primary.
  https://data.mendeley.com/public-api/datasets/f45bkkt8pr
- Our inspection of `Dataset_5971.zip`, downloaded from the record. Primary.
  https://data.mendeley.com/public-files/datasets/f45bkkt8pr/files/edb361de-918d-469f-9106-e84823830665/file_downloaded
- The authors' related papers, linked from the record. Not read (behind a login).
  https://doi.org/10.1016/j.future.2020.03.021, https://doi.org/10.1007/s00521-021-06305-y,
  https://doi.org/10.1007/s42979-022-01078-0
- Sonowal & Kuppusamy, linked from the record. Not read. https://doi.org/10.1093/comjnl/bxy039
- UCI SMS Spam Collection page. Primary. https://archive.ics.uci.edu/dataset/228/sms+spam+collection
- UCI API record for the same dataset. Primary. https://archive.ics.uci.edu/api/dataset?id=228
- Chen & Kan, "Creating a Live, Public Short Message Service Corpus: The NUS SMS Corpus", §3.4.
  Primary. https://arxiv.org/abs/1112.2468
- Nazario phishing corpus listing, LICENSE.txt and README.txt. Primary. https://monkey.org/~jose/phishing/
- "Phishing validation emails dataset", Zenodo. Primary. https://zenodo.org/records/13474746
- TREC 2007 corpus about page and usage agreement (Wayback). Primary.
  https://web.archive.org/web/2024/https://plg.uwaterloo.ca/~gvcormac/treccorpus07/about.html
- SpamAssassin public corpus readme. Primary. https://spamassassin.apache.org/old/publiccorpus/readme.html
- Enron-Spam readme and directory. Primary. https://www2.aueb.gr/users/ion/data/enron-spam/
- Hugging Face dataset cards. Primary. https://huggingface.co/datasets/zefang-liu/phishing-email-dataset,
  https://huggingface.co/datasets/ealvaradob/phishing-dataset
- "Phishing Email Curated Datasets", Zenodo. Primary. https://zenodo.org/records/8339691
- Searches for the Mishra & Soni paper and for PhishFuzzer. Secondary.

**Clue Clash**

- Open English Wordnet README. Primary. https://github.com/globalwordnet/english-wordnet/blob/main/README.md
- The 2025 release, its notes and assets. Primary.
  https://github.com/globalwordnet/english-wordnet/releases/tag/2025-edition
- `LICENSE.md`. Primary. https://github.com/globalwordnet/english-wordnet/blob/main/LICENSE.md
- `WNDB_License.txt`, pinned. Primary.
  https://github.com/globalwordnet/english-wordnet/blob/db221737a7cff86dd252d05b5b1e0c959b254652/WNDB_License.txt
- `citation.bib`. Primary. https://github.com/globalwordnet/english-wordnet/blob/main/citation.bib
- The rename commit (lower-case "Wordnet"). Primary.
  https://github.com/globalwordnet/english-wordnet/commit/fde01a6cfb
- The Open English Wordnet site. Primary. https://en-word.net/
- Our inspection of the 2025 core JSON, LMF XML and WNDB assets. Primary. (Release link above.)
- Princeton, "License and Commercial Use of WordNet" (Wayback, 2025-12-26). Primary.
  https://web.archive.org/web/20251226184257/https://wordnet.princeton.edu/license-and-commercial-use
- Wiktionary:Copyrights. Primary. https://en.wiktionary.org/wiki/Wiktionary:Copyrights
- Cryptonite: Hugging Face loader, repository and paper. Primary, except the clue-source note,
  which is Secondary. https://huggingface.co/datasets/cryptonite/blob/main/cryptonite.py,
  https://github.com/aviaefrat/cryptonite, https://aclanthology.org/2021.emnlp-main.344/
- George Ho's cryptic clues: README, site metadata and site. Primary. https://github.com/eigenfoo/cryptics,
  https://cryptics.georgeho.org/-/metadata.json, https://cryptics.georgeho.org/
- RiddleSense Hugging Face card. Primary. https://huggingface.co/datasets/INK-USC/riddle_sense
- New York Times Terms of Service, §4.1. Primary.
  https://help.nytimes.com/hc/en-us/articles/115014893428-Terms-of-Service

[mendeley]: https://data.mendeley.com/datasets/f45bkkt8pr/1
[mendeley-api]: https://data.mendeley.com/public-api/datasets/f45bkkt8pr
[sms-file]: https://data.mendeley.com/public-files/datasets/f45bkkt8pr/files/edb361de-918d-469f-9106-e84823830665/file_downloaded
[mishra-fgcs]: https://doi.org/10.1016/j.future.2020.03.021
[mishra-nca]: https://doi.org/10.1007/s00521-021-06305-y
[mishra-sncs]: https://doi.org/10.1007/s42979-022-01078-0
[sonowal]: https://doi.org/10.1093/comjnl/bxy039
[uci]: https://archive.ics.uci.edu/dataset/228/sms+spam+collection
[uci-api]: https://archive.ics.uci.edu/api/dataset?id=228
[nus-paper]: https://arxiv.org/abs/1112.2468
[nazario]: https://monkey.org/~jose/phishing/
[nazario-license]: https://monkey.org/~jose/phishing/LICENSE.txt
[nazario-readme]: https://monkey.org/~jose/phishing/README.txt
[twente]: https://zenodo.org/records/13474746
[trec-about]: https://web.archive.org/web/2024/https://plg.uwaterloo.ca/~gvcormac/treccorpus07/about.html
[trec-agreement]: https://web.archive.org/web/2024/https://plg.uwaterloo.ca/~gvcormac/treccorpus07/
[spamassassin]: https://spamassassin.apache.org/old/publiccorpus/readme.html
[enron-spam]: https://www2.aueb.gr/users/ion/data/enron-spam/readme.txt
[enron-spam-index]: https://www2.aueb.gr/users/ion/data/enron-spam/
[hf-zefang]: https://huggingface.co/datasets/zefang-liu/phishing-email-dataset
[hf-ealvaradob]: https://huggingface.co/datasets/ealvaradob/phishing-dataset
[zenodo-8339691]: https://zenodo.org/records/8339691
[oewn-readme]: https://github.com/globalwordnet/english-wordnet/blob/main/README.md
[oewn-release]: https://github.com/globalwordnet/english-wordnet/releases/tag/2025-edition
[oewn-license]: https://github.com/globalwordnet/english-wordnet/blob/main/LICENSE.md
[wndb-license]: https://github.com/globalwordnet/english-wordnet/blob/main/WNDB_License.txt
[oewn-bib]: https://github.com/globalwordnet/english-wordnet/blob/main/citation.bib
[oewn-rename]: https://github.com/globalwordnet/english-wordnet/commit/fde01a6cfb
[en-word]: https://en-word.net/
[oewn-files]: https://github.com/globalwordnet/english-wordnet/releases/tag/2025-edition
[princeton]: https://web.archive.org/web/20251226184257/https://wordnet.princeton.edu/license-and-commercial-use
[wiktionary]: https://en.wiktionary.org/wiki/Wiktionary:Copyrights
[cryptonite-hf]: https://huggingface.co/datasets/cryptonite/blob/main/cryptonite.py
[cryptonite-gh]: https://github.com/aviaefrat/cryptonite
[cryptonite-paper]: https://aclanthology.org/2021.emnlp-main.344/
[cryptics-gh]: https://github.com/eigenfoo/cryptics
[cryptics-meta]: https://cryptics.georgeho.org/-/metadata.json
[cryptics-site]: https://cryptics.georgeho.org/
[riddlesense]: https://huggingface.co/datasets/INK-USC/riddle_sense
[nyt-tos]: https://help.nytimes.com/hc/en-us/articles/115014893428-Terms-of-Service
