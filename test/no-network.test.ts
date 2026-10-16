import { describe, expect, it } from 'vitest';
import { createProviderDecider } from '../src/core/classifier/provider-decider.js';
import { PROVIDERS, resolveProvider } from '../src/core/classifier/providers.js';
import { buildQuestion } from '../src/games/fighter/question.js';
import { MOVE_IDS } from '../src/games/fighter/engine/types.js';
import { NETWORK_DISABLED } from './setup/no-network.js';
import { SAMPLE_VIEW } from './games/fighter/sample-view.js';

describe('test network guard', () => {
  it('makes the global fetch throw', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(NETWORK_DISABLED);
  });

  it('turns a provider decider without an injected fetch into an error, never a live call', async () => {
    const entry = PROVIDERS.find((p) => p.id === 'openai');
    if (!entry) throw new Error('openai missing');
    const decider = createProviderDecider(resolveProvider(entry, { OPENAI_API_KEY: 'sk-fake' }));
    const res = await decider.decide(
      SAMPLE_VIEW,
      buildQuestion(MOVE_IDS),
      new AbortController().signal,
    );
    expect(res.status).toBe('error');
    expect(res.error).toContain(NETWORK_DISABLED);
  });
});
