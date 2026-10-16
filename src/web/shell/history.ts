import type { Seat } from '../../core/classifier/types.js';
import type { MatchLog } from '../../core/log/read.js';
import type { HeaderLine } from '../../core/log/schema.js';
import type { ResultsIndex } from '../../core/replay/results-index.js';
import type { Exclusions } from '../../core/results/excluded.js';
import { parseMatchId } from '../../core/results/paths.js';
import { isValidLog } from '../../core/sched/validity.js';
import {
  formatInterval,
  formatMs,
  formatPercent,
  formatRecord,
  formatResult,
} from '../../core/stats/format.js';
import type { GameSummary } from '../../core/stats/summary.js';
import { rendererFor } from '../games/index.js';
import { committedExclusions, committedMatchIds, loadCommittedLog, resultsIndex } from '../logs.js';
import { gamePath, parseRoute, SANDBOX_GAMES } from '../route.js';
import { shortLabel } from './panel.js';
import { mountPlayer, showError, type Player } from './player.js';

/**
 * A game's page, `/<game>`: its match history beside (desktop) or under (phone) the player. Every
 * committed log in `results/<game>/matches/` is listed; `results/index.json` adds featured, valid
 * and the result, and logs it doesn't list are marked local and filled in as their logs load in
 * the background. A match on `results/excluded.json` shows an EXCLUDED badge with its reason as
 * the tooltip. `/<game>?match=<id>` picks and plays a match; picking a row pushes that URL, and
 * back/forward follow it. With no `?match`, the featured (or newest) match is picked but waits for
 * Play. A header above the list gives the game's summary (`results/<game>/summary.json`): the
 * head-to-head record, each player's accuracy and latency, and the featured match. The model
 * below is DOM-free (tests); `mountHistory` draws it.
 */

/** What the page needs to know about its game (from the registry). */
export interface HistoryGame {
  id: string;
  label: string;
  cadence: HeaderLine['cadence'];
  /** Player ids that are baselines here: `random` plus the game's own. */
  baselines: readonly string[];
  /**
   * Their labels by id (`gameBaselines`, the same ones the headers carry), shown for a log that
   * hasn't loaded yet.
   */
  baselineLabels: Readonly<Record<string, string>>;
  /** Every registered game id (match ids are split on them). */
  gameIds: readonly string[];
}

export interface MatchRow {
  id: string;
  game: string;
  /** `YYYY-MM-DD`, from the run's local clock. */
  date: string;
  /** `HH:MM:SS`, from the run's local clock. */
  time: string;
  players: [string, string];
  labels: [string, string];
  /** Not in `results/index.json`: a local run whose log isn't committed (or isn't indexed yet). */
  local: boolean;
  featured: boolean;
  /** Two different providers (no baseline on either seat). */
  headToHead: boolean;
  /**
   * Under the current validity rule (the index's `valid`, or recomputed from the log), not the
   * log's own `match_end.valid`. Null until known. False for an excluded match.
   */
  valid: boolean | null;
  /** Why the match was excluded by hand (`results/excluded.json`), or null. */
  excluded: string | null;
  /** Winning seat or 'draw'; null while unknown or when the match never finished. */
  winner: Seat | 'draw' | null;
  scores: [number, number] | null;
  /** Real-time: ticks. Turns: turns played. */
  totalTicks: number | null;
  cadence: HeaderLine['cadence'];
  /** Null until known; false when the run stopped before match_end. */
  finished: boolean | null;
  /** True once winner, scores and duration are known (from the index or the log). */
  loaded: boolean;
}

/** Provider names until a log's header gives the full label (baselines use the game's labels). */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  jev: 'Jev',
  openai: 'OpenAI Decisions',
};

/** A player's label before its log loads: the game's baseline label, a provider name, or the id. */
function labelBeforeLog(game: HistoryGame, player: string): string {
  const own = (names: Readonly<Record<string, string>>): string | undefined =>
    Object.hasOwn(names, player) ? names[player] : undefined;
  return own(game.baselineLabels) ?? own(PROVIDER_NAMES) ?? player;
}

function isHeadToHead(players: readonly [string, string], baselines: readonly string[]): boolean {
  return (
    players[0] !== players[1] && !baselines.includes(players[0]) && !baselines.includes(players[1])
  );
}

/**
 * Rows for every log id of `game.id`, newest first, featured pinned at the top. `excluded` is
 * `results/excluded.json`: those rows are invalid from the start and carry the reason. Required,
 * so no caller forgets it (NO_EXCLUSIONS where there is none).
 */
export function buildMatchList(
  game: HistoryGame,
  ids: readonly string[],
  index: ResultsIndex | null,
  excluded: Exclusions,
): MatchRow[] {
  const byId = new Map(
    (index?.matches ?? []).filter((m) => m.game === game.id).map((m) => [m.id, m]),
  );
  const rows = ids.map((id): MatchRow => {
    const parsed = parseMatchId(id, game.gameIds);
    const e = byId.get(id);
    const players = e?.players ?? parsed?.players ?? ['?', '?'];
    const reason = excluded.get(id) ?? null;
    const base: MatchRow = {
      id,
      game: game.id,
      date: parsed?.date ?? '',
      time: parsed?.time ?? '',
      players,
      labels: [labelBeforeLog(game, players[0]), labelBeforeLog(game, players[1])],
      local: e === undefined,
      featured: false,
      headToHead: isHeadToHead(players, game.baselines),
      valid: reason === null ? null : false,
      excluded: reason,
      winner: null,
      scores: null,
      totalTicks: null,
      cadence: game.cadence,
      finished: null,
      loaded: false,
    };
    if (e === undefined) return base;
    return {
      ...base,
      labels: e.labels,
      featured: e.featured,
      valid: reason === null ? e.valid : false,
      winner: e.winnerSeat ?? 'draw',
      scores: e.scores,
      totalTicks: e.totalTicks,
      finished: true,
      loaded: true,
    };
  });
  return rows.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * The row with what its log says: full labels, and the result once the log has a match_end.
 * Validity is recomputed from the log (`isValidLog`, with the exclusion list, required), as the
 * index does.
 */
export function withLog(
  row: MatchRow,
  log: MatchLog,
  baselines: readonly string[],
  excluded: Exclusions,
): MatchRow {
  const [a, b] = log.header.seats;
  const end = log.matchEnd;
  const players: [string, string] = [a.player, b.player];
  return {
    ...row,
    players,
    labels: [a.label, b.label],
    headToHead: isHeadToHead(players, baselines),
    cadence: log.header.cadence,
    valid: end === null ? row.valid : isValidLog(log, excluded),
    winner: end === null ? null : (end.winner ?? 'draw'),
    scores: end?.scores ?? null,
    totalTicks: end?.totalTicks ?? row.totalTicks,
    finished: end !== null,
    loaded: true,
  };
}

/**
 * The row's validity badge: `excluded` (its reason as the tooltip) for a match excluded by hand,
 * else `valid` or `invalid`; null while unknown. The CSS shows it in capitals.
 */
export function validityBadge(
  row: Pick<MatchRow, 'valid' | 'excluded'>,
): { text: string; kind: 'ok' | 'bad'; title: string | null } | null {
  if (row.excluded !== null) {
    return { text: 'excluded', kind: 'bad', title: `Excluded by hand: ${row.excluded}` };
  }
  if (row.valid === null) return null;
  return row.valid
    ? { text: 'valid', kind: 'ok', title: null }
    : { text: 'invalid', kind: 'bad', title: null };
}

export type MatchFilter = 'all' | 'h2h' | 'baselines';

export const FILTERS: readonly (readonly [MatchFilter, string])[] = [
  ['all', 'All'],
  ['h2h', 'Head to head'],
  ['baselines', 'Baselines'],
];

export function filterRows(rows: readonly MatchRow[], filter: MatchFilter): MatchRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => r.headToHead === (filter === 'h2h'));
}

/** Featured if any, else the newest (rows come sorted). */
export function defaultMatchId(rows: readonly MatchRow[]): string | null {
  return (rows.find((r) => r.featured) ?? rows[0])?.id ?? null;
}

/** Real-time ticks → `m:ss`; turns → `N turns`. */
export function formatDuration(ticks: number, cadence: HeaderLine['cadence']): string {
  if (cadence.kind === 'turns') return `${String(ticks)} turns`;
  const secs = Math.round(ticks / cadence.tickRate);
  return `${String(Math.floor(secs / 60))}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * "Jev wins 2–1", "Draw 2–2", "Jev wins on the tiebreak (33–33)", "Unfinished", or "…" while
 * unknown. Winner's score first (`formatResult`). The winner is named from the row's seat label,
 * shortened the way the panel's ticker shortens it (`shortLabel`: "Scripted bot" → "Scripted"),
 * so the list, the panel and the ticker agree.
 */
export function resultText(row: MatchRow): string {
  if (!row.loaded) return '…';
  if (row.finished === false || row.scores === null) return 'Unfinished';
  return formatResult(
    [shortLabel(row.labels[0]), shortLabel(row.labels[1])],
    row.winner,
    row.scores,
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 7, 17:41" from the log name (the run's local clock), or "" for an odd name. */
export function whenText(row: Pick<MatchRow, 'date' | 'time'>): string {
  if (row.date === '') return '';
  const [, m, d] = row.date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? '?'} ${String(d)}, ${row.time.slice(0, 5)}`;
}

/** A label without its trailing parenthetical: "Jev (TypeSafe)" → "Jev", "Always legit" as is. */
export function compactLabel(label: string): string {
  const short = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return short === '' ? label : short;
}

export interface SummaryPlayerView {
  label: string;
  /** Null for an ungraded game. */
  accuracy: string | null;
  p50: string;
  p95: string;
  matches: string;
}

export interface HistorySummaryView {
  /**
   * "Jev 31–3–16 OpenAI Decisions", or NO_PUBLISHED_H2H. It is about the published results
   * (summary.json), not the matches listed: a local head-to-head log isn't one yet.
   */
  headline: string;
  /** The win rate with its interval and match count; null without a head-to-head. */
  detail: string | null;
  graded: boolean;
  players: SummaryPlayerView[];
  /** The featured match: the summary's closest head-to-head, else the index's pick. */
  featured: { id: string; text: string } | null;
}

/** The headline before a game has published head-to-head results. */
export const NO_PUBLISHED_H2H = 'No published head-to-head results yet.';

/** The page header's summary from the game's summary.json and the listed rows. */
export function historySummaryView(
  summary: GameSummary | null,
  rows: readonly MatchRow[],
): HistorySummaryView {
  const h2h = summary?.pairings.find((p) => p.headToHead && p.matches > 0) ?? null;
  const x = h2h === null ? '' : compactLabel(h2h.labels[0]);
  const y = h2h === null ? '' : compactLabel(h2h.labels[1]);
  const players = (summary?.players ?? [])
    .filter((p) => p.matches > 0)
    .map((p): SummaryPlayerView => ({
      label: compactLabel(p.label),
      accuracy: summary?.graded === true ? formatPercent(p.accuracy) : null,
      p50: formatMs(p.latencyMs.p50),
      p95: formatMs(p.latencyMs.p95),
      matches: String(p.matches),
    }));
  let featured: HistorySummaryView['featured'] = null;
  const f = summary?.featured ?? null;
  if (f !== null) {
    const label = (player: string): string =>
      compactLabel(summary?.players.find((p) => p.player === player)?.label ?? player);
    const names = [label(f.players[0]), label(f.players[1])] as const;
    featured = {
      id: f.id,
      text:
        `Featured: ${names[0]} vs ${names[1]}, ${formatResult(names, f.winner, f.scores)}, ` +
        'the closest valid head-to-head',
    };
  } else {
    const row = rows.find((r) => r.featured);
    if (row !== undefined) {
      featured = {
        id: row.id,
        text: `Featured: ${compactLabel(row.labels[0])} vs ${compactLabel(row.labels[1])}`,
      };
    }
  }
  return {
    headline: h2h === null ? NO_PUBLISHED_H2H : `${x} ${formatRecord(h2h)} ${y}`,
    detail:
      h2h === null
        ? null
        : `${x} wins ${formatPercent(h2h.winRate.p)} (${formatInterval(h2h.winRate)}) of ` +
          `${String(h2h.matches)} valid head-to-head ${h2h.matches === 1 ? 'match' : 'matches'}` +
          (h2h.invalid > 0 ? `; ${String(h2h.invalid)} invalid not counted` : ''),
    graded: summary?.graded ?? false,
    players,
    featured,
  };
}

// ---------------------------------------------------------------------------------------------

function link(href: string, text: string, title: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.className = 'sandbox-link';
  a.textContent = text;
  a.title = title;
  return a;
}

function tag(text: string, kind: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `tag ${kind}`;
  s.textContent = text;
  return s;
}

/** The summary block under the title: record, a small per-player table, the featured match. */
function summaryBlock(
  view: HistorySummaryView,
  onFeatured: ((id: string) => void) | null,
): HTMLElement {
  const box = document.createElement('section');
  box.className = 'game-summary';
  box.setAttribute('aria-label', 'Summary');
  const headline = document.createElement('p');
  headline.className = 'summary-headline';
  headline.textContent = view.headline;
  box.append(headline);
  if (view.detail !== null) {
    const d = document.createElement('p');
    d.className = 'summary-detail';
    d.textContent = view.detail;
    box.append(d);
  }
  if (view.players.length > 0) {
    const t = document.createElement('table');
    t.className = 'summary-table';
    // Latency in the header ("p50 ms"), numbers alone in the cells: the sidebar is narrow.
    const head = ['Player', 'Matches', ...(view.graded ? ['Accuracy'] : []), 'p50 ms', 'p95 ms'];
    const hr = document.createElement('tr');
    for (const [i, h] of head.entries()) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      if (i > 0) th.className = 'num';
      hr.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const p of view.players) {
      const tr = document.createElement('tr');
      const ms = (x: string): string => x.replace(/ ms$/, '');
      const cells = [
        p.label,
        p.matches,
        ...(p.accuracy === null ? [] : [p.accuracy]),
        ms(p.p50),
        ms(p.p95),
      ];
      for (const [i, c] of cells.entries()) {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) {
          td.scope = 'row';
          const name = document.createElement('span');
          name.className = 'summary-name';
          name.textContent = c;
          name.title = c;
          td.append(name);
        } else {
          td.className = 'num';
          td.textContent = c;
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    box.append(t);
  }
  if (view.featured !== null) {
    const { id, text } = view.featured;
    const f = document.createElement(onFeatured === null ? 'p' : 'button');
    f.className = 'summary-featured';
    const star = document.createElement('span');
    star.className = 'star';
    star.textContent = '★ ';
    f.append(star, text);
    if (f instanceof HTMLButtonElement && onFeatured !== null) {
      f.type = 'button';
      f.addEventListener('click', () => {
        onFeatured(id);
      });
    }
    box.append(f);
  }
  return box;
}

export function mountHistory(
  root: HTMLElement,
  game: HistoryGame,
  initial: string | null,
  summary: GameSummary | null = null,
): void {
  root.innerHTML = '';
  root.classList.add('viewer-root');

  const renderer = rendererFor(game.id);
  const excluded = committedExclusions();
  let rows = buildMatchList(game, committedMatchIds(game.id), resultsIndex(), excluded);
  const logs = new Map<string, Promise<MatchLog>>();
  let filter: MatchFilter = 'all';
  let selected: string | null = null;
  let player: Player | null = null;
  /** Bumped on every pick so a slow load can't mount over a newer one. */
  let generation = 0;

  const shell = document.createElement('div');
  shell.className = 'viewer';
  const side = document.createElement('aside');
  side.className = 'picker';
  const main = document.createElement('main');
  main.className = 'player';
  shell.append(main, side);
  root.append(shell);

  const head = document.createElement('header');
  head.className = 'picker-head';
  const title = document.createElement('h1');
  title.textContent = game.label;
  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  const links = document.createElement('span');
  links.className = 'head-links';
  links.append(link('/', 'Leaderboard', 'The leaderboard and every game'));
  if (SANDBOX_GAMES.includes(game.id)) {
    links.append(
      link(`${gamePath(game.id)}?sandbox=1`, 'Sandbox', 'Play a human vs random bot sandbox'),
    );
  }
  if (import.meta.env.MODE !== 'web') {
    links.append(
      link('/live', 'Live', 'Run a match now, or play one of the models (needs pnpm live)'),
    );
  }
  titleRow.append(title, links);
  const sub = document.createElement('p');
  sub.className = 'sub';
  const tabs = document.createElement('div');
  tabs.className = 'filters';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Filter matches');
  const tabButtons = FILTERS.map(([value, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      filter = value;
      renderList();
    });
    tabs.append(b);
    return [value, b] as const;
  });
  const summaryView = historySummaryView(summary, rows);
  const featuredId = summaryView.featured?.id ?? null;
  const pick = (id: string): void => {
    if (id === selected) return;
    window.history.pushState(null, '', gamePath(game.id, id));
    select(id, true);
    // On a phone the player sits above the list: bring it back into view.
    if (main.getBoundingClientRect().top < 0) main.scrollIntoView({ block: 'start' });
  };
  const canPick = featuredId !== null && rows.some((r) => r.id === featuredId);
  head.append(titleRow, sub, summaryBlock(summaryView, canPick ? pick : null), tabs);
  const list = document.createElement('ul');
  list.className = 'matches';
  side.append(head, list);

  const loadLog = (id: string): Promise<MatchLog> => {
    let p = logs.get(id);
    if (p === undefined) {
      p = loadCommittedLog(game.id, id);
      logs.set(id, p);
      p.then(
        (log) => {
          rows = rows.map((r) => (r.id === id ? withLog(r, log, game.baselines, excluded) : r));
          renderList();
        },
        () => {},
      );
    }
    return p;
  };

  function rowItem(row: MatchRow): HTMLLIElement {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'match';
    if (row.id === selected) b.setAttribute('aria-current', 'true');
    b.title = row.id;

    const names = document.createElement('span');
    names.className = 'names';
    if (row.featured) {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '★';
      star.title = 'Featured';
      names.append(star);
    }
    const left = document.createElement('span');
    left.textContent = row.labels[0];
    const vs = document.createElement('span');
    vs.className = 'vs';
    vs.textContent = 'vs';
    const right = document.createElement('span');
    right.textContent = row.labels[1];
    names.append(left, vs, right);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const result = document.createElement('span');
    result.className = 'result';
    result.textContent = resultText(row);
    const parts = [whenText(row)];
    if (row.totalTicks !== null) parts.push(formatDuration(row.totalTicks, row.cadence));
    const when = document.createElement('span');
    when.textContent = parts.filter((p) => p !== '').join(' · ');
    meta.append(when, result);

    const tags = document.createElement('span');
    tags.className = 'tags';
    const badge = validityBadge(row);
    if (badge !== null) {
      const t = tag(badge.text, badge.kind);
      if (badge.title !== null) t.title = badge.title;
      tags.append(t);
    }
    if (row.local) tags.append(tag('local', 'local'));
    if (tags.childElementCount > 0) meta.append(tags);

    b.append(names, meta);
    b.addEventListener('click', () => {
      pick(row.id);
    });
    li.append(b);
    return li;
  }

  function renderList(): void {
    for (const [value, b] of tabButtons) b.setAttribute('aria-pressed', String(value === filter));
    const shown = filterRows(rows, filter);
    const local = rows.filter((r) => r.local).length;
    sub.textContent =
      `${String(rows.length)} replays` + (local > 0 ? ` · ${String(local)} local only` : '');
    list.replaceChildren(...shown.map(rowItem));
    if (shown.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matches here yet.';
      list.append(li);
    }
  }

  function select(id: string | null, autoplay: boolean): void {
    const gen = ++generation;
    selected = id;
    renderList();
    player?.destroy();
    player = null;
    main.replaceChildren();
    if (id === null) {
      showError(main, `No replays in results/${game.id}/matches yet.`);
      return;
    }
    if (!rows.some((r) => r.id === id)) {
      showError(main, `No ${game.label} match log "${id}".`);
      return;
    }
    if (renderer === null) {
      showError(main, `No renderer for ${game.label} yet.`);
      return;
    }
    const loading = document.createElement('p');
    loading.className = 'loading';
    loading.textContent = 'Loading replay…';
    main.append(loading);
    loadLog(id).then(
      (log) => {
        if (gen !== generation) return;
        main.replaceChildren();
        player = mountPlayer(main, log, renderer, { autoplay });
      },
      (e: unknown) => {
        if (gen !== generation) return;
        showError(main, e instanceof Error ? e.message : String(e));
      },
    );
  }

  const fromUrl = (): void => {
    const route = parseRoute(window.location.pathname, window.location.search, game.gameIds);
    if (route.mode !== 'history' || route.game !== game.id) {
      // Back to another page: let main.ts mount it.
      window.location.reload();
      return;
    }
    if (route.matchId === null) select(defaultMatchId(rows), false);
    else select(route.matchId, true);
  };
  window.addEventListener('popstate', fromUrl);
  if (initial === null) select(defaultMatchId(rows), false);
  else select(initial, true);

  // Fill in unindexed rows (winner, scores, duration, full labels) one log at a time.
  const pending = rows.filter((r) => !r.loaded).map((r) => r.id);
  const next = (): void => {
    const id = pending.shift();
    if (id === undefined) return;
    void loadLog(id).finally(() => window.setTimeout(next, 50));
  };
  window.setTimeout(next, 300);
}
