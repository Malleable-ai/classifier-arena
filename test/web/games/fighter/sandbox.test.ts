import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRandomBot } from '../../../../src/web/games/fighter/bots/random.js';
import { bannerText } from '../../../../src/web/games/fighter/canvas.js';
import { liveEffects } from '../../../../src/web/games/fighter/effects.js';
import { parseRoute } from '../../../../src/web/route.js';
import { createSandbox } from '../../../../src/web/games/fighter/sandbox.js';

function run(seed: number, ticks: number) {
  const sb = createSandbox({ seed, p1: 'random' });
  const kinds = new Set<string>();
  for (let i = 0; i < ticks; i++) {
    sb.tick();
    for (const fx of liveEffects(sb.effects, sb.state.tick)) kinds.add(fx.kind);
  }
  return { sb, kinds };
}

describe('random bot', () => {
  it('picks every 12 ticks, deterministically from the seed', () => {
    const a = createRandomBot(7, 0);
    const b = createRandomBot(7, 0);
    const seqA: (string | null)[] = [];
    const seqB: (string | null)[] = [];
    for (let t = 0; t < 240; t++) {
      seqA.push(a.next(t));
      seqB.push(b.next(t));
    }
    expect(seqA).toEqual(seqB);
    expect(seqA.filter((m) => m !== null)).toHaveLength(20);
    expect(new Set(seqA.filter((m) => m !== null)).size).toBeGreaterThan(5);
  });
});

describe('sandbox', () => {
  it('random vs random is reproducible from the seed', () => {
    const a = run(3, 2000).sb;
    const b = run(3, 2000).sb;
    expect(a.hash()).toBe(b.hash());
    expect(a.lastDecision[0]).not.toBeNull();
    expect(a.recentEvents.length).toBeLessThanOrEqual(20);
  });

  it('produces hit effects and finishes a match', () => {
    const { sb, kinds } = run(5, 60 * 60 * 6);
    expect(kinds.has('spark') || kinds.has('block')).toBe(true);
    expect(sb.state.status).toBe('matchOver');
    expect(bannerText(sb.state)?.line).toMatch(/wins the match|Match drawn/);
  });

  it('restart resets to the same seed', () => {
    const { sb } = run(9, 300);
    sb.restart();
    expect(sb.state.tick).toBe(0);
    for (let i = 0; i < 300; i++) sb.tick();
    expect(sb.hash()).toBe(run(9, 300).sb.hash());
  });
});

describe('sandbox route', () => {
  const ids = ['fighter'];
  it('defaults to the human sandbox and reads p1 and seed', () => {
    expect(parseRoute('/fighter', '?sandbox=1', ids)).toEqual({
      mode: 'sandbox',
      game: 'fighter',
      p1: 'human',
      seed: 1,
    });
    expect(parseRoute('/fighter', '?sandbox=1&p1=random&seed=42', ids)).toEqual({
      mode: 'sandbox',
      game: 'fighter',
      p1: 'random',
      seed: 42,
    });
    expect(parseRoute('/fighter', '?sandbox=1&seed=-3', ids)).toMatchObject({ seed: 1 });
  });
});

describe('render determinism', () => {
  it('render code never calls Math.random', () => {
    const dir = join(import.meta.dirname, '../../../../src/web');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    for (const f of files) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/Math\.random\s*\(/);
    }
  });
});
