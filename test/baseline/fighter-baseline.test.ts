import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, fnv1a64, utf8Bytes } from '../../src/core/util/hash.js';
import { createPrng, nextBelow } from '../../src/core/util/prng.js';
import { createProviderDecider } from '../../src/core/classifier/provider-decider.js';
import { PROVIDERS, resolveProvider } from '../../src/core/classifier/providers.js';
import { defaultMaxTicks, runScripted } from '../../src/games/fighter/engine/run.js';
import { createMatch } from '../../src/games/fighter/engine/sim.js';
import type {
  AppliedDecision,
  MoveId,
  RoundEndReason,
  Side,
} from '../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../src/games/fighter/engine/types.js';
import { buildQuestion } from '../../src/games/fighter/question.js';
import {
  SAMPLE_VIEW,
  dummyEnv,
  fakeFetch,
  readFixture,
  rotatedOrder,
} from '../games/fighter/sample-view.js';

/**
 * The fighter baseline: the contract for the arena-core refactor. Twenty-four scripted matches and
 * the Jev/OpenAI request bodies for the sample view, recorded before anything moved. Every later
 * step must leave test/fixtures/baseline/fighter.json byte-identical. To regenerate (only when a
 * rule change is intended, and say why in the PR):
 *
 *   UPDATE_BASELINE=1 pnpm vitest run test/baseline
 *
 * which rewrites the fixture and skips the comparisons.
 *
 * The decisions are not stored: the generator below rebuilds them from the seed (it needs only the
 * core PRNG and MOVE_IDS), and the fixture pins their count and hash, then the match result.
 */

const UPDATE = process.env.UPDATE_BASELINE === '1';
const FIXTURE_URL = new URL('../fixtures/baseline/fighter.json', import.meta.url);

/** Decision generator settings shared by every seed (recorded in the fixture too). */
const GENERATOR = {
  /** Salt so the decision stream differs from the engine's own PRNG stream for the same seed. */
  salt: 0x62736c6e,
  /** Side s makes its first decision on tick s * sideOffset. */
  sideOffset: 3,
  /**
   * Decisions are generated up to this tick, independent of the engine, so the decision hash
   * checks only the generator. At least `defaultMaxTicks` (checked below).
   */
  horizonTicks: 18_451,
} as const;

/** Each side's gap between decisions, [min, max] ticks inclusive. */
type Interval = readonly [number, number];
/** Dense random play: rounds end by KO. */
const DENSE: Interval = [5, 9];
/** Sparse random play: long holds, so some rounds run out the clock. */
const SPARSE: Interval = [45, 90];

const PLANS: readonly { seed: number; interval: Interval }[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ seed: i + 1, interval: DENSE })),
  ...Array.from({ length: 4 }, (_, i) => ({ seed: i + 21, interval: SPARSE })),
];

const BODY_PROVIDERS = ['jev', 'openai'] as const;
type BodyProvider = (typeof BODY_PROVIDERS)[number];
const ORDERS = ['canonical', 'rotated'] as const;
type OrderName = (typeof ORDERS)[number];

interface BaselineMatch {
  seed: number;
  interval: Interval;
  /** Number of generated decisions (both sides, up to `horizonTicks`). */
  decisionCount: number;
  /** fnv1a64 of the UTF-8 canonical JSON of the generated decisions. */
  decisionsHash: string;
  finalHash: string;
  totalTicks: number;
  winner: Side | 'draw' | null;
  /** How each round ended, in order. */
  rounds: RoundEndReason[];
}

interface FighterBaseline {
  generator: typeof GENERATOR;
  matches: BaselineMatch[];
  /** Request bodies exactly as sent (parsed from the wire string), per provider and order. */
  requestBodies: Record<BodyProvider, Record<OrderName, unknown>>;
}

/** A uniformly random move for each side every `interval` ticks, up to `horizonTicks`. */
function baselineDecisions(seed: number, [min, max]: Interval): AppliedDecision[] {
  const prng = createPrng((seed ^ GENERATOR.salt) >>> 0);
  const nextTick: [number, number] = [0, GENERATOR.sideOffset];
  const decisions: AppliedDecision[] = [];
  for (let tick = 0; tick < GENERATOR.horizonTicks; tick++) {
    for (const fighter of [0, 1] as const) {
      if (tick !== nextTick[fighter]) continue;
      const move = MOVE_IDS[nextBelow(prng, MOVE_IDS.length)];
      if (move === undefined) throw new Error('nextBelow out of range');
      decisions.push({ fighter, appliedTick: tick, move });
      nextTick[fighter] = tick + min + nextBelow(prng, max - min + 1);
    }
  }
  return decisions;
}

const decisionsHash = (decisions: readonly AppliedDecision[]): string =>
  fnv1a64(utf8Bytes(canonicalJson(decisions)));

/** Run the seed to `matchOver` (default tick budget) and summarise the result. */
function playOut(seed: number, decisions: readonly AppliedDecision[]) {
  const { state, hash } = runScripted(seed, decisions);
  return {
    finalHash: hash,
    totalTicks: state.tick,
    winner: state.winner,
    rounds: state.roundResults.map((r) => r.reason),
  };
}

function baselineMatch(seed: number, interval: Interval): BaselineMatch {
  const decisions = baselineDecisions(seed, interval);
  return {
    seed,
    interval,
    decisionCount: decisions.length,
    decisionsHash: decisionsHash(decisions),
    ...playOut(seed, decisions),
  };
}

/** The JSON string the provider decider POSTs for SAMPLE_VIEW with options in `order`. */
async function wireBody(id: BodyProvider, order: readonly MoveId[]): Promise<string> {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (provider === undefined) throw new Error(`no built-in provider ${id}`);
  const fetchImpl = fakeFetch(200, readFixture(`${id}/choice-ok.json`));
  const decider = createProviderDecider(resolveProvider(provider, dummyEnv(provider)), {
    fetchImpl,
  });
  const res = await decider.decide(SAMPLE_VIEW, buildQuestion(order), new AbortController().signal);
  if (res.status !== 'ok') throw new Error(`${id}: decide returned ${res.status}`);
  const body = fetchImpl.calls[0]?.init?.body;
  if (fetchImpl.calls.length !== 1 || typeof body !== 'string') {
    throw new Error(`${id}: expected one request with a string body`);
  }
  return body;
}

const orderFor = (name: OrderName): readonly MoveId[] =>
  name === 'canonical' ? MOVE_IDS : rotatedOrder();

async function wireBodies(): Promise<Record<BodyProvider, Record<OrderName, string>>> {
  const out = {} as Record<BodyProvider, Record<OrderName, string>>;
  for (const id of BODY_PROVIDERS) {
    out[id] = {
      canonical: await wireBody(id, orderFor('canonical')),
      rotated: await wireBody(id, orderFor('rotated')),
    };
  }
  return out;
}

/**
 * Prettier-formatted JSON, except that each match record sits on one line: one row per seed keeps
 * the fixture small and a changed seed shows as a one-line diff. (test/fixtures/ is in
 * .prettierignore; `requestBodies` keeps Prettier's layout.)
 */
async function writeBaseline(baseline: FighterBaseline): Promise<void> {
  const prettier = await import('prettier');
  const path = FIXTURE_URL.pathname;
  const options = { ...((await prettier.resolveConfig(path)) ?? {}), filepath: path };
  const rows: string[] = [];
  for (const m of baseline.matches) {
    const row = await prettier.format(JSON.stringify(m), { ...options, printWidth: 1000 });
    rows.push(`    ${row.trim()}`);
  }
  const text = await prettier.format(
    JSON.stringify({ ...baseline, matches: [] }, null, 2),
    options,
  );
  const placeholder = '"matches": [],';
  if (!text.includes(placeholder)) throw new Error('fixture layout changed: no empty matches');
  mkdirSync(new URL('.', FIXTURE_URL), { recursive: true });
  writeFileSync(
    FIXTURE_URL,
    text.replace(placeholder, () => `"matches": [\n${rows.join(',\n')}\n  ],`),
  );
}

function readBaseline(): FighterBaseline {
  if (!existsSync(FIXTURE_URL)) {
    throw new Error('no fixture: run UPDATE_BASELINE=1 pnpm vitest run test/baseline');
  }
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as FighterBaseline;
}

function recorded(fixture: FighterBaseline, seed: number): BaselineMatch {
  const m = fixture.matches.find((x) => x.seed === seed);
  if (m === undefined) throw new Error(`no record for seed ${String(seed)}`);
  return m;
}

describe('fighter baseline', () => {
  let wire: Record<BodyProvider, Record<OrderName, string>>;
  let fixture: FighterBaseline;

  beforeAll(async () => {
    wire = await wireBodies();
    if (UPDATE) {
      const requestBodies = {} as FighterBaseline['requestBodies'];
      for (const id of BODY_PROVIDERS) {
        requestBodies[id] = {
          canonical: JSON.parse(wire[id].canonical) as unknown,
          rotated: JSON.parse(wire[id].rotated) as unknown,
        };
      }
      const matches = PLANS.map((p) => baselineMatch(p.seed, p.interval));
      await writeBaseline({ generator: GENERATOR, matches, requestBodies });
    }
    fixture = readBaseline();
  });

  it('records seeds 1–24 with the generator settings and intervals used here', () => {
    expect(fixture.generator).toEqual(GENERATOR);
    expect(fixture.matches.map((m) => ({ seed: m.seed, interval: m.interval }))).toEqual(PLANS);
    expect(GENERATOR.horizonTicks).toBeGreaterThanOrEqual(defaultMaxTicks(createMatch(1).config));
  });

  it('every recorded match reaches matchOver, and both KO and timeout rounds are covered', () => {
    for (const m of fixture.matches) expect(m.winner, `seed ${String(m.seed)}`).not.toBeNull();
    const rounds = fixture.matches.flatMap((m) => m.rounds);
    expect(rounds).toContain('ko');
    expect(rounds).toContain('timeout');
  });

  it.skipIf(UPDATE).each(PLANS)(
    'seed $seed: regenerated decisions match the recorded count and hash, and replay to the recorded result',
    ({ seed, interval }) => {
      const want = recorded(fixture, seed);
      const decisions = baselineDecisions(seed, interval);
      expect({ decisionCount: decisions.length, decisionsHash: decisionsHash(decisions) }).toEqual({
        decisionCount: want.decisionCount,
        decisionsHash: want.decisionsHash,
      });
      expect(playOut(seed, decisions)).toEqual({
        finalHash: want.finalHash,
        totalTicks: want.totalTicks,
        winner: want.winner,
        rounds: want.rounds,
      });
    },
  );

  it
    .skipIf(UPDATE)
    .each(BODY_PROVIDERS.flatMap((id) => ORDERS.map((order) => [id, order] as const)))(
    '%s request body (%s order) is byte-identical to the fixture',
    (id, order) => {
      expect(wire[id][order]).toBe(JSON.stringify(fixture.requestBodies[id][order]));
    },
  );

  it.each(BODY_PROVIDERS)(
    '%s canonical body is byte-identical to the conformance fixture choice-ok.request.json',
    (id) => {
      const want = JSON.stringify(readFixture(`${id}/choice-ok.request.json`));
      expect(JSON.stringify(fixture.requestBodies[id].canonical)).toBe(want);
      expect(wire[id].canonical).toBe(want);
    },
  );

  it('the rotated order really differs from the canonical one', () => {
    expect(rotatedOrder()).not.toEqual(MOVE_IDS);
    for (const id of BODY_PROVIDERS) {
      // Compare as strings: Jev's criteria differ only in key order, which toEqual ignores.
      expect(JSON.stringify(fixture.requestBodies[id].rotated)).not.toBe(
        JSON.stringify(fixture.requestBodies[id].canonical),
      );
    }
  });
});
