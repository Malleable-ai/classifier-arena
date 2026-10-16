import { describe, expect, it } from 'vitest';
import type { MatchLog } from '../../../src/core/log/read.js';
import type { DecisionLine } from '../../../src/core/log/schema.js';
import type { ResultsIndex, ResultsIndexEntry } from '../../../src/core/replay/results-index.js';
import { parseMatchId } from '../../../src/core/results/paths.js';
import {
  buildMatchList,
  defaultMatchId,
  filterRows,
  formatDuration,
  resultText,
  validityBadge,
  whenText,
  withLog,
  type HistoryGame,
} from '../../../src/web/shell/history.js';
import { panelModel, shortLabel, type PanelHeader } from '../../../src/web/shell/panel.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

const GAME_IDS = ['fighter', 'clues'];
const FIGHTER: HistoryGame = {
  id: 'fighter',
  label: 'Fighter',
  cadence: { kind: 'realtime', tickRate: 60 },
  baselines: ['random', 'scripted', 'human'],
  baselineLabels: {
    random: 'Random (uniform)',
    scripted: 'Scripted bot',
    human: 'Human (live mode)',
  },
  gameIds: GAME_IDS,
};
const CLUES: HistoryGame = {
  id: 'clues',
  label: 'Clue Clash',
  cadence: { kind: 'turns' },
  baselines: ['random'],
  baselineLabels: { random: 'Random (uniform)' },
  gameIds: GAME_IDS,
};

function entry(id: string, over: Partial<ResultsIndexEntry> = {}): ResultsIndexEntry {
  const p = parseMatchId(id, GAME_IDS);
  if (p === null) throw new Error(id);
  return {
    id,
    game: p.game,
    file: `${p.game}/matches/${id}.jsonl`,
    players: p.players,
    labels: ['Random (uniform)', 'Scripted bot'],
    winner: p.players[1],
    winnerSeat: 1,
    scores: [0, 2],
    valid: true,
    featured: false,
    seed: 7,
    startTime: '2026-10-07T22:23:47.877Z',
    totalTicks: 2252,
    finalStateHash: 'x',
    costUsd: 0,
    ...over,
  };
}

const index = (...matches: ResultsIndexEntry[]): ResultsIndex => ({ schemaVersion: 2, matches });

const IDS = [
  '20261007-172347-fighter-random-vs-scripted-1',
  '20261007-174144-fighter-jev-vs-openai-1',
  '20261007-172348-fighter-scripted-vs-random-1',
  '20261007-173946-fighter-openai-vs-jev-1',
];

describe('buildMatchList', () => {
  it('lists every log, filling indexed rows from the index and marking the rest local', () => {
    const rows = buildMatchList(
      FIGHTER,
      IDS,
      index(entry(IDS[0] ?? ''), entry(IDS[2] ?? '')),
      NO_EXCLUSIONS,
    );
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.id === IDS[0])).toMatchObject({
      game: 'fighter',
      local: false,
      valid: true,
      winner: 1,
      scores: [0, 2],
      totalTicks: 2252,
      labels: ['Random (uniform)', 'Scripted bot'],
      loaded: true,
      headToHead: false,
    });
    expect(rows.find((r) => r.id === IDS[1])).toMatchObject({
      local: true,
      valid: null,
      winner: null,
      scores: null,
      players: ['jev', 'openai'],
      labels: ['Jev', 'OpenAI Decisions'],
      date: '2026-10-07',
      time: '17:41:44',
      headToHead: true,
      loaded: false,
    });
  });

  it("uses only this game's index entries", () => {
    const clueId = '20261007-180000-clues-jev-vs-random-1';
    const rows = buildMatchList(
      CLUES,
      [clueId],
      index(entry(IDS[0] ?? ''), entry(clueId)),
      NO_EXCLUSIONS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: clueId, game: 'clues', local: false, loaded: true });
    // The fighter page doesn't pick up a clues entry for an id it doesn't list either.
    expect(
      buildMatchList(FIGHTER, [IDS[0] ?? ''], index(entry(clueId)), NO_EXCLUSIONS)[0]?.local,
    ).toBe(true);
  });

  it('sorts newest first with featured pinned at the top', () => {
    const rows = buildMatchList(
      FIGHTER,
      IDS,
      index(entry(IDS[0] ?? '', { featured: true })),
      NO_EXCLUSIONS,
    );
    expect(rows.map((r) => r.id)).toEqual([
      '20261007-172347-fighter-random-vs-scripted-1',
      '20261007-174144-fighter-jev-vs-openai-1',
      '20261007-173946-fighter-openai-vs-jev-1',
      '20261007-172348-fighter-scripted-vs-random-1',
    ]);
  });

  it('keeps oddly named logs, and works without an index', () => {
    const rows = buildMatchList(FIGHTER, ['scratch'], index(entry(IDS[0] ?? '')), NO_EXCLUSIONS);
    expect(rows.map((r) => r.id)).toEqual(['scratch']);
    expect(rows[0]).toMatchObject({ local: true, players: ['?', '?'], date: '', time: '' });
    expect(buildMatchList(FIGHTER, IDS, null, NO_EXCLUSIONS).every((r) => r.local)).toBe(true);
  });
});

describe('filterRows and defaultMatchId', () => {
  const ids = [
    '20261007-172347-fighter-random-vs-scripted-1',
    '20261007-174144-fighter-jev-vs-openai-1',
    '20261007-173946-fighter-openai-vs-jev-1',
    '20261007-175000-fighter-jev-vs-jev-1',
    '20261007-175100-fighter-my_model-vs-human-1',
  ];

  it('splits head to head (two different providers) from baselines', () => {
    const rows = buildMatchList(FIGHTER, ids, null, NO_EXCLUSIONS);
    expect(
      filterRows(rows, 'h2h')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[2], ids[1]]);
    expect(
      filterRows(rows, 'baselines')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[0], ids[3], ids[4]]);
    expect(filterRows(rows, 'all')).toHaveLength(5);
  });

  it("knows each game's baselines", () => {
    // `scripted` is a provider id as far as Clue Clash knows (it has only `random`).
    const rows = buildMatchList(
      CLUES,
      ['20261007-180000-clues-jev-vs-scripted-1'],
      null,
      NO_EXCLUSIONS,
    );
    expect(rows[0]?.headToHead).toBe(true);
  });

  it('opens on the featured match, else the newest', () => {
    expect(
      defaultMatchId(
        buildMatchList(FIGHTER, ids, index(entry(ids[0] ?? '', { featured: true })), NO_EXCLUSIONS),
      ),
    ).toBe(ids[0]);
    expect(defaultMatchId(buildMatchList(FIGHTER, ids, null, NO_EXCLUSIONS))).toBe(ids[4]);
    expect(defaultMatchId([])).toBeNull();
  });
});

function fakeLog(
  end: MatchLog['matchEnd'],
  cadence = FIGHTER.cadence,
  decisions: DecisionLine[] = [],
): MatchLog {
  return {
    header: {
      cadence,
      seats: [
        { player: 'jev', label: 'Jev (TypeSafe)' },
        { player: 'openai', label: 'OpenAI Decisions (gpt-6-luna)' },
      ],
    },
    decisions,
    events: [],
    matchEnd: end,
  } as unknown as MatchLog;
}

const END: NonNullable<MatchLog['matchEnd']> = {
  type: 'match_end',
  winner: 1,
  scores: [0, 2],
  totalTicks: 1581,
  finalStateHash: 'h',
  valid: true,
  missRates: [0, 0],
  decisions: [1, 1],
  costUsd: 0.0157,
};

describe('withLog', () => {
  it('fills an unindexed row from the header and match_end', () => {
    const [row] = buildMatchList(
      FIGHTER,
      ['20261007-174144-fighter-jev-vs-openai-1'],
      null,
      NO_EXCLUSIONS,
    );
    if (row === undefined) throw new Error('no row');
    expect(withLog(row, fakeLog(END), FIGHTER.baselines, NO_EXCLUSIONS)).toMatchObject({
      labels: ['Jev (TypeSafe)', 'OpenAI Decisions (gpt-6-luna)'],
      winner: 1,
      scores: [0, 2],
      totalTicks: 1581,
      valid: true,
      finished: true,
      loaded: true,
      local: true,
      headToHead: true,
    });
    expect(withLog(row, fakeLog(null), FIGHTER.baselines, NO_EXCLUSIONS)).toMatchObject({
      finished: false,
      winner: null,
    });
  });

  it('re-scores validity from the decisions, as the index does, not match_end.valid', () => {
    const [row] = buildMatchList(
      FIGHTER,
      ['20261007-174144-fighter-jev-vs-openai-1'],
      null,
      NO_EXCLUSIONS,
    );
    if (row === undefined) throw new Error('no row');
    const line = (status: DecisionLine['status'], error?: string): DecisionLine => ({
      type: 'decision',
      seat: 1,
      seq: 0,
      questionKey: 'next_move',
      sentTick: 0,
      appliedTick: null,
      latencyMs: 170,
      choice: null,
      probabilities: null,
      confidence: null,
      inputTokens: 145,
      costUsd: 0.0000145,
      status,
      ...(error === undefined ? {} : { error }),
    });
    // Logged invalid only because of a refusal: valid now (no INVALID badge).
    const refused = fakeLog({ ...END, valid: false }, FIGHTER.cadence, [
      line('refusal', 'invalid answer: refusal'),
    ]);
    expect(withLog(row, refused, FIGHTER.baselines, NO_EXCLUSIONS).valid).toBe(true);
    // A transport failure still makes it invalid.
    const failed = fakeLog({ ...END, valid: false }, FIGHTER.cadence, [
      line('error', 'network: fetch failed'),
    ]);
    expect(withLog(row, failed, FIGHTER.baselines, NO_EXCLUSIONS).valid).toBe(false);
  });
});

describe('matches excluded by hand (results/excluded.json)', () => {
  const id = '20261007-174144-fighter-jev-vs-openai-1';
  const reason = 'The Mac slept mid-match (before stall detection)';
  const excluded = new Map([[id, reason]]);

  it('marks an excluded row invalid with its reason, indexed or not, before its log loads', () => {
    const [indexed] = buildMatchList(FIGHTER, [id], index(entry(id, { valid: true })), excluded);
    expect(indexed).toMatchObject({ valid: false, excluded: reason, loaded: true });
    const [local] = buildMatchList(FIGHTER, [id], null, excluded);
    expect(local).toMatchObject({ valid: false, excluded: reason, loaded: false });
    const [other] = buildMatchList(FIGHTER, [id], index(entry(id)), NO_EXCLUSIONS);
    expect(other).toMatchObject({ valid: true, excluded: null });
  });

  it('keeps it invalid when its log loads and validity is recomputed', () => {
    const [row] = buildMatchList(FIGHTER, [id], null, excluded);
    if (row === undefined) throw new Error('no row');
    const base = fakeLog(END);
    const log: MatchLog = { ...base, header: { ...base.header, matchId: id } };
    expect(withLog(row, log, FIGHTER.baselines, NO_EXCLUSIONS).valid).toBe(true);
    expect(withLog(row, log, FIGHTER.baselines, excluded)).toMatchObject({
      valid: false,
      excluded: reason,
    });
  });

  it('shows an EXCLUDED badge with the reason as its tooltip, else valid or invalid', () => {
    expect(validityBadge({ valid: false, excluded: reason })).toEqual({
      text: 'excluded',
      kind: 'bad',
      title: `Excluded by hand: ${reason}`,
    });
    expect(validityBadge({ valid: true, excluded: null })).toEqual({
      text: 'valid',
      kind: 'ok',
      title: null,
    });
    expect(validityBadge({ valid: false, excluded: null })).toMatchObject({ text: 'invalid' });
    expect(validityBadge({ valid: null, excluded: null })).toBeNull();
  });
});

describe('row text', () => {
  const [row] = buildMatchList(
    FIGHTER,
    ['20261007-174144-fighter-jev-vs-openai-1'],
    null,
    NO_EXCLUSIONS,
  );
  if (row === undefined) throw new Error('no row');

  it('names the winner by the short form of their seat label, with their score first', () => {
    expect(resultText(row)).toBe('…');
    expect(resultText({ ...row, loaded: true, winner: 1, scores: [0, 2] })).toBe('OpenAI wins 2–0');
    expect(resultText({ ...row, loaded: true, winner: 0, scores: [2, 1] })).toBe('Jev wins 2–1');
    expect(resultText({ ...row, loaded: true, winner: 'draw', scores: [2, 2] })).toBe('Draw 2–2');
    // A win on equal scores (Clue Clash's latency tiebreak) never reads as a draw.
    expect(resultText({ ...row, loaded: true, winner: 1, scores: [33, 33] })).toBe(
      'OpenAI wins on the tiebreak (33–33)',
    );
    expect(resultText({ ...row, loaded: true, finished: false })).toBe('Unfinished');
  });

  it('shows the run time as "Oct 7, 17:41"', () => {
    expect(whenText(row)).toBe('Oct 7, 17:41');
    expect(whenText({ date: '', time: '' })).toBe('');
  });

  it('formats real-time durations as m:ss and turn games in turns', () => {
    expect(formatDuration(1581, { kind: 'realtime', tickRate: 60 })).toBe('0:26');
    expect(formatDuration(3720, { kind: 'realtime', tickRate: 60 })).toBe('1:02');
    expect(formatDuration(16, { kind: 'turns' })).toBe('16 turns');
  });
});

describe('labels: the list, the result text and the ticker name a player the same way', () => {
  const id = '20261007-172348-fighter-scripted-vs-random-1';
  const header: PanelHeader = {
    labels: ['Scripted bot', 'Random (uniform)'],
    cadence: FIGHTER.cadence,
  };
  const scriptedLog = {
    ...fakeLog({ ...END, winner: 0, scores: [2, 0] }),
    header: {
      cadence: FIGHTER.cadence,
      seats: [
        { player: 'scripted', label: 'Scripted bot' },
        { player: 'random', label: 'Random (uniform)' },
      ],
    },
  } as unknown as MatchLog;
  const tickerName = (seat: 0 | 1): string => {
    const decision = {
      seat,
      choice: 'jab',
      probabilities: null,
      status: 'ok',
      latencyMs: 200,
      appliedTick: 1,
    };
    const model = panelModel([decision as DecisionLine], 1, header, { optionLabel: (o) => o });
    return model.ticker[0]?.text.split(' → ')[0] ?? '';
  };

  it("labels a game's baselines from the game before their log loads", () => {
    const [row] = buildMatchList(FIGHTER, [id], null, NO_EXCLUSIONS);
    expect(row?.labels).toEqual(['Scripted bot', 'Random (uniform)']);
    // A player the game doesn't know is shown by its id.
    expect(
      buildMatchList(CLUES, ['20261007-180000-clues-my_model-vs-random-1'], null, NO_EXCLUSIONS)[0],
    ).toEqual(expect.objectContaining({ labels: ['my_model', 'Random (uniform)'] }));
  });

  it('names the winner from the seat label, as the ticker does, before and after the log loads', () => {
    const [row] = buildMatchList(FIGHTER, [id], null, NO_EXCLUSIONS);
    if (row === undefined) throw new Error('no row');
    const loaded = withLog(row, scriptedLog, FIGHTER.baselines, NO_EXCLUSIONS);
    expect(loaded.labels).toEqual(header.labels);
    expect(resultText(loaded)).toBe('Scripted wins 2–0');
    expect(resultText(loaded)).toBe(`${shortLabel(loaded.labels[0])} wins 2–0`);
    expect(tickerName(0)).toBe(`P1 ${shortLabel(loaded.labels[0])}`);
    expect(tickerName(1)).toBe('P2 Random');
    const indexed = buildMatchList(
      FIGHTER,
      [id],
      index(entry(id, { labels: ['Scripted bot', 'Random (uniform)'], winnerSeat: 0 })),
      NO_EXCLUSIONS,
    )[0];
    expect(indexed && resultText({ ...indexed, scores: [2, 0] })).toBe('Scripted wins 2–0');
  });
});
