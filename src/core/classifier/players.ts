import type { Clock } from '../util/clock.js';
import type { PrngState } from '../util/prng.js';
import { RANDOM_BASELINE, type BaselineInfo } from './baselines.js';
import { createProviderDecider } from './provider-decider.js';
import type { Env, ProviderEntry } from './providers.js';
import { PROVIDERS, missingEnv, resolveProvider } from './providers.js';
import { createRandomDecider } from './random.js';
import type { Decider, PlayerId } from './types.js';

export { RANDOM_BASELINE, gameBaselines, type BaselineInfo } from './baselines.js';

export interface PlayerInfo {
  id: PlayerId;
  label: string;
  kind: 'provider' | 'baseline';
  /** Providers: every required env var is set. Baselines: always true. */
  available: boolean;
  /** Providers only: the env vars that are missing. */
  missingEnv?: string[];
}

/**
 * Provider ids (in registry order) then the baselines (default: `random` only; a game passes its
 * full list). Keys come only from `env`.
 */
export function listPlayers(
  env: Env,
  providers: readonly ProviderEntry[] = PROVIDERS,
  baselines: readonly BaselineInfo[] = [RANDOM_BASELINE],
): PlayerInfo[] {
  return [
    ...providers.map((p): PlayerInfo => {
      const missing = missingEnv(p, env);
      return {
        id: p.id,
        label: p.label,
        kind: 'provider',
        available: missing.length === 0,
        missingEnv: missing,
      };
    }),
    ...baselines.map(({ id, label }): PlayerInfo => ({
      id,
      label,
      kind: 'baseline',
      available: true,
    })),
  ];
}

/** Builds a game-supplied baseline from the shared deps. */
export type BaselineFactory = (deps: CreatePlayerDeps) => Decider;

export interface CreatePlayerDeps {
  /** API keys and account ids. The Node caller passes its environment in. */
  env: Env;
  clock: Clock;
  providers?: readonly ProviderEntry[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Required for `random`: its own PRNG, never the game's. */
  prng?: PrngState;
  /** Simulated delay for baselines (`random` and any game baseline that honours it). */
  baselineDelayMs?: number;
  /** Baselines other than `random`, by id, supplied by the game (core knows no game's bots). */
  baselines?: Readonly<Record<string, BaselineFactory>>;
}

/** `random` from core, then the game's baselines, then the provider registry. */
export function createPlayer(id: PlayerId, deps: CreatePlayerDeps): Decider {
  const { clock, baselineDelayMs } = deps;
  if (id === RANDOM_BASELINE.id) {
    if (!deps.prng) throw new Error('random player needs deps.prng');
    const delay = baselineDelayMs === undefined ? {} : { delayMs: baselineDelayMs };
    return createRandomDecider({ prng: deps.prng, clock, ...delay });
  }
  const baselines = deps.baselines ?? {};
  const make = Object.hasOwn(baselines, id) ? baselines[id] : undefined;
  if (make) return make(deps);
  const entry = (deps.providers ?? PROVIDERS).find((p) => p.id === id);
  if (!entry) throw new Error(`unknown player ${id}`);
  const opts: Parameters<typeof createProviderDecider>[1] = {};
  if (deps.fetchImpl) opts.fetchImpl = deps.fetchImpl;
  if (deps.timeoutMs !== undefined) opts.timeoutMs = deps.timeoutMs;
  return createProviderDecider(resolveProvider(entry, deps.env), opts);
}
