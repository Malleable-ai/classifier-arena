import { canonicalJson, fnv1a64, utf8Bytes } from '../util/hash.js';

/**
 * The hash of a game's frozen prompt config, recorded in every match log: FNV-1a 64 of the
 * canonical (sorted-key) JSON of `config`, UTF-8 encoded. 16 lowercase hex chars.
 */
export function promptConfigHash(config: unknown): string {
  return fnv1a64(utf8Bytes(canonicalJson(config)));
}
