import { describe, expect, it } from 'vitest';
import { createPrng } from '../../../src/core/util/prng.js';
import { INBOX_MESSAGES } from '../../../src/games/inbox/data.js';
import { INBOX_CONFIG } from '../../../src/games/inbox/game.js';
import { INBOX_QUESTION } from '../../../src/games/inbox/prompt.js';
import {
  FAST,
  ORACLE,
  RANDOM,
  SCRIPTED,
  createSimulatedPlayer,
  formatTuneReport,
  headToHead,
  labelsByText,
  survival,
  type TuneReport,
} from '../../../src/games/inbox/tune.js';
import { createFakeClock } from '../../core/util/fake-clock.js';

const labels = labelsByText(INBOX_CONFIG);
const signal = new AbortController().signal;

async function answers(accuracy: number, n: number) {
  const clock = createFakeClock();
  const player = createSimulatedPlayer({
    player: 'sim',
    clock,
    latencyMs: 180,
    accuracy,
    prng: createPrng(1),
    labels,
  });
  const out: { right: boolean; latencyMs: number; choice: string | null }[] = [];
  for (let i = 0; i < n; i++) {
    const m = INBOX_MESSAGES[i % INBOX_MESSAGES.length];
    if (!m) throw new Error('unreachable');
    const r = await player.decide({ text: m.text, seconds_to_land: 2 }, INBOX_QUESTION, signal);
    out.push({ right: r.choice === m.label, latencyMs: r.latencyMs, choice: r.choice });
  }
  return out;
}

describe('simulated players', () => {
  it('map every shown text to exactly one label', () => {
    expect(labels.size).toBe(INBOX_MESSAGES.length);
  });

  it('answer after their latency on the injected clock, right at their accuracy', async () => {
    const perfect = await answers(1, 200);
    expect(perfect.every((a) => a.right && a.latencyMs === 180)).toBe(true);
    const never = await answers(0, 200);
    expect(never.some((a) => a.right)).toBe(false);
    const choices = new Set(never.map((a) => a.choice));
    expect(choices).toEqual(new Set(['legit', 'spam', 'smishing']));
    const ninety = await answers(0.9, 2000);
    const rate = ninety.filter((a) => a.right).length / ninety.length;
    expect(rate).toBeGreaterThan(0.87);
    expect(rate).toBeLessThan(0.93);
  });

  it('report an unknown text as an error', async () => {
    const clock = createFakeClock();
    const p = createSimulatedPlayer({
      player: 'sim',
      clock,
      latencyMs: 1,
      accuracy: 1,
      prng: createPrng(1),
      labels,
    });
    const r = await p.decide({ text: 'nope', seconds_to_land: 1 }, INBOX_QUESTION, signal);
    expect(r).toMatchObject({ status: 'error', error: 'unknown text' });
  });
});

describe('tuning harness', () => {
  it('measures survival against an opponent that never loses health', async () => {
    const row = await survival(RANDOM, 2);
    expect(row).toMatchObject({ player: 'random', died: 2, matches: 2, oracleMinHealth: 100 });
    expect(row.meanS).toBeGreaterThan(15);
    expect(row.meanS).toBeLessThan(50);
    expect(row.minS).toBeLessThanOrEqual(row.meanS);
    expect(row.maxS).toBeGreaterThanOrEqual(row.meanS);
  });

  it('keeps the oracle at full health for a whole stream', async () => {
    const row = await survival(ORACLE, 1);
    expect(row).toMatchObject({ died: 0, oracleMinHealth: 100 });
  });

  it('counts head-to-head outcomes with alternating seats', async () => {
    const h = await headToHead(FAST, SCRIPTED, 2);
    expect(h).toMatchObject({ a: '180ms@90%', b: 'scripted', winsA: 2, draws: 0, winsB: 0 });
  });

  it('formats a report', () => {
    const report: TuneReport = {
      matches: 1,
      config: INBOX_CONFIG,
      survival: [
        { player: 'x', meanS: 1, minS: 1, maxS: 1, died: 1, matches: 1, oracleMinHealth: 100 },
      ],
      headToHead: [{ a: 'x', b: 'y', winsA: 1, draws: 0, winsB: 0, meanS: 2 }],
    };
    const text = formatTuneReport(report);
    expect(text).toContain('x vs y');
    expect(text).toContain('1/1');
    expect(text).toContain("opponent's lowest health: 100/100");
  });
});
