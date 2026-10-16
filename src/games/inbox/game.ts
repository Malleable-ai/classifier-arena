import type { RealtimeGame } from '../../core/game.js';
import { FLOOR_MS } from '../../core/sched/shared.js';
import { createScriptedDecider } from './baselines.js';
import { INBOX_DATA_SHA256, INBOX_MESSAGES } from './data.js';
import { hashInbox } from './engine/hash.js';
import { inboxMaxTicks, validateConfig } from './engine/schedule.js';
import { canAskLane, cloneInbox, createInbox, inboxResult, stepInbox } from './engine/sim.js';
import type { InboxConfig, InboxState, Ramp } from './engine/types.js';
import { INBOX_PROMPT_CONFIG, inboxQuestion } from './prompt.js';
import { EMPTY_LANE_VIEW, inboxView } from './view.js';

/**
 * Inbox Invaders (docs/architecture/inbox.md): real-time SMS triage at 60 ticks/s. Two lanes, one
 * per seat, share one seeded stream of messages on one schedule; each seat classifies the
 * soonest-to-land message in its own lane as legit, spam or smishing. See engine/sim.ts for the
 * rules and tick order.
 */

export const TICK_RATE = 60;

/**
 * Tuned offline with `pnpm tune --game inbox` (numbers in src/games/inbox/tune.ts's header).
 * Bump `inboxGame.version` whenever any of these change.
 */
export const INBOX_CONFIG: InboxConfig = Object.freeze({
  health: 100,
  damage: 1,
  smishingMultiplier: 3,
  maxChars: 240,
  streamLength: 600,
  spawn: Object.freeze({ startTicks: 20, endTicks: 7, rampTicks: 10_800 }),
  fall: Object.freeze({ startTicks: 240, endTicks: 90, rampTicks: 10_800 }),
});

const CONFIG_KEYS = [
  'health',
  'damage',
  'smishingMultiplier',
  'maxChars',
  'streamLength',
  'spawn',
  'fall',
] as const;
/** A logged config's keys: the engine config's plus `dataSha256`. */
const LOG_KEYS = [...CONFIG_KEYS, 'dataSha256'] as const;
const RAMP_KEYS = ['startTicks', 'endTicks', 'rampTicks'] as const;

/**
 * The config as the header logs it, plus `dataSha256`: the build hash of the committed messages
 * (`create` always plays them), so a replay refuses to run against other data.
 */
function logConfig(c: InboxConfig): Record<string, unknown> {
  return {
    health: c.health,
    damage: c.damage,
    smishingMultiplier: c.smishingMultiplier,
    maxChars: c.maxChars,
    streamLength: c.streamLength,
    spawn: { ...c.spawn },
    fall: { ...c.fall },
    dataSha256: INBOX_DATA_SHA256,
  };
}

/**
 * The inverse of `logConfig`: a header's `config` back to an InboxConfig, for replays. Throws on a
 * missing, extra or wrong-typed field, a value `validateConfig` rejects, or a log made with other
 * messages than data/inbox/messages.json.
 */
export function inboxConfigFromLog(logged: Readonly<Record<string, unknown>>): InboxConfig {
  const fail = (why: string): never => {
    throw new Error(`inbox: logged config ${why}`);
  };
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const exactKeys = (o: Readonly<Record<string, unknown>>, keys: readonly string[], at: string) => {
    for (const k of keys) if (!Object.hasOwn(o, k)) fail(`is missing ${at}${k}`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`has an unknown field ${at}${k}`);
  };
  const int = (v: unknown, at: string): number =>
    typeof v === 'number' && Number.isInteger(v) ? v : fail(`${at} must be an integer`);
  const ramp = (v: unknown, at: string): Ramp => {
    if (!isRecord(v)) return fail(`${at} must be an object`);
    exactKeys(v, RAMP_KEYS, `${at}.`);
    return {
      startTicks: int(v.startTicks, `${at}.startTicks`),
      endTicks: int(v.endTicks, `${at}.endTicks`),
      rampTicks: int(v.rampTicks, `${at}.rampTicks`),
    };
  };
  if (!isRecord(logged)) return fail('must be an object');
  exactKeys(logged, LOG_KEYS, '');
  if (typeof logged.dataSha256 !== 'string') fail('dataSha256 must be a string');
  if (logged.dataSha256 !== INBOX_DATA_SHA256) {
    throw new Error(
      `inbox: messages differ: the log was made with data sha256 ${String(logged.dataSha256)}, ` +
        `data/inbox/messages.json has ${INBOX_DATA_SHA256}`,
    );
  }
  const config: InboxConfig = {
    health: int(logged.health, 'health'),
    damage: int(logged.damage, 'damage'),
    smishingMultiplier: int(logged.smishingMultiplier, 'smishingMultiplier'),
    maxChars: int(logged.maxChars, 'maxChars'),
    streamLength: int(logged.streamLength, 'streamLength'),
    spawn: ramp(logged.spawn, 'spawn'),
    fall: ramp(logged.fall, 'fall'),
  };
  validateConfig(config);
  return config;
}

/** Answers per seat in a match that runs the whole stream: one per message. */
const TYPICAL_DECISIONS = INBOX_CONFIG.streamLength;
/** Upper bound: one request per floor interval for the longest possible match. */
const WORST_DECISIONS = Math.ceil((inboxMaxTicks(INBOX_CONFIG) * (1000 / TICK_RATE)) / FLOOR_MS);

export const inboxGame: RealtimeGame<InboxState, InboxConfig> = {
  id: 'inbox',
  label: 'Inbox Invaders',
  version: 1,
  defaultConfig: INBOX_CONFIG,
  promptConfig: INBOX_PROMPT_CONFIG,
  graded: true,
  baselines: ['scripted'],
  baselineLabels: { scripted: 'Always legit' },
  createBaseline(id, deps) {
    if (id === 'scripted') return createScriptedDecider(deps);
    throw new Error(`inbox: unknown baseline "${id}"`);
  },
  estimate: {
    decisionsPerSeat: { typical: TYPICAL_DECISIONS, worst: WORST_DECISIONS },
    // Jev: median 555 input tokens per decision in the live smoke (2026-10-08). OpenAI: median 343
    // input tokens per decision in the live watchability match (2026-10-12).
    inputTokens: { jev: 555, openai: 343 },
    fallbackInputTokens: 600,
  },
  cadence: { kind: 'realtime', tickRate: TICK_RATE },
  answerRetiresKey: true,

  create: (seed, config) => createInbox(seed, config, INBOX_MESSAGES),
  clone: cloneInbox,
  hash: hashInbox,
  view: (s, seat) => inboxView(s, seat) ?? EMPTY_LANE_VIEW,
  question: inboxQuestion,
  result: inboxResult,
  logConfig,
  configFromLog: inboxConfigFromLog,

  tick: (s) => s.tick,
  canAsk: canAskLane,
  step: stepInbox,
  maxTicks: inboxMaxTicks,
};
