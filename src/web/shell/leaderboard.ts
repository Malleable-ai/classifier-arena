import {
  NONE,
  formatInterval,
  formatMs,
  formatPercent,
  formatRecord,
  formatUsd,
} from '../../core/stats/format.js';
import {
  OVERALL_FORMULA,
  leaderboardNotes,
  runCheckWarning,
  type Leaderboard,
} from '../../core/stats/leaderboard.js';
import { gamePath } from '../route.js';

/**
 * The leaderboard, `/` (docs/architecture/core.md, "Scores"): one row per model with the overall
 * score and each game's head-to-head win rate, a section per game (head to head, accuracy, refusal
 * rate, latency, cost, the baselines), the formula and the honesty notes. It reads
 * `results/leaderboard.json` (bundled by Vite through logs.ts), so it shows exactly what
 * `pnpm leaderboard` wrote. With no head-to-head yet it lists the games and their baselines and
 * says there are no published runs. The model below is DOM-free (tests); `mountLeaderboard` draws
 * it.
 */

export interface LeaderboardPageGame {
  id: string;
  label: string;
  /** Committed replays of this game. */
  replays: number;
  /** False when the web has no renderer for it yet (listed, not linked). */
  playable: boolean;
}

export interface LeaderboardPageData {
  /** `results/leaderboard.json`, or null when there is none yet. */
  leaderboard: Leaderboard | null;
  /** Every registered game, in registry order. */
  games: readonly LeaderboardPageGame[];
  /** Dev only (`/?fixture=1`): the numbers are a fake fixture. */
  fixture?: boolean;
}

export interface OverallCellView {
  /** "62.5%" or "—". */
  rate: string;
  /** "30.1–95.4% · n=50", or why there is no rate. */
  detail: string;
  /** The game failed its run-level miss check (the game's section says why). */
  warning: boolean;
}

export interface OverallRowView {
  label: string;
  overall: string;
  /** Which games are in the overall (all, or the ones with a head-to-head). */
  overallNote: string;
  cells: OverallCellView[];
}

export interface ModelRowView {
  label: string;
  winRate: string;
  interval: string;
  matches: string;
  accuracy: string;
  /** Decisions the model declined to answer ("0.4%"), or "—" with no decisions. */
  refusals: string;
  p50: string;
  p95: string;
  cost: string;
}

export interface BaselineRecordView {
  model: string;
  opponent: string;
  matches: string;
  record: string;
  winRate: string;
}

export interface BaselineView {
  label: string;
  matches: string;
  accuracy: string;
  p50: string;
  p95: string;
}

/** A match excluded by hand (`results/excluded.json`), as the game's section lists it. */
export interface ExcludedMatchView {
  id: string;
  reason: string;
  /** Its replay, or null when the game can't be played here yet. */
  href: string | null;
}

export interface GameSectionView {
  id: string;
  label: string;
  /** The game's history page, or null when it can't be played here yet. */
  href: string | null;
  replays: string;
  graded: boolean;
  status: string;
  /** The failed run-level miss check, or null. */
  warning: string | null;
  /** Matches excluded by hand, each with its reason (as leaderboard.md lists them). */
  excluded: ExcludedMatchView[];
  rows: ModelRowView[];
  baselineRecords: BaselineRecordView[];
  baselines: BaselineView[];
  /** The featured head-to-head's replay, or null. */
  featuredHref: string | null;
}

export interface LeaderboardView {
  /** True once any model has a head-to-head result. */
  published: boolean;
  fixture: boolean;
  /** Game labels, in order: the overall table's columns. */
  columns: string[];
  overall: OverallRowView[];
  sections: GameSectionView[];
  formula: string;
  notes: string[];
}

/** "3 replays", "1 replay", "no replays yet". */
export function replayCountText(n: number): string {
  if (n === 0) return 'no replays yet';
  return `${String(n)} ${n === 1 ? 'replay' : 'replays'}`;
}

export function leaderboardView(data: LeaderboardPageData): LeaderboardView {
  const lb = data.leaderboard;
  const models = lb?.models ?? [];
  const published = models.some((m) => m.overall !== null);
  const gameIndex = (id: string): number => lb?.games.findIndex((g) => g.id === id) ?? -1;

  const overall: OverallRowView[] = published
    ? models.map((m) => ({
        label: m.label,
        overall: formatPercent(m.overall),
        overallNote:
          m.overallGames.length === data.games.length
            ? `mean of ${String(m.overallGames.length)} games`
            : `mean of ${String(m.overallGames.length)} of ${String(data.games.length)} games`,
        cells: data.games.map((g): OverallCellView => {
          const i = gameIndex(g.id);
          const h = m.games[i]?.headToHead ?? null;
          const warning = runCheckWarning(lb?.games[i]?.runCheck ?? null) !== null;
          return h === null
            ? { rate: NONE, detail: 'no head-to-head yet', warning }
            : {
                rate: formatPercent(h.winRate.p),
                detail: `${formatInterval(h.winRate)} · n=${String(h.matches)}`,
                warning,
              };
        }),
      }))
    : [];

  const sections = data.games.map((g): GameSectionView => {
    const i = gameIndex(g.id);
    const info = lb?.games[i];
    const graded = info?.graded ?? false;
    const h2h = info?.matches.headToHead ?? 0;
    const rows = models
      .filter((m) => {
        const c = m.games[i];
        return c !== undefined && (c.headToHead !== null || c.decisions > 0);
      })
      .map((m): ModelRowView => {
        const c = m.games[i];
        const h = c?.headToHead ?? null;
        return {
          label: m.label,
          winRate: h === null ? NONE : formatPercent(h.winRate.p),
          interval: h === null ? NONE : formatInterval(h.winRate),
          matches: String(h?.matches ?? 0),
          accuracy: graded ? formatPercent(c?.accuracy ?? null) : 'not graded',
          refusals: formatPercent(c === undefined || c.decisions === 0 ? null : c.refusalRate),
          p50: formatMs(c?.latencyMs.p50 ?? null),
          p95: formatMs(c?.latencyMs.p95 ?? null),
          cost: formatUsd(c?.costPer1000 ?? null),
        };
      });
    const invalid = info?.matches.invalid ?? 0;
    return {
      id: g.id,
      label: g.label,
      href: g.playable ? gamePath(g.id) : null,
      replays: replayCountText(g.replays),
      graded,
      status:
        h2h === 0
          ? 'No published runs yet.'
          : `${String(h2h)} valid head-to-head ${h2h === 1 ? 'match' : 'matches'}` +
            (invalid > 0 ? ` · ${String(invalid)} invalid` : ''),
      warning: runCheckWarning(info?.runCheck ?? null),
      excluded: (info?.excluded ?? []).map((e) => ({
        id: e.id,
        reason: e.reason,
        href: g.playable ? gamePath(g.id, e.id) : null,
      })),
      rows,
      baselineRecords: (lb?.baselineRecords ?? [])
        .filter((r) => r.game === g.id)
        .map((r) => ({
          model: r.label,
          opponent: r.opponentLabel,
          matches: String(r.matches),
          record: formatRecord(r),
          winRate: formatPercent(r.winRate.p),
        })),
      baselines: (lb?.baselines ?? [])
        .filter((b) => b.game === g.id)
        .map((b) => ({
          label: b.label,
          matches: String(b.matches),
          accuracy: graded ? formatPercent(b.accuracy) : 'not graded',
          p50: formatMs(b.latencyMs.p50),
          p95: formatMs(b.latencyMs.p95),
        })),
      featuredHref:
        g.playable && info !== undefined && info.featured !== null
          ? gamePath(g.id, info.featured)
          : null,
    };
  });

  return {
    published,
    fixture: data.fixture === true,
    columns: data.games.map((g) => g.label),
    overall,
    sections,
    formula: lb?.formula ?? OVERALL_FORMULA,
    notes: leaderboardNotes({ runIds: lb?.runIds ?? [], games: lb?.games ?? [] }),
  };
}

// ---------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== undefined) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A table in a horizontally scrolling wrapper, so a wide table never widens the page. */
function table(
  caption: string,
  head: readonly string[],
  rows: readonly (readonly (string | Node)[])[],
  numericFrom = 1,
): HTMLDivElement {
  const wrap = el('div', 'table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', caption);
  const t = el('table', 'board-table');
  const thead = el('thead');
  const hr = el('tr');
  head.forEach((h, i) => {
    const th = el('th', i >= numericFrom ? 'num' : undefined, h);
    th.scope = 'col';
    hr.append(th);
  });
  thead.append(hr);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((c, i) => {
      const td = i === 0 ? el('th') : el('td', i >= numericFrom ? 'num' : undefined);
      if (i === 0) td.scope = 'row';
      td.append(c);
      tr.append(td);
    });
    tbody.append(tr);
  }
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

/** A big value over small detail lines ("52.2–77.6% · n=50" becomes two lines). */
function stacked(main: string, sub: string, mainClass = 'rate'): HTMLSpanElement {
  const s = el('span', 'stacked');
  s.append(el('span', mainClass, main));
  for (const line of sub.split(' · ')) s.append(el('span', 'detail', line));
  return s;
}

/** The warning sign plus text; the sign is decorative, the words say it. */
function warningLine(text: string, className: string): HTMLElement {
  const p = el('p', className);
  p.setAttribute('role', 'note');
  const sign = el('span', 'board-warning-sign', '⚠');
  sign.setAttribute('aria-hidden', 'true');
  p.append(sign, ` ${text}`);
  return p;
}

function overallSection(v: LeaderboardView): HTMLElement {
  const sec = el('section', 'board-card board-overall');
  sec.setAttribute('aria-labelledby', 'overall-h');
  const h = el('h2', undefined, 'Overall');
  h.id = 'overall-h';
  sec.append(h);
  if (!v.published) {
    sec.append(
      el(
        'p',
        'board-empty',
        'No published runs yet. The overall score appears once the models have played each ' +
          'other; until then each game below shows its baseline matches.',
      ),
    );
  } else {
    sec.append(
      table(
        'Overall scores',
        ['Model', 'Overall', ...v.columns],
        v.overall.map((r) => [
          r.label,
          stacked(r.overall, r.overallNote, 'rate overall'),
          ...r.cells.map((c) => {
            const cell = stacked(c.rate, c.detail);
            if (c.warning)
              cell.append(el('span', 'detail board-warning-detail', '⚠ miss check failed'));
            return cell;
          }),
        ]),
      ),
    );
  }
  const f = el('p', 'formula');
  f.append(el('strong', undefined, 'How the overall score works. '), v.formula);
  sec.append(f);
  return sec;
}

/** The matches excluded by hand, each with its reason; kept, not scored. */
function excludedList(s: GameSectionView): HTMLElement {
  const box = el('div', 'board-excluded');
  box.append(
    el('h3', undefined, 'Excluded by hand'),
    el(
      'p',
      'board-footnote',
      'Kept but not scored: an infrastructure failure the log can’t show (listed in ' +
        'results/excluded.json).',
    ),
  );
  const ul = el('ul');
  for (const e of s.excluded) {
    const li = el('li');
    const id = el('code', undefined, e.id);
    if (e.href === null) li.append(id);
    else {
      const a = el('a');
      a.href = e.href;
      a.append(id);
      li.append(a);
    }
    li.append(`: ${e.reason}`);
    ul.append(li);
  }
  box.append(ul);
  return box;
}

function gameSection(s: GameSectionView): HTMLElement {
  const art = el('article', 'board-card board-game');
  art.id = `game-${s.id}`;
  const head = el('header', 'board-game-head');
  const h = el('h2', undefined, s.label);
  head.append(h);
  if (s.href !== null) {
    const a = el('a', 'board-link', `${s.replays} →`);
    a.href = s.href;
    a.setAttribute('aria-label', `${s.label}: ${s.replays}`);
    head.append(a);
  } else {
    head.append(el('span', 'board-muted', s.replays));
  }
  art.append(head, el('p', 'board-status', s.status));
  if (s.warning !== null) art.append(warningLine(s.warning, 'board-warning'));
  if (s.excluded.length > 0) art.append(excludedList(s));

  if (s.rows.length > 0) {
    art.append(
      table(
        `${s.label}: models`,
        [
          'Model',
          'Head\u2011to\u2011head win rate',
          '95% interval',
          'Matches',
          'Accuracy',
          'Refusal rate',
          'p50',
          'p95',
          'Cost / 1,000 decisions',
        ],
        s.rows.map((r) => [
          r.label,
          r.winRate,
          r.interval,
          r.matches,
          r.accuracy,
          r.refusals,
          r.p50,
          r.p95,
          r.cost,
        ]),
      ),
    );
  }
  if (s.baselineRecords.length > 0) {
    art.append(el('h3', undefined, 'Against the baselines'));
    art.append(
      table(
        `${s.label}: models against the baselines`,
        ['Model', 'Opponent', 'Matches', 'Wins–draws–losses', 'Win rate'],
        s.baselineRecords.map((r) => [r.model, r.opponent, r.matches, r.record, r.winRate]),
        2,
      ),
    );
  }
  if (s.baselines.length > 0) {
    art.append(el('h3', undefined, 'Baselines'));
    art.append(
      table(
        `${s.label}: baselines`,
        ['Baseline', 'Matches', 'Accuracy', 'p50', 'p95'],
        s.baselines.map((b) => [b.label, b.matches, b.accuracy, b.p50, b.p95]),
      ),
      el(
        'p',
        'board-footnote',
        'Baselines answer after a fixed 200 ms delay, so their latency is not a measurement.',
      ),
    );
  }
  if (s.featuredHref !== null) {
    const a = el('a', 'board-featured', '★ Watch the featured match (the closest head-to-head)');
    a.href = s.featuredHref;
    art.append(a);
  }
  return art;
}

export function mountLeaderboard(root: HTMLElement, data: LeaderboardPageData): void {
  const v = leaderboardView(data);
  root.innerHTML = '';
  root.classList.add('board-root');

  const head = el('header', 'board-head');
  const titleRow = el('div', 'board-title');
  titleRow.append(el('h1', undefined, 'Classifier Arena'));
  if (import.meta.env.MODE !== 'web') {
    const live = el('a', 'sandbox-link', 'Live');
    live.href = '/live';
    live.title = 'Run a match now, or play one of the models (needs pnpm live)';
    titleRow.append(live);
  }
  const sub = el(
    'p',
    'board-sub',
    'Decision models play small browser games head to head. Both get the same state, prompt, ' +
      'options and option order, every decision is logged, and every match replays exactly.',
  );
  const nav = el('nav', 'board-nav');
  nav.setAttribute('aria-label', 'Games');
  for (const s of v.sections) {
    if (s.href === null) {
      nav.append(el('span', 'board-chip muted', `${s.label} · coming soon`));
      continue;
    }
    const a = el('a', 'board-chip', `${s.label} · ${s.replays}`);
    a.href = s.href;
    nav.append(a);
  }
  head.append(titleRow, sub, nav);
  if (v.fixture) {
    head.append(
      el('p', 'board-fixture', 'Fixture data (dev only): these numbers are fake, not results.'),
    );
  }

  const games = el('div', 'board-games');
  games.append(...v.sections.map(gameSection));

  const notes = el('section', 'board-card board-notes');
  notes.setAttribute('aria-labelledby', 'notes-h');
  const nh = el('h2', undefined, 'How to read this');
  nh.id = 'notes-h';
  const ul = el('ul');
  for (const n of v.notes) ul.append(el('li', undefined, n));
  notes.append(nh, ul);

  root.append(head, overallSection(v), games, notes);
}

/** `/<anything else>`. */
export function mountNotFound(root: HTMLElement, path: string): void {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.className = 'not-found';
  p.textContent = `Nothing at ${path}. `;
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = 'See the leaderboard';
  p.append(home);
  root.append(p);
}
