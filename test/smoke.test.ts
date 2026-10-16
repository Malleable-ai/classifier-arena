import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { ENGINE_VERSION } from '../src/games/fighter/engine/constants.js';

describe('smoke', () => {
  it('exports an engine version', () => {
    expect(Number.isInteger(ENGINE_VERSION)).toBe(true);
    expect(ENGINE_VERSION).toBeGreaterThan(0);
  });
});

describe('purity and layering lint guard', () => {
  // Probe files are not on disk, so lint them with the repo config minus type-aware rules.
  const eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });
  const ruleHits = async (code: string, filePath: string, rules: readonly string[]) => {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).filter((m) => m.ruleId !== null && rules.includes(m.ruleId))
      .length;
  };

  const IMPURE = [
    'export const a = Math.random();',
    'export const b = Date.now();',
    'export const c = performance.now();',
    'export const d = window.innerWidth;',
    'export const e = document.title;',
    'export const f = setTimeout(() => undefined, 1);',
    '',
  ].join('\n');
  const purity = (filePath: string) =>
    ruleHits(IMPURE, filePath, ['no-restricted-globals', 'no-restricted-properties']);
  const imports = (code: string, filePath: string) =>
    ruleHits(code, filePath, ['no-restricted-imports']);

  it('bans the wall clock, timers, the DOM and Math.random in src/core and game engines', async () => {
    expect(await purity('src/core/__lint_probe__.ts')).toBe(6);
    expect(await purity('src/core/sched/__lint_probe__.ts')).toBe(6);
    expect(await purity('src/games/fighter/engine/__lint_probe__.ts')).toBe(6);
    // Outside the pure trees nothing is flagged.
    expect(await purity('src/web/__lint_probe__.ts')).toBe(0);
  }, 30_000);

  it('allow-lists only what realClock needs, and never the DOM', async () => {
    // performance and setTimeout are allowed in clock.ts; Math.random, Date, window and document
    // are not.
    expect(await purity('src/core/util/clock.ts')).toBe(4);
  }, 30_000);

  it('stops src/core importing games, the web app, the proxy or the CLIs', async () => {
    const probe = 'src/core/classifier/__lint_probe__.ts';
    for (const dir of ['games/index', 'web/main', 'server/proxy', 'cli/match']) {
      const code = `export * from '../../${dir}.js';\n`;
      expect(await imports(code, probe), dir).toBe(1);
    }
    const typeOnly = "import type { Game } from '../games/index.js';\nexport type G = Game;\n";
    expect(await imports(typeOnly, 'src/core/__lint_probe__.ts')).toBe(1);
    expect(await imports("export * from '../util/prng.js';\n", probe)).toBe(0);
  }, 30_000);

  it('stops game engines importing the web app', async () => {
    const probe = 'src/games/fighter/engine/__lint_probe__.ts';
    const code = "export * from '../../../web/games/fighter/canvas.js';\n";
    expect(await imports(code, probe)).toBe(1);
    expect(await imports("export * from '../../../core/util/prng.js';\n", probe)).toBe(0);
    // The rest of a game (its view, renderer glue) may import what it likes.
    expect(await imports(code.replace('../../../', '../../'), 'src/games/fighter/x.ts')).toBe(0);
  }, 30_000);
});
