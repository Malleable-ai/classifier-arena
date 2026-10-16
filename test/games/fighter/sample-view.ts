import { readFileSync } from 'node:fs';
import type { ProviderEntry } from '../../../src/core/classifier/providers.js';
import type { View } from '../../../src/games/fighter/view.js';
import type { MoveId } from '../../../src/games/fighter/engine/types.js';

/**
 * The spike's sample view (the example in docs/architecture/fighter.md), as sent in
 * test/fixtures/<id>/choice-ok.request.json. Key order matters: OpenAI receives
 * JSON.stringify(view), so this must serialise byte-for-byte like the recorded request.
 */
export const SAMPLE_VIEW: View = {
  you: {
    health: 72,
    x: 410,
    airborne: false,
    action: 'block_high',
    phase: 'active',
    busy_ticks: 0,
    fireball_ready: true,
    last_moves: ['jab', 'walk_forward', 'block_high'],
  },
  opponent: {
    health: 65,
    x: 590,
    airborne: false,
    action: 'walk_forward',
    phase: 'active',
    busy_ticks: 0,
    fireball_ready: false,
    last_moves: ['fireball', 'walk_back', 'walk_forward'],
  },
  distance: 180,
  range: 'mid',
  opponent_fireball: { distance: 240, ticks_to_hit: 40 },
  your_fireball_on_screen: false,
  round: 2,
  round_clock_s: 41,
  rounds_won: { you: 1, opponent: 0 },
};

export const FIXTURES_DIR = new URL('../../fixtures/', import.meta.url);

export function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, FIXTURES_DIR), 'utf8')) as unknown;
}

/** A fetch stand-in that answers every call with `body` and `status`, and records the calls. */
export function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers }));
  };
  return Object.assign(impl, { calls });
}

/** Env with a dummy value for every variable the entry needs. */
export function dummyEnv(p: ProviderEntry): Record<string, string> {
  const env: Record<string, string> = { [p.auth.keyEnv]: 'test-key' };
  for (const name of p.extraEnv ?? []) env[name] = 'test';
  return env;
}

/**
 * A non-canonical option order: the one the retired per-match rule (sfc32(seed ^ 0x6f70746e)
 * Fisher–Yates over MOVE_IDS) gave seed 1. The baseline fixture recorded both providers' request
 * bodies in this order, so it is kept as data now that the core rule (which also hashes the
 * question key) orders matches.
 */
const ROTATED_ORDER: readonly MoveId[] = [
  'walk_back',
  'sweep',
  'throw',
  'heavy_punch',
  'block_high',
  'uppercut',
  'fireball',
  'jab',
  'block_low',
  'walk_forward',
  'jump_in',
];

/** A rotated order that differs from the canonical one (the baseline fixture's). */
export function rotatedOrder(): readonly MoveId[] {
  return ROTATED_ORDER;
}
