// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Purity (docs/architecture/core.md): src/core and every game engine run the same in Node, the
 * browser and replays, so they never read the wall clock, start timers, touch the DOM or call
 * Math.random. Time comes from an injected Clock, randomness from the seeded PRNG.
 */
const PURE_TREES = ['src/core/**/*.ts', 'src/games/*/engine/**/*.ts'];
const DOM_GLOBALS = ['window', 'document'];
const CLOCK_GLOBALS = ['Date', 'performance'];
const TIMER_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'requestAnimationFrame',
];
const PURITY_MESSAGE =
  'src/core and game engines must be deterministic: no wall clock, timers or DOM (use the Clock).';

/** The few files in the pure trees that need some of those globals, and which ones. */
const PURITY_EXCEPTIONS = {
  // realClock: the one real Clock.
  'src/core/util/clock.ts': ['performance', 'setTimeout', 'clearTimeout'],
  // Node pacing for real-time matches on the real clock.
  'src/core/sched/drive.ts': ['setTimeout', 'setImmediate'],
  // Measure real request latency around fetch.
  'src/core/classifier/http.ts': ['performance'],
  'src/core/classifier/provider-decider.ts': ['performance'],
  'src/core/classifier/remote.ts': ['performance'],
};

/** `no-restricted-globals` options banning every purity global except `allowed`. */
function bannedGlobals(allowed = []) {
  return [...DOM_GLOBALS, ...CLOCK_GLOBALS, ...TIMER_GLOBALS]
    .filter((name) => !allowed.includes(name))
    .map((name) => ({ name, message: PURITY_MESSAGE }));
}

/** An import pattern for relative paths that climb into one of `dirs` under src/. */
function climbsInto(dirs, message) {
  return { regex: `^(?:\\.\\./)+(?:${dirs.join('|')})(?:/|$)`, message };
}

export default tseslint.config(
  {
    ignores: [
      '.scratchpad/**',
      'dist/',
      'coverage/',
      'results/',
      'renders/',
      'playwright-report/',
      'test-results/',
      'skills/',
      '.claude/',
      '.agents/',
      '.codex/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: PURE_TREES,
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals()],
    },
  },
  ...Object.entries(PURITY_EXCEPTIONS).map(([file, allowed]) => ({
    files: [file],
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals(allowed)],
    },
  })),
  {
    // Replays and video renders must be reproducible too, so no Math.random in the renderers or
    // the web shell either.
    files: [
      ...PURE_TREES,
      'src/web/games/**/*.ts',
      'src/web/shell/**/*.ts',
      'src/web/cards/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Game engines, src/core, renderers, the web shell and video cards must be deterministic: use the seeded PRNG.',
        },
      ],
    },
  },
  {
    // Layering: core knows no game and no app; engines know no app.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            climbsInto(
              ['games', 'web', 'server', 'cli'],
              'src/core must not import src/games, src/web, src/server or src/cli.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/games/*/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            climbsInto(
              ['web', 'server', 'cli'],
              'Game engines must not import src/web, src/server or src/cli.',
            ),
          ],
        },
      ],
    },
  },
  prettier,
);
