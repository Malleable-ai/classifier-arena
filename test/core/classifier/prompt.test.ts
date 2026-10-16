import { describe, expect, it } from 'vitest';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import { canonicalJson, fnv1a64, utf8Bytes } from '../../../src/core/util/hash.js';

describe('promptConfigHash', () => {
  const config = {
    version: 1,
    questionName: 'next_move',
    primer: 'Pick one — café 🥊',
    options: [
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
    ],
  };

  it('is FNV-1a 64 of the canonical JSON, UTF-8 encoded', () => {
    const h = promptConfigHash(config);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(fnv1a64(utf8Bytes(canonicalJson(config))));
  });

  it('ignores key insertion order', () => {
    const reordered = {
      options: config.options.map((o) => ({ description: o.description, id: o.id })),
      primer: config.primer,
      questionName: config.questionName,
      version: config.version,
    };
    expect(promptConfigHash(reordered)).toBe(promptConfigHash(config));
  });

  it('changes when any value or the option order changes', () => {
    const base = promptConfigHash(config);
    expect(promptConfigHash({ ...config, version: 2 })).not.toBe(base);
    expect(promptConfigHash({ ...config, primer: `${config.primer} ` })).not.toBe(base);
    expect(promptConfigHash({ ...config, options: [...config.options].reverse() })).not.toBe(base);
  });
});
