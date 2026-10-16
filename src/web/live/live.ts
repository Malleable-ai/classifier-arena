import {
  PROXY_URL,
  type EstimateResponse,
  type PlayersResponse,
} from '../../core/classifier/remote.js';
import type { Decider, Seat } from '../../core/classifier/types.js';
import { isRealtime, type Game } from '../../core/game.js';
import type { HeaderLine, LogLine, MatchEndLine, MatchLogSink } from '../../core/log/schema.js';
import { matchFile, matchIdFor } from '../../core/results/paths.js';
import { createRealtimeRunner } from '../../core/sched/realtime.js';
import { WarmupError, type MatchOptions } from '../../core/sched/shared.js';
import { createTurnRunner } from '../../core/sched/turns.js';
import { formatResult } from '../../core/stats/format.js';
import { realClock } from '../../core/util/clock.js';
import { GAMES } from '../../games/index.js';
import { installArenaDebug } from '../debug.js';
import {
  rendererFor,
  type FrameInfo,
  type GameRenderer,
  type HumanControls,
  type LiveFrames,
  type SeatPair,
} from '../games/index.js';
import { gamePath } from '../route.js';
import { frameBase, splitLines } from '../shell/frames.js';
import { panelHeaderOf, type PanelHeader } from '../shell/panel.js';
import { mountStageCanvas, type StageCanvas } from '../shell/stage.js';
import { playerColors } from '../shell/theme.js';
import {
  createEstimateCache,
  createRunLatch,
  defaultPicks,
  driveLiveRealtime,
  driveLiveTurns,
  estimatePath,
  liveDecider,
  liveGames,
  liveInvalidNote,
  matchErrorMessage,
  playerOptions,
  playersPath,
  startGate,
  tapSteps,
  type LiveDriveHooks,
  type LivePlayer,
} from './setup.js';

/**
 * `/live` (dev only): pick a game and two players, see the cost, play on the real clock. Real-time
 * games run on the core real-time runner, turn games on the turn runner, both in the browser.
 * Provider calls go through the local proxy (`pnpm live`), which holds the keys and writes the v2
 * log to `results/<game>/matches/`.
 */

const FLUSH_MS = 1000;
/** How often a real-time match loop runs, in ms. Independent of the frame rate (see below). */
const DRIVE_MS = 4;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

async function getJson<T>(path: string, timeoutMs = 2000): Promise<T> {
  const res = await fetch(`${PROXY_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `proxy ${String(res.status)}`);
  return body;
}

/** Buffers lines and POSTs them to the proxy in order (header first), every second and at the end. */
function createProxyLog(matchId: string): MatchLogSink & {
  lines: LogLine[];
  flush(): Promise<void>;
  error: string | null;
} {
  const lines: LogLine[] = [];
  let buffer: string[] = [];
  let chain = Promise.resolve();
  const sink = {
    lines,
    error: null as string | null,
    write(line: LogLine) {
      lines.push(line);
      buffer.push(JSON.stringify(line));
      if (line.type === 'header' || line.type === 'match_end') void sink.flush();
    },
    flush() {
      if (buffer.length === 0) return chain;
      const body = buffer.join('\n') + '\n';
      buffer = [];
      chain = chain.then(async () => {
        try {
          const res = await fetch(`${PROXY_URL}/log/${matchId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-ndjson' },
            body,
          });
          if (!res.ok) {
            const j = (await res.json()) as { error?: string };
            sink.error = `log not saved: ${j.error ?? String(res.status)}`;
          }
        } catch (err) {
          sink.error = `log not saved: ${err instanceof Error ? err.message : String(err)}`;
        }
      });
      return chain;
    },
  };
  return sink;
}

/** A match being played: what to draw now, and when it is over. */
interface Running {
  readonly state: unknown;
  readonly done: boolean;
  readonly result: MatchEndLine | null;
}

export async function mountLive(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.classList.add('live-root');
  const head = el('header', { className: 'live-head' });
  head.append(
    el('h1', { textContent: 'Live match' }),
    el('a', { href: '/', className: 'sandbox-link', textContent: 'Games' }),
  );
  root.append(head);

  const games = liveGames(GAMES, (id) => rendererFor(id) !== null);
  const gameById = (id: string): Game => {
    const g = GAMES.find((x) => x.id === id);
    if (!g) throw new Error(`unknown game ${id}`);
    return g;
  };
  const rendererOf = (id: string): GameRenderer => {
    const r = rendererFor(id);
    if (!r) throw new Error(`no renderer for ${id}`);
    return r;
  };
  const firstGame = games[0];
  if (firstGame === undefined) {
    root.append(el('p', { className: 'live-error', textContent: 'No playable games.' }));
    return;
  }

  let info: PlayersResponse;
  try {
    info = await getJson<PlayersResponse>(playersPath(firstGame.value));
  } catch {
    const msg = el('p', { className: 'live-error' });
    msg.setAttribute('role', 'alert');
    msg.innerHTML = 'Live mode needs <code>pnpm live</code> (runs a local proxy with your keys).';
    root.append(msg);
    return;
  }

  // Setup row: game, then the two players.
  const setup = el('div', { className: 'controls live-setup' });
  const gameSelect = el('select', { name: 'Game' });
  gameSelect.setAttribute('aria-label', 'Game');
  for (const g of games) gameSelect.append(el('option', { value: g.value, textContent: g.label }));
  gameSelect.value = firstGame.value;
  const mkSelect = (name: string): HTMLSelectElement => {
    const s = el('select', { name });
    s.setAttribute('aria-label', name);
    return s;
  };
  const left = mkSelect('Left player (P1)');
  const right = mkSelect('Right player (P2)');
  const start = el('button', { type: 'button', textContent: 'Start match', className: 'primary' });
  setup.append(gameSelect, left, el('span', { textContent: 'vs', className: 'vs' }), right, start);

  const gateMsg = el('p', { className: 'live-gate' });
  gateMsg.setAttribute('aria-live', 'polite');
  const estimatePre = el('pre', { className: 'live-estimate', hidden: true });
  const confirmLabel = el('label', { className: 'live-confirm', hidden: true });
  const confirm = el('input', { type: 'checkbox' });
  const confirmText = el('span');
  confirmLabel.append(confirm, confirmText);
  const status = el('p', { className: 'live-status' });
  status.setAttribute('aria-live', 'polite');
  const help = el('p', { className: 'live-help', hidden: true });
  const result = el('div', { className: 'controls live-result', hidden: true });
  const stageBox = el('div', { className: 'live-stage' });
  root.append(setup, gateMsg, estimatePre, confirmLabel, status, result, help, stageBox);

  let game: Game = gameById(firstGame.value);
  let renderer: GameRenderer = rendererOf(game.id);
  let players: LivePlayer[] = info.players;
  let stage: StageCanvas | null = null;

  const estimates = createEstimateCache((g, a, b) =>
    getJson<EstimateResponse>(estimatePath(g, a, b)),
  );
  /** Bumped on every pick: only the latest pick may write an error to the gate message. */
  let pickToken = 0;
  // Taken synchronously at the top of run(), released when the match ends or fails to start.
  const latch = createRunLatch();
  const approved = new Set<string>();
  const pairKey = (): string => `${game.id}:${[left.value, right.value].sort().join('+')}`;
  const byId = (id: string): LivePlayer => {
    const p = players.find((x) => x.id === id);
    if (!p) throw new Error(`unknown player ${id}`);
    return p;
  };

  /** A fresh canvas for the current game, showing a new match before anyone moves. */
  const resetStage = (): StageCanvas => {
    stageBox.replaceChildren();
    const s = mountStageCanvas(stageBox, renderer, game.label);
    stage = s;
    const state = game.create(1, game.defaultConfig);
    const frame = frameBase({
      frame: 0,
      tick: 0,
      state,
      labels: ['', ''],
      players: ['', ''],
      cadence: game.cadence,
      decisions: [],
      events: [],
    });
    s.draw(renderer.live?.().frame(frame) ?? frame, null);
    return s;
  };

  const fillPlayers = (): void => {
    const [a, b] = defaultPicks(players);
    for (const [s, initial] of [
      [left, a],
      [right, b],
    ] as const) {
      s.replaceChildren(
        ...playerOptions(players).map((o) =>
          el('option', { value: o.value, textContent: o.label, disabled: o.disabled }),
        ),
      );
      s.value = initial;
    }
  };

  const refresh = (): void => {
    const estimate = estimates.get(game.id, left.value, right.value);
    const gate = startGate(players, left.value, right.value, estimate, confirm.checked);
    gateMsg.textContent = gate.message;
    estimatePre.hidden = !gate.paid || estimate === null;
    estimatePre.textContent = estimate?.text ?? '';
    confirmLabel.hidden = !gate.needsConfirm;
    if (estimate)
      confirmText.textContent = ` I approve spending up to $${estimate.totalUsd.toFixed(2)}`;
    start.disabled = latch.busy || !gate.canStart;
  };

  const onPick = async (): Promise<void> => {
    const token = ++pickToken;
    const [g, a, b] = [game.id, left.value, right.value];
    confirm.checked = approved.has(pairKey());
    refresh();
    if (startGate(players, a, b, null, false).paid && estimates.get(g, a, b) === null) {
      try {
        await estimates.load(g, a, b);
      } catch (err) {
        if (token === pickToken) {
          gateMsg.textContent = `Could not get a cost estimate: ${err instanceof Error ? err.message : String(err)}`;
        }
        return;
      }
    }
    // refresh() reads the estimate for whatever is selected now, so a stale answer is harmless.
    refresh();
  };

  const onGame = async (): Promise<void> => {
    const id = gameSelect.value;
    const token = ++pickToken;
    let fresh: PlayersResponse;
    try {
      fresh = await getJson<PlayersResponse>(playersPath(id));
    } catch (err) {
      if (token === pickToken) {
        gateMsg.textContent = `Could not list players: ${err instanceof Error ? err.message : String(err)}`;
      }
      return;
    }
    if (token !== pickToken || gameSelect.value !== id) return;
    info = fresh;
    game = gameById(id);
    renderer = rendererOf(id);
    players = fresh.players;
    result.hidden = true;
    result.replaceChildren();
    status.textContent = '';
    fillPlayers();
    resetStage();
    await onPick();
  };

  gameSelect.addEventListener('change', () => void onGame());
  left.addEventListener('change', () => void onPick());
  right.addEventListener('change', () => void onPick());
  confirm.addEventListener('change', () => {
    if (confirm.checked) approved.add(pairKey());
    else approved.delete(pairKey());
    refresh();
  });

  const setPicking = (on: boolean): void => {
    gameSelect.disabled = !on;
    left.disabled = !on;
    right.disabled = !on;
  };

  const run = async (): Promise<void> => {
    // Synchronous guard: a double click, or Start during a rematch's estimate await, can't start a
    // second (paid) match.
    if (!latch.tryEnter()) return;
    const ids = [left.value, right.value] as const;
    const gate = startGate(
      players,
      ids[0],
      ids[1],
      estimates.get(game.id, ...ids),
      confirm.checked,
    );
    if (!gate.canStart) {
      latch.leave();
      return;
    }
    let matchId: string;
    try {
      // Throws for a player id the proxy would refuse in a log name: stop before any paid call.
      matchId = matchIdFor({ game: game.id, a: ids[0], b: ids[1], when: new Date(), run: 1 });
    } catch (err) {
      latch.leave();
      status.textContent = `Can't start: ${err instanceof Error ? err.message : String(err)}`;
      refresh();
      return;
    }
    refresh();
    setPicking(false);
    result.hidden = true;
    result.replaceChildren();
    const g = game;
    const r = renderer;
    const canvas = stage ?? resetStage();
    // A fresh match seed (not render state: the match is logged and replays from it).
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
    const humanSeat: Seat | null = ids[0] === 'human' ? 0 : ids[1] === 'human' ? 1 : null;
    const human: HumanControls<unknown> | null = humanSeat === null ? null : (r.human?.() ?? null);
    if (humanSeat !== null && human === null) {
      latch.leave();
      setPicking(true);
      status.textContent = `${g.label} has no keyboard controls.`;
      refresh();
      return;
    }
    help.textContent = human?.help ?? '';
    help.hidden = human === null;
    const detachKeys = human?.attach(window) ?? null;

    const decider = (seat: Seat): Decider =>
      liveDecider({
        id: ids[seat],
        seat,
        game: g,
        players,
        seed,
        matchId,
        clock: realClock,
        ...(human === null ? {} : { humanInput: human.input }),
      });
    const log = createProxyLog(matchId);
    const frames: LiveFrames<unknown, FrameInfo> | null = r.live?.() ?? null;
    const labels: SeatPair<string> = [byId(ids[0]).label, byId(ids[1]).label];
    let panel: PanelHeader = { labels, colors: playerColors(ids), cadence: g.cadence };
    const common: MatchOptions<unknown> = {
      seed,
      config: g.defaultConfig,
      matchId,
      seats: [byId(ids[0]).meta, byId(ids[1]).meta],
      deciders: [decider(0), decider(1)],
      clock: realClock,
      sink: log,
      gitCommit: info.gitCommit,
      runLocation: info.runLocation,
      runId: info.runId,
      startTime: () => new Date().toISOString(),
    };

    let running: Running & { start(): Promise<void> };
    let drive: (hooks: LiveDriveHooks) => void;
    if (isRealtime(g)) {
      const live = frames;
      const tapped =
        live?.onStep === undefined
          ? g
          : tapSteps(g, (before, inputs, after) => {
              live.onStep?.(before, inputs, after);
            });
      const runner = createRealtimeRunner({ ...common, game: tapped });
      running = runner;
      // The match runs on a ~4 ms timer, not on animation frames: a seat can send at most once per
      // `advance` call, so tying it to rAF caps decisions at the frame rate (an embedded or
      // throttled view ran rAF at 2 Hz). This matches the CLI's pacing. Drawing stays on rAF.
      drive = (hooks) => {
        driveLiveRealtime(runner, {
          ...hooks,
          now: () => realClock.now(),
          schedule: (fn) => window.setTimeout(fn, DRIVE_MS),
          beforeAdvance: () => {
            if (human !== null && humanSeat !== null) human.pump(runner.state, humanSeat);
          },
        });
      };
    } else {
      const runner = createTurnRunner({ ...common, game: g });
      running = runner;
      drive = (hooks) => {
        driveLiveTurns(runner, hooks);
      };
    }
    const tickOf = (state: unknown): number => (isRealtime(g) ? g.tick(state) : g.turn(state));

    const frameNow = (note?: string): FrameInfo => {
      const { decisions, events } = splitLines(log.lines);
      const t = tickOf(running.state);
      const base = frameBase({
        frame: t,
        tick: t,
        state: running.state,
        labels,
        players: ids,
        cadence: g.cadence,
        decisions,
        events,
        ...(note === undefined ? {} : { note }),
      });
      return frames?.frame(base) ?? base;
    };
    let note: string | undefined;
    const draw = (): void => {
      canvas.draw(frameNow(note), panel);
    };
    if (import.meta.env.DEV) {
      installArenaDebug({
        game: g.id,
        cadence: g.cadence.kind,
        frame: () => frameNow(note),
        hash: () => g.hash(running.state),
      });
    }

    const hasProvider = ids.some((id) => byId(id).kind === 'provider');
    status.textContent = hasProvider ? 'Warming up…' : 'Starting…';
    note = hasProvider ? 'WARMING UP' : undefined;
    draw();
    const stopEarly = (message: string): void => {
      detachKeys?.();
      latch.leave();
      setPicking(true);
      help.hidden = true;
      status.textContent = message;
      refresh();
    };
    try {
      await running.start();
    } catch (err) {
      stopEarly(
        err instanceof WarmupError
          ? `${err.message}. No match log written.`
          : `Could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    note = undefined;
    const headerLine = log.lines.find((l): l is HeaderLine => l.type === 'header');
    if (headerLine) panel = panelHeaderOf(headerLine);
    // start() wrote the header, which flushes at once. Make sure the proxy took it before the
    // match spends anything past warm-up: a log it refuses would mean paying for a match with no
    // record.
    await log.flush();
    if (log.error !== null) {
      stopEarly(`${log.error}. Stopped after warm-up; nothing more was spent.`);
      return;
    }
    status.textContent = `Playing · ${matchId}`;
    const flusher = window.setInterval(() => void log.flush(), FLUSH_MS);
    // Set when the runner throws (a game bug): the match stops, its requests in flight are
    // aborted, and the page says why and frees the latch instead of hanging.
    let failure = null as { error: unknown } | null;
    await new Promise<void>((resolve) => {
      let over = false;
      const frameFn = (): void => {
        if (over) return;
        if (human !== null && humanSeat !== null && !isRealtime(g)) {
          human.pump(running.state, humanSeat);
        }
        draw();
        requestAnimationFrame(frameFn);
      };
      const end = (): void => {
        over = true;
        resolve();
        draw();
      };
      drive({
        onDone: end,
        onError: (error) => {
          failure = { error };
          end();
        },
      });
      requestAnimationFrame(frameFn);
    });
    window.clearInterval(flusher);
    await log.flush();
    // A turn game's view can trail the match (each reveal is held its full time): keep drawing
    // until it has shown the last turn and the result. Display only; the log is already flushed.
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        draw();
        if (frames?.busy?.() === true) requestAnimationFrame(settle);
        else resolve();
      };
      settle();
    });
    detachKeys?.();
    latch.leave();
    setPicking(true);
    help.hidden = true;
    if (failure === null) {
      showResult(g, running.result, ids, matchId, log.error, log.lines);
    } else {
      status.textContent = matchErrorMessage(failure.error, log.error);
    }
    refresh();
  };

  const showResult = (
    g: Game,
    end: MatchEndLine | null,
    ids: readonly [string, string],
    matchId: string,
    logError: string | null,
    lines: readonly LogLine[],
  ): void => {
    if (!end) return;
    const names = [byId(ids[0]).label, byId(ids[1]).label] as const;
    const text = el('p', {
      textContent:
        `${formatResult(names, end.winner, end.scores)} · ` +
        `misses ${(end.missRates[0] * 100).toFixed(0)}% / ${(end.missRates[1] * 100).toFixed(0)}% · ` +
        (end.refusalRates === undefined
          ? ''
          : `refusals ${(end.refusalRates[0] * 100).toFixed(0)}% / ` +
            `${(end.refusalRates[1] * 100).toFixed(0)}% · `) +
        `$${end.costUsd.toFixed(4)}${liveInvalidNote(lines, end)}`,
    });
    status.textContent = logError ?? `Saved ${matchFile(g.id, matchId)}`;
    result.append(text);
    if (logError === null) {
      result.append(
        el('a', {
          href: gamePath(g.id, matchId),
          textContent: 'Watch replay',
          className: 'button',
        }),
      );
    }
    const rematch = el('button', { type: 'button', textContent: 'Rematch (swap sides)' });
    rematch.addEventListener('click', () => {
      if (latch.busy || rematch.disabled) return;
      rematch.disabled = true;
      const [a, b] = [right.value, left.value];
      left.value = a;
      right.value = b;
      void onPick().then(() => {
        const est = estimates.get(game.id, a, b);
        if (startGate(players, a, b, est, confirm.checked).canStart) void run();
        else rematch.disabled = false;
      });
    });
    result.append(rematch);
    result.hidden = false;
  };

  start.addEventListener('click', () => {
    start.blur();
    void run();
  });
  fillPlayers();
  resetStage();
  await onPick();
}
