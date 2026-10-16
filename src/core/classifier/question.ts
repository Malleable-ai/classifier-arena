import type { Question } from './types.js';

/**
 * Question names and option ids: lowercase ASCII letters, digits and `_`, starting with a letter.
 * Jev's systemone format sends the options as object keys, and JS puts integer-like keys ("1",
 * "02"…) first in numeric order whatever the insertion order, which would silently reorder the
 * options and break the same-order fairness rule (RULES.md). A leading letter rules that out.
 */
export const QUESTION_ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Throws unless `q` has a valid name and at least 2 options with unique valid ids and non-blank
 * descriptions. `orderOptions` calls it, so every question the schedulers hand a decider has passed.
 */
export function validateQuestion(q: Question): void {
  const fail = (why: string): never => {
    throw new Error(`invalid question ${JSON.stringify(q.name)}: ${why}`);
  };
  if (!QUESTION_ID_RE.test(q.name)) fail(`name must match ${String(QUESTION_ID_RE)}`);
  if (q.options.length < 2) {
    fail(`needs at least 2 options, got ${String(q.options.length)}`);
  }
  const seen = new Set<string>();
  for (const { id, description } of q.options) {
    if (!QUESTION_ID_RE.test(id)) {
      fail(`option id ${JSON.stringify(id)} must match ${String(QUESTION_ID_RE)}`);
    }
    if (seen.has(id)) fail(`duplicate option id ${JSON.stringify(id)}`);
    seen.add(id);
    if (description.trim() === '') fail(`option ${JSON.stringify(id)} has an empty description`);
  }
}
