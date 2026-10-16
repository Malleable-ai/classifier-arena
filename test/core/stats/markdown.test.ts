import { describe, expect, it } from 'vitest';
import {
  formatMs,
  formatPercent,
  formatResult,
  formatUsd,
} from '../../../src/core/stats/format.js';
import { OVERALL_FORMULA, buildLeaderboard } from '../../../src/core/stats/leaderboard.js';
import { leaderboardMarkdown, summaryMarkdown } from '../../../src/core/stats/markdown.js';
import { summarizeGame } from '../../../src/core/stats/summary.js';
import {
  CLUES,
  FIGHTER,
  INBOX,
  cluesMatch,
  decision,
  failure,
  fakeLog,
  refusal,
} from './helpers.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/** The Markdown written next to each JSON file: GitHub tables that state how numbers are made. */

const h2h = fakeLog({
  game: 'inbox',
  players: ['jev', 'openai'],
  winner: 0,
  scores: [40, 10],
  runId: 'm-aaaaaaaaaaaa',
  decisions: [
    decision(0, { latencyMs: 180, correct: true, costUsd: 0.00002 }),
    decision(1, { latencyMs: 420, correct: false, costUsd: 0.0001 }),
  ],
});
const base = fakeLog({
  game: 'inbox',
  players: ['random', 'scripted'],
  winner: 1,
  scores: [0, 8],
  run: 2,
});
const inbox = summarizeGame(INBOX, [h2h, base], NO_EXCLUSIONS);

describe('format helpers', () => {
  it('percent, milliseconds and dollars', () => {
    expect(formatPercent(0.625)).toBe('62.5%');
    expect(formatPercent(null)).toBe('—');
    expect(formatMs(183.26)).toBe('183 ms');
    expect(formatMs(null)).toBe('—');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.021)).toBe('$0.021');
    expect(formatUsd(0.0004567)).toBe('$0.00046');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(null)).toBe('—');
    // Never exponent form, however small (toPrecision would print "1.2e-7").
    expect(formatUsd(0.00000012)).toBe('$0.00000012');
    expect(formatUsd(0.0000012)).toBe('$0.0000012');
    expect(formatUsd(3.1e-12)).toBe('$0.0000000000031');
    expect(formatUsd(9.96e-8)).toBe('$0.00000010');
  });

  it('results: the winner’s score first, a draw, and a win on the tiebreak', () => {
    const names = ['Jev', 'OpenAI'] as const;
    expect(formatResult(names, 0, [34, 33])).toBe('Jev wins 34–33');
    expect(formatResult(names, 1, [2, 5])).toBe('OpenAI wins 5–2');
    expect(formatResult(names, 'draw', [33, 33])).toBe('Draw 33–33');
    expect(formatResult(names, null, [0, 0])).toBe('Draw 0–0');
    expect(formatResult(names, 1, [33, 33])).toBe('OpenAI wins on the tiebreak (33–33)');
  });
});

describe('summaryMarkdown', () => {
  const md = summaryMarkdown(inbox);

  it('titles the game and says it is generated', () => {
    expect(md).toMatch(/^# Inbox Invaders: results\n/);
    expect(md).toContain('pnpm leaderboard');
    expect(md).toContain('results/inbox/matches/');
  });

  it('has pairing and player tables', () => {
    expect(md).toContain(
      '| Pairing | Valid matches | Wins–draws–losses | Win rate | 95% interval | Invalid |',
    );
    expect(md).toMatch(/\| Jev \(TypeSafe\) vs OpenAI Decisions \(gpt-6-luna\) \| 1 \| 1–0–0 \|/);
    expect(md).toContain(
      '| Player | Kind | Matches | Decisions | Miss rate | Refusal rate | Accuracy |',
    );
    expect(md).toMatch(
      /\| Jev \(TypeSafe\) \| provider \| 1 \| 1 \| 0\.0% \| 0\.0% \| 100\.0% \| 180 ms \|/,
    );
    // A player with no decisions has no rates.
    expect(md).toMatch(/\| Random \(uniform\) \| baseline \| 1 \| 0 \| — \| — \|/);
    expect(md).toContain('a refusal never makes a match invalid');
  });

  it('shows refusal rates, and lists the matches the current rule re-scored', () => {
    const oks = (seat: 0 | 1, n: number) =>
      Array.from({ length: n }, (_, i) => decision(seat, { sentTick: i, choice: 'jab' }));
    // Logged invalid only because OpenAI refused 4 of 40 (10%): valid under the current rule.
    const refused = fakeLog({
      game: 'fighter',
      players: ['jev', 'openai'],
      winner: 1,
      scores: [1, 2],
      valid: false,
      decisions: [...oks(0, 40), ...oks(1, 36), ...[0, 1, 2, 3].map(() => refusal(1, {}, true))],
    });
    // Logged valid, but its transport errors are over 2%.
    const broken = fakeLog({
      game: 'fighter',
      players: ['openai', 'jev'],
      winner: 0,
      scores: [2, 0],
      run: 2,
      decisions: [...oks(0, 10), ...oks(1, 9), failure(1)],
    });
    const md = summaryMarkdown(summarizeGame(FIGHTER, [refused, broken], NO_EXCLUSIONS));
    expect(md).toMatch(
      /\| OpenAI Decisions \(gpt-6-luna\) \| provider \| 1 \| 40 \| 0\.0% \| 10\.0% \|/,
    );
    expect(md).toContain(
      'Re-scored valid under the current validity rule (logged invalid when played, now ' +
        'scored; timeouts no longer count toward validity since 2026-10-16, refusals since ' +
        `2026-10-12):\n\n- \`${refused.header.matchId}\``,
    );
    expect(md).toContain(
      'Re-scored invalid under the current validity rule (logged valid when played, not ' +
        `scored):\n\n- \`${broken.header.matchId}\``,
    );
    expect(md).toContain(
      `Invalid matches (kept, not scored):\n\n- \`${broken.header.matchId}\`: Jev (seat 1) had ` +
        'transport errors on 10.0% of its decisions (limit 2%)',
    );
    expect(summaryMarkdown(inbox)).not.toContain('Re-scored');
  });

  it('lists matches excluded by hand under their own heading, with reasons', () => {
    const reason = 'The Mac slept mid-match (before stall detection)';
    const s = summarizeGame(INBOX, [h2h, base], new Map([[h2h.header.matchId, reason]]));
    const md = summaryMarkdown(s);
    expect(md).toContain('Matches: 1 valid, 1 invalid (1 excluded by hand), 0 unfinished.');
    expect(md).toContain(
      '## Excluded by hand\n\nKept but not scored: an infrastructure failure the log can’t ' +
        'show (listed in `results/excluded.json`).\n\n' +
        `- \`${h2h.header.matchId}\`: ${reason}\n`,
    );
    // Not listed with the matches invalid by the rule.
    expect(md).not.toContain('Invalid matches (kept, not scored)');
    expect(summaryMarkdown(inbox)).not.toContain('Excluded by hand');

    const lb = leaderboardMarkdown(buildLeaderboard([s]));
    expect(lb).toContain('1 valid matches (0 head to head), 1 invalid (1 excluded by hand).');
    expect(lb).toContain(`### Excluded by hand\n\n`);
    expect(lb).toContain(`- \`${h2h.header.matchId}\`: ${reason}\n`);
    expect(lb).toContain('1 match is excluded by hand (results/excluded.json)');
    expect(leaderboardMarkdown(buildLeaderboard([inbox]))).not.toContain('excluded by hand');
  });

  it('names the machine the provider runs came from, by run id', () => {
    expect(md).toContain('Provider runs carry run id m-aaaaaaaaaaaa.');
  });

  it('explains the win rate and names the featured match', () => {
    expect(md).toContain('a draw counts as half a win');
    expect(md).toContain('95% Wilson');
    expect(md).toContain(h2h.header.matchId);
  });

  it('says who won the featured match, and that a tied score was won on the tiebreak', () => {
    const won = fakeLog({
      game: 'clues',
      players: ['openai', 'jev'],
      winner: 1,
      scores: [33, 33],
      totalTicks: 48,
    });
    const tied = summaryMarkdown(summarizeGame(CLUES, [won], NO_EXCLUSIONS));
    expect(tied).toContain(
      `Featured match: \`${won.header.matchId}\` (Jev wins on the tiebreak (33–33), the closest ` +
        'valid head-to-head).',
    );
    const drawn = fakeLog({
      game: 'clues',
      players: ['jev', 'openai'],
      winner: 'draw',
      scores: [5, 5],
    });
    expect(summaryMarkdown(summarizeGame(CLUES, [drawn], NO_EXCLUSIONS))).toContain('(Draw 5–5, ');
    expect(md).toContain('(Jev wins');
  });

  it('points to the “Run id” section of core.md when the runs carry several run ids', () => {
    const two = summarizeGame(
      INBOX,
      [
        fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [2, 1], runId: 'm-111111111111' }),
        fakeLog({
          players: ['openai', 'jev'],
          winner: 0,
          scores: [2, 1],
          run: 2,
          runId: 'm-222222222222',
        }),
      ],
      NO_EXCLUSIONS,
    );
    const text = summaryMarkdown(two);
    expect(text).toContain('see the “Run id” section of docs/architecture/core.md');
    expect(text).not.toContain('README');
  });

  it('says so when there is nothing yet', () => {
    const empty = summaryMarkdown(summarizeGame(CLUES, [], NO_EXCLUSIONS));
    expect(empty).toContain('No matches yet.');
    expect(empty).toContain('Featured match: none yet');
  });
});

describe('leaderboardMarkdown', () => {
  const fighter = summarizeGame(
    FIGHTER,
    [fakeLog({ game: 'fighter', players: ['random', 'scripted'], winner: 1, scores: [0, 2] })],
    NO_EXCLUSIONS,
  );
  const lb = buildLeaderboard([fighter, inbox, summarizeGame(CLUES, [], NO_EXCLUSIONS)]);
  const md = leaderboardMarkdown(lb);

  it('states the formula and the notes', () => {
    expect(md).toMatch(/^# Leaderboard\n/);
    expect(md).toContain(OVERALL_FORMULA);
    expect(md).toContain('API-reported');
    expect(md).toContain('measured from one machine (run id m-aaaaaaaaaaaa)');
  });

  it('overall table: a column per game, — where a game has no head-to-head', () => {
    expect(md).toContain('| Model | Overall | Fighter | Inbox Invaders | Clue Clash |');
    expect(md).toMatch(
      /\| Jev \(TypeSafe\) \| 100\.0% \| — \| 100\.0% \(20\.7–100\.0%, n=1\) \| — \|/,
    );
  });

  it('a section per game, with each model’s refusal rate, and the baseline reference tables', () => {
    expect(md).toContain(
      '| Model | Head-to-head win rate | 95% interval | Matches | Accuracy | Refusal rate |',
    );
    expect(md).toMatch(
      /\| Jev \(TypeSafe\) \| 100\.0% \| 20\.7–100\.0% \| 1 \| 100\.0% \| 0\.0% \|/,
    );
    expect(md).toContain('A refusal (the model declining to answer) is not a miss');
    expect(md).toContain('## Fighter');
    expect(md).toContain('## Inbox Invaders');
    expect(md).toContain('## Clue Clash');
    expect(md).toContain('## Baselines');
    expect(md).toMatch(/\| Fighter \| Scripted bot \| 1 \|/);
  });

  it('says so when no head-to-head has been run', () => {
    const none = leaderboardMarkdown(buildLeaderboard([fighter]));
    expect(none).toContain('No head-to-head runs yet');
    expect(none).toContain(OVERALL_FORMULA);
  });
});

describe('the run-level miss check in the Markdown', () => {
  const passing = summarizeGame(CLUES, [cluesMatch([0, 0])], NO_EXCLUSIONS);
  const failing = summarizeGame(CLUES, [cluesMatch([0, 1]), cluesMatch([2, 0], 2)], NO_EXCLUSIONS);

  it('summary.md: every game says how the check works and whether it passed', () => {
    for (const md of [summaryMarkdown(passing), summaryMarkdown(inbox)]) {
      expect(md).toContain('## Run-level miss check');
      expect(md).toContain('A timeout is the model’s own miss and never makes a match invalid');
      expect(md).toContain('Passed: no player missed more than 2% of its decisions.');
      expect(md).not.toContain('[!WARNING]');
    }
  });

  it('summary.md: a failed check is a warning at the top and in its section, with the rates', () => {
    const md = summaryMarkdown(failing);
    const warning =
      '> Run-level miss check failed: Jev (TypeSafe) missed 6.3% of its decisions (2 of 32); ' +
      'OpenAI Decisions (gpt-6-luna) missed 3.1% of its decisions (1 of 32) over this run’s ' +
      'valid matches; the limit is 2%.';
    expect(md.split('[!WARNING]')).toHaveLength(3);
    expect(md).toContain(warning);
    expect(md.indexOf('[!WARNING]')).toBeLessThan(md.indexOf('## Pairings'));
  });

  it('leaderboard.md: flags the game under the overall table and warns in its section', () => {
    const md = leaderboardMarkdown(buildLeaderboard([inbox, failing]));
    expect(md).toContain('> Clue Clash: the run-level miss check failed (see below).');
    const section = md.slice(md.indexOf('## Clue Clash'));
    expect(section).toContain('> [!WARNING]\n> Run-level miss check failed: Jev (TypeSafe)');
    expect(leaderboardMarkdown(buildLeaderboard([inbox, passing]))).not.toContain('[!WARNING]');
  });
});
