import { fnv1a64, utf8Bytes } from '../../core/util/hash.js';

/**
 * The originality rule (docs/architecture/clues.md, "Originality"): this game must not resemble the
 * team word-association board game it could be mistaken for, so no board word and no definition may
 * contain that game's name or its terms.
 *
 * The terms are stored as FNV-1a 64 hashes of the lower-case word (as in `blocklist.ts`), so the
 * game's own code never spells them out. test/originality.test.ts holds the plain list, checks
 * these hashes against it, and scans the whole repo for the terms.
 */
export const ORIGINALITY_TERM_HASHES: ReadonlySet<string> = new Set<string>([
  '32cc1b282a9447cf',
  '6351a4cce6b638e4',
  '79f39f2c07a22895',
  '85a4e674b0bf7c9b',
  'b64337f6e6e7502f',
  'd02d8a15c0f8e1e6',
  'd6b0804855613e38',
  'e519e14059f5e474',
]);

/** True if `text` contains one of the terms as a whole word (runs of a–z), in any case. */
export function originalityTermIn(text: string): boolean {
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ORIGINALITY_TERM_HASHES.has(fnv1a64(utf8Bytes(word)))) return true;
  }
  return false;
}
