import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  ProviderConfigError,
  loadProviders,
  mergeLocalProviders,
  resolveProvider,
  type ProviderEntry,
} from '../../../src/core/classifier/providers.js';
import { createProviderDecider } from '../../../src/core/classifier/provider-decider.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { SAMPLE_VIEW, fakeFetch, readFixture } from '../../games/fighter/sample-view.js';

const fake: ProviderEntry = {
  id: 'fake_edge',
  label: 'Fake edge',
  format: 'systemone',
  url: 'https://edge.test/accounts/{FAKE_ACCOUNT}/run/{FAKE_REGION}/model',
  model: 'fake-1',
  auth: { header: 'authorization', scheme: 'Bearer', keyEnv: 'FAKE_KEY' },
  extraEnv: ['FAKE_ACCOUNT', 'FAKE_REGION'],
  responseEnvelope: 'result',
  hosting: 'edge',
  capabilities: { probabilities: true, maxOptions: 64 },
  price: { inputPerMTokUsd: 1, outputPerMTokUsd: 0, asOf: '2026-10-07', source: 'test' },
};

const FULL_ENV = { FAKE_KEY: 'k-123', FAKE_ACCOUNT: 'acc 1', FAKE_REGION: 'eu' };

describe('PROVIDERS', () => {
  it('has only jev and openai built in, with dated prices', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['jev', 'openai']);
    const jev = PROVIDERS[0];
    const openai = PROVIDERS[1];
    expect(jev).toMatchObject({
      format: 'systemone',
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      auth: { keyEnv: 'TYPESAFE_API_KEY' },
      hosting: 'vendor-api',
      price: { inputPerMTokUsd: 0.042 },
    });
    expect(openai).toMatchObject({
      format: 'openai-decisions',
      url: 'https://api.openai.com/v1/decisions',
      model: 'gpt-6-luna',
      auth: { keyEnv: 'OPENAI_API_KEY' },
      hosting: 'vendor-api',
      price: { inputPerMTokUsd: 0.1 },
    });
    for (const p of PROVIDERS) expect(p.price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('resolveProvider', () => {
  it('names every missing env var', () => {
    expect(() => resolveProvider(fake, { FAKE_ACCOUNT: 'a' })).toThrow(/FAKE_KEY.*FAKE_REGION/);
    expect(() => resolveProvider(fake, { ...FULL_ENV, FAKE_KEY: '' })).toThrow(ProviderConfigError);
  });

  it('fills URL placeholders (encoded) and builds the auth header', () => {
    const r = resolveProvider(fake, FULL_ENV);
    expect(r.url).toBe('https://edge.test/accounts/acc%201/run/eu/model');
    expect(r.headers).toEqual({ authorization: 'Bearer k-123' });
  });

  it('omits the scheme when it is empty', () => {
    const r = resolveProvider(
      { ...fake, auth: { header: 'x-api-key', scheme: '', keyEnv: 'FAKE_KEY' } },
      FULL_ENV,
    );
    expect(r.headers).toEqual({ 'x-api-key': 'k-123' });
  });

  it('rejects a placeholder that is not in extraEnv', () => {
    expect(() => resolveProvider({ ...fake, extraEnv: ['FAKE_ACCOUNT'] }, FULL_ENV)).toThrow(
      /FAKE_REGION/,
    );
  });

  it('rejects a provider that cannot take a two-option question', () => {
    for (const maxOptions of [0, 1]) {
      const small = { ...fake, capabilities: { probabilities: true, maxOptions } };
      expect(() => resolveProvider(small, FULL_ENV)).toThrow(
        `provider fake_edge: maxOptions ${String(maxOptions)} is under 2`,
      );
    }
  });

  it("no longer compares maxOptions with the fighter's 11 moves (checked per question instead)", () => {
    const two = { ...fake, capabilities: { probabilities: true, maxOptions: 2 } };
    expect(resolveProvider(two, FULL_ENV).entry.capabilities.maxOptions).toBe(2);
  });
});

describe('mergeLocalProviders', () => {
  it('appends valid local entries after the built-ins', () => {
    const merged = mergeLocalProviders(PROVIDERS, [fake]);
    expect(merged.map((p) => p.id)).toEqual(['jev', 'openai', 'fake_edge']);
  });

  it('accepts a { providers: [...] } wrapper', () => {
    expect(mergeLocalProviders(PROVIDERS, { providers: [fake] })).toHaveLength(3);
  });

  it('rejects a local entry reusing a built-in id', () => {
    expect(() => mergeLocalProviders(PROVIDERS, [{ ...fake, id: 'jev' }])).toThrow(/jev/);
  });

  it('rejects duplicate local ids', () => {
    expect(() => mergeLocalProviders(PROVIDERS, [fake, fake])).toThrow(/duplicate/);
  });

  it('rejects an unknown format', () => {
    expect(() => mergeLocalProviders(PROVIDERS, [{ ...fake, format: 'grpc' }])).toThrow(/format/);
  });

  it('rejects ids the match-id format cannot hold, naming the bad id', () => {
    for (const id of ['my.clef', 'Clef', 'clef-flash', 'a/b', 'x y']) {
      expect(() => mergeLocalProviders(PROVIDERS, [{ ...fake, id }])).toThrow(
        `id "${id}" must be lowercase letters, digits and _ only (a-z0-9_)`,
      );
    }
    expect(mergeLocalProviders(PROVIDERS, [{ ...fake, id: 'clef_flash2' }])).toHaveLength(3);
  });

  it('rejects malformed entries with the offending field', () => {
    expect(() => mergeLocalProviders(PROVIDERS, [{ ...fake, url: 7 }])).toThrow(/url/);
    expect(() => mergeLocalProviders(PROVIDERS, [{ ...fake, hosting: 'moon' }])).toThrow(/hosting/);
    expect(() =>
      mergeLocalProviders(PROVIDERS, [{ ...fake, price: { inputPerMTokUsd: -1 } }]),
    ).toThrow(/price/);
    expect(() => mergeLocalProviders(PROVIDERS, 'nope')).toThrow(ProviderConfigError);
  });
});

describe('loadProviders', () => {
  it('returns the built-ins when the default local file is absent', async () => {
    const readFile = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await loadProviders({ readFile })).toEqual(PROVIDERS);
  });

  it('merges a local file', async () => {
    const readFile = (path: string) => {
      expect(path).toBe('custom.json');
      return Promise.resolve(JSON.stringify([fake]));
    };
    const all = await loadProviders({ localFile: 'custom.json', readFile });
    expect(all.map((p) => p.id)).toContain('fake_edge');
  });

  it('fails when an explicitly named local file is missing', async () => {
    const readFile = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(loadProviders({ localFile: 'gone.json', readFile })).rejects.toThrow(/gone.json/);
  });

  it('skips the local file when localFile is null', async () => {
    const readFile = () => Promise.reject(new Error('should not read'));
    expect(await loadProviders({ localFile: null, readFile })).toEqual(PROVIDERS);
  });
});

describe('response envelope', () => {
  it("unwraps body.result when responseEnvelope is 'result'", async () => {
    const inner = readFixture('jev/choice-ok.json');
    const fetchImpl = fakeFetch(200, { result: inner, success: true, errors: [] });
    const decider = createProviderDecider(resolveProvider(fake, FULL_ENV), { fetchImpl });
    const res = await decider.decide(
      SAMPLE_VIEW,
      buildQuestion(MOVE_IDS),
      new AbortController().signal,
    );
    expect(res.status).toBe('ok');
    expect(res.choice).toBe('fireball');
    expect(fetchImpl.calls[0]?.url).toBe('https://edge.test/accounts/acc%201/run/eu/model');
  });

  it('reports an error when the envelope is missing', async () => {
    const fetchImpl = fakeFetch(200, readFixture('jev/choice-ok.json'));
    const decider = createProviderDecider(resolveProvider(fake, FULL_ENV), { fetchImpl });
    const res = await decider.decide(
      SAMPLE_VIEW,
      buildQuestion(MOVE_IDS),
      new AbortController().signal,
    );
    expect(res.status).toBe('error');
  });
});

describe('key hygiene', () => {
  it.each(['src/core/classifier/', 'src/games/'])('nothing in %s reads process.env', (dir) => {
    const root = new URL(`../../../${dir}`, import.meta.url);
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(readFileSync(new URL(f, root), 'utf8'), f).not.toMatch(/process\.env/);
    }
  });
});
