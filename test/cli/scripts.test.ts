import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package.json scripts', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('point at files that exist', () => {
    const targets = Object.values(pkg.scripts).flatMap((s) =>
      [...s.matchAll(/\btsx (\S+\.ts)\b/g)].map((m) => m[1] ?? ''),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(existsSync(t), t).toBe(true);
  });

  it('include every CLI the plan names', () => {
    for (const name of [
      'match',
      'tournament',
      'tune',
      'render',
      'cut',
      'leaderboard',
      'index-results',
    ]) {
      expect(pkg.scripts[name], name).toBe(`tsx src/cli/${name}.ts`);
    }
  });
});
