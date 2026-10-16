import type { ProviderPrice } from './cost.js';
import { FORMAT_IDS, isRecord, type FormatId } from './formats/types.js';
import type { Hosting } from './hosting.js';
import { PLAYER_ID_RE } from './types.js';

/**
 * The provider registry. A provider that speaks an existing format is config only: a built-in
 * entry here (with recorded fixtures that pass test/core/classifier/conformance.test.ts) or an
 * entry in the gitignored providers.local.json. See docs/architecture/providers.md.
 */

export type { Hosting } from './hosting.js';

/** Every provider must take at least a two-option question. */
export const MIN_MAX_OPTIONS = 2;

export interface ProviderEntry {
  id: string;
  label: string;
  format: FormatId;
  /** May contain `{ENV_NAME}` placeholders, each listed in `extraEnv`. */
  url: string;
  model: string;
  /** `scheme` '' sends the bare key (e.g. `x-api-key: <key>`). */
  auth: { header: string; scheme: string; keyEnv: string };
  extraEnv?: string[];
  /** 'result' unwraps `body.result` (Cloudflare's REST convention). */
  responseEnvelope?: 'result' | null;
  hosting: Hosting;
  /**
   * `maxOptions`: the most options one question may have. The provider decider checks it per
   * question and answers `error` without sending anything when a question has more.
   */
  capabilities: { probabilities: boolean; maxOptions: number };
  price: { inputPerMTokUsd: number; outputPerMTokUsd: number; asOf: string; source: string };
}

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: 'jev',
    label: 'Jev (TypeSafe)',
    format: 'systemone',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    auth: { header: 'authorization', scheme: 'Bearer', keyEnv: 'TYPESAFE_API_KEY' },
    hosting: 'vendor-api',
    // Up to 255 options per TypeSafe's API docs.
    capabilities: { probabilities: true, maxOptions: 255 },
    price: {
      inputPerMTokUsd: 0.042,
      outputPerMTokUsd: 0,
      asOf: '2026-10-07',
      source: 'TypeSafe launch post; confirmed by the spike (docs/research/decision-apis.md)',
    },
  },
  {
    id: 'openai',
    label: 'OpenAI Decisions (gpt-6-luna)',
    format: 'openai-decisions',
    url: 'https://api.openai.com/v1/decisions',
    model: 'gpt-6-luna',
    auth: { header: 'authorization', scheme: 'Bearer', keyEnv: 'OPENAI_API_KEY' },
    hosting: 'vendor-api',
    // OpenAI publishes no option limit. The spike confirmed 11 (the fighter) and Clue Clash's live
    // smoke matches (2026-10-08) confirmed 16. Above 16 is untested.
    capabilities: { probabilities: true, maxOptions: 16 },
    price: {
      inputPerMTokUsd: 0.1,
      outputPerMTokUsd: 0,
      asOf: '2026-10-07',
      source: 'OpenAI Decisions API docs; confirmed by the spike (docs/research/decision-apis.md)',
    },
  },
];

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError';
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface ResolvedProvider {
  entry: ProviderEntry;
  /** URL with placeholders filled. */
  url: string;
  /** Auth headers. Never log these. */
  headers: Record<string, string>;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Env var names the entry needs: its key plus any extraEnv. */
export function requiredEnv(entry: ProviderEntry): string[] {
  return [entry.auth.keyEnv, ...(entry.extraEnv ?? [])];
}

export function missingEnv(entry: ProviderEntry, env: Env): string[] {
  return requiredEnv(entry).filter((name) => !env[name]);
}

export function priceOf(entry: ProviderEntry): ProviderPrice {
  return { usdPerMillionInputTokens: entry.price.inputPerMTokUsd, asOf: entry.price.asOf };
}

/** Checks env and capabilities, fills URL placeholders and builds the auth headers. */
export function resolveProvider(entry: ProviderEntry, env: Env): ResolvedProvider {
  if (entry.capabilities.maxOptions < MIN_MAX_OPTIONS) {
    throw new ProviderConfigError(
      `provider ${entry.id}: maxOptions ${String(entry.capabilities.maxOptions)} is under ${String(MIN_MAX_OPTIONS)}`,
    );
  }
  const missing = missingEnv(entry, env);
  if (missing.length > 0) {
    throw new ProviderConfigError(`provider ${entry.id}: missing env ${missing.join(', ')}`);
  }
  const extra = new Set(entry.extraEnv ?? []);
  const url = entry.url.replace(PLACEHOLDER, (_m, name: string) => {
    if (!extra.has(name)) {
      throw new ProviderConfigError(
        `provider ${entry.id}: url placeholder {${name}} is not in extraEnv`,
      );
    }
    return encodeURIComponent(env[name] ?? '');
  });
  const key = env[entry.auth.keyEnv] ?? '';
  return {
    entry,
    url,
    headers: { [entry.auth.header]: entry.auth.scheme ? `${entry.auth.scheme} ${key}` : key },
  };
}

// ---- providers.local.json ----

function fail(where: string, msg: string): never {
  throw new ProviderConfigError(`${where}: ${msg}`);
}

function str(o: Record<string, unknown>, key: string, where: string, allowEmpty = false): string {
  const v = o[key];
  if (typeof v !== 'string' || (!allowEmpty && v === '')) fail(where, `${key} must be a string`);
  return v;
}

function nonNegative(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    fail(where, `${key} must be a number >= 0`);
  return v;
}

/** Hand-written guard for one local entry; the error names the bad field. */
export function parseProviderEntry(x: unknown, where: string): ProviderEntry {
  if (!isRecord(x)) fail(where, 'entry must be an object');
  const id = str(x, 'id', where);
  if (!PLAYER_ID_RE.test(id)) {
    fail(where, `id "${id}" must be lowercase letters, digits and _ only (a-z0-9_)`);
  }
  where = `${where} (${id})`;
  const format = str(x, 'format', where);
  if (!(FORMAT_IDS as readonly string[]).includes(format)) {
    fail(where, `format must be one of ${FORMAT_IDS.join(', ')}, got ${format}`);
  }
  const hosting = str(x, 'hosting', where);
  if (hosting !== 'vendor-api' && hosting !== 'edge' && hosting !== 'local') {
    fail(where, 'hosting must be vendor-api, edge or local');
  }
  if (!isRecord(x.auth)) fail(where, 'auth must be an object');
  if (!isRecord(x.capabilities)) fail(where, 'capabilities must be an object');
  if (typeof x.capabilities.probabilities !== 'boolean')
    fail(where, 'capabilities.probabilities must be a boolean');
  if (!isRecord(x.price)) fail(where, 'price must be an object');
  const extraEnv = x.extraEnv;
  if (
    extraEnv !== undefined &&
    !(Array.isArray(extraEnv) && extraEnv.every((e) => typeof e === 'string'))
  ) {
    fail(where, 'extraEnv must be an array of strings');
  }
  const envelope = x.responseEnvelope;
  if (envelope !== undefined && envelope !== null && envelope !== 'result') {
    fail(where, "responseEnvelope must be 'result' or null");
  }
  let price: ProviderEntry['price'];
  try {
    price = {
      inputPerMTokUsd: nonNegative(x.price, 'inputPerMTokUsd', where),
      outputPerMTokUsd: nonNegative(x.price, 'outputPerMTokUsd', where),
      asOf: str(x.price, 'asOf', where),
      source: str(x.price, 'source', where),
    };
  } catch (err) {
    fail(where, `price: ${(err as Error).message}`);
  }
  const entry: ProviderEntry = {
    id,
    label: str(x, 'label', where),
    format: format as FormatId,
    url: str(x, 'url', where),
    model: str(x, 'model', where),
    auth: {
      header: str(x.auth, 'header', where),
      scheme: str(x.auth, 'scheme', where, true),
      keyEnv: str(x.auth, 'keyEnv', where),
    },
    hosting,
    capabilities: {
      probabilities: x.capabilities.probabilities,
      maxOptions: nonNegative(x.capabilities, 'maxOptions', where),
    },
    price,
  };
  if (extraEnv !== undefined) entry.extraEnv = extraEnv;
  if (envelope !== undefined) entry.responseEnvelope = envelope;
  return entry;
}

/** Built-ins plus validated local entries. Accepts `[...]` or `{ providers: [...] }`. */
export function mergeLocalProviders(
  base: readonly ProviderEntry[],
  local: unknown,
): readonly ProviderEntry[] {
  const list = isRecord(local) ? local.providers : local;
  if (!Array.isArray(list)) {
    throw new ProviderConfigError('providers.local.json must be an array of provider entries');
  }
  const ids = new Set(base.map((p) => p.id));
  const builtIn = new Set(ids);
  const added = (list as unknown[]).map((x, i) => {
    const entry = parseProviderEntry(x, `providers.local.json[${String(i)}]`);
    if (builtIn.has(entry.id))
      throw new ProviderConfigError(`local provider ${entry.id} reuses a built-in id`);
    if (ids.has(entry.id)) throw new ProviderConfigError(`duplicate local provider id ${entry.id}`);
    ids.add(entry.id);
    return entry;
  });
  return [...base, ...added];
}

export const DEFAULT_LOCAL_FILE = 'providers.local.json';

export interface LoadProvidersOptions {
  /** Default `providers.local.json` in the working directory, skipped if absent. A named file
   * must exist. `null` skips local providers. */
  localFile?: string | null;
  /** Injected for tests; defaults to node:fs/promises (Node only). */
  readFile?: (path: string) => Promise<string>;
}

/** PROVIDERS plus the optional gitignored providers.local.json. Node only. */
export async function loadProviders({ localFile, readFile }: LoadProvidersOptions = {}): Promise<
  readonly ProviderEntry[]
> {
  if (localFile === null) return PROVIDERS;
  const path = localFile ?? DEFAULT_LOCAL_FILE;
  const read =
    readFile ??
    (async (p: string) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(p, 'utf8');
    });
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    if (localFile === undefined && (err as { code?: unknown }).code === 'ENOENT') return PROVIDERS;
    throw new ProviderConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (err) {
    throw new ProviderConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return mergeLocalProviders(PROVIDERS, json);
}
