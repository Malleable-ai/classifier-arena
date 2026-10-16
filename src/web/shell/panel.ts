import type { Seat } from '../../core/classifier/types.js';
import type { DecisionLine, HeaderLine } from '../../core/log/schema.js';
import { MATCH_OVER, isRefusal } from '../../core/sched/validity.js';
import type { InFlight, SeatPair } from '../games/index.js';
import { resolvedAt, type Cadence } from './frames.js';
import { font, hexA, NEUTRAL_COLORS, playerColors } from './theme.js';

/**
 * The decision panel under every game's stage: one panel per seat and a ticker of the latest
 * decisions. `panelModel` is a pure function of (decision lines, tick, header, option labels,
 * the requests in flight) and `drawPanel` draws that model, so replay, live, render mode and the
 * video all show the same thing. It knows no game: options are ids, labelled by the game's
 * renderer (`optionLabel`). Nothing here reads a clock: a flash fades by ticks, not by
 * milliseconds.
 *
 * A decision "happens" when its outcome is known (`resolvedAt` in frames.ts): real-time, its
 * `appliedTick`, or for one that never reached the game (timeout, error) the tick its answer
 * arrived; turns, once its turn is played. A request cancelled because the match ended
 * (`error: "matchOver"`) never had an answer: its cost counts, but the panel and ticker skip it,
 * so the last frame shows each seat's last real answer.
 *
 * What a seat's panel says:
 * - **Headline.** The big choice, its latency and its probabilities: the seat's latest decision,
 *   or, for a game with a `headline` filter, its latest decision that passes it. The fighter's
 *   filter keeps only moves the engine applied, so an answer dropped while the fighter was busy
 *   never replaces the move on screen; a newer answer the filter skips is the panel's `note`, a
 *   small muted line, and stays in the ticker.
 * - **Status.** Shown only when it isn't `ok` (timeout, error, refusal, dropped), in plain words:
 *   a game names its dropped answers (`droppedLabel`: the fighter's "busy", Inbox's "too late").
 * - **Verdict.** Graded games: a ✓ right / ✗ wrong badge on an `ok` answer, once its outcome is
 *   on screen: real-time, when it resolves; turns, once its turn is played (`playedTick`), so the
 *   panel never gives away a reveal the stage hasn't shown. (Clue Clash plays a turn at each
 *   step's score phase, the frame its stage marks the step ✓/✗ and pops "+1".)
 * - **Thinking.** While a seat has a request in flight on a new question (`inFlight`), its last
 *   answer belongs to the question before, so the panel clears it, says "thinking…" and shows the
 *   last answer under "Previous answer". Turn games: from the moment the turn's request is out
 *   until its answer is in `lines`; a timeline that holds a played turn on screen (Clue Clash's
 *   score phase and reveal) sets `inFlight` itself, so the next turn's request only shows once
 *   that turn is asked on screen. Real-time games ask all the time (a new message every few
 *   hundred ms), so the last answer stays up for THINKING_AFTER_TICKS after it lands, and only a
 *   slow request on a new question key turns the panel to "thinking…". A game that asks one key
 *   all match (the fighter's `next_move`) never shows it.
 */

/** Seconds of game time the decisions-per-second rate looks back over (real-time games). */
export const RATE_WINDOW_S = 5;
/** Ticks a panel stays highlighted after a new decision lands (fading out). Turns: one turn. */
export const FLASH_TICKS = 15;
/**
 * Real-time: ticks a seat's last answer stays up as current while its next request (on a new
 * question) is out. After that the panel says "thinking…" (0.5 s at 60 Hz, about twice a
 * typical answer's latency).
 */
export const THINKING_AFTER_TICKS = 30;
/** Entries in the bottom ticker. */
export const TICKER_MAX = 6;
/** Questions with up to this many options show every option's probability … */
export const ALL_OPTIONS_MAX = 6;
/** … larger ones show the top this many. */
export const TOP_OPTIONS = 5;

export type PanelStatus = 'ok' | 'dropped' | 'timeout' | 'refusal' | 'error';
/** A graded answer's outcome. */
export type Verdict = 'right' | 'wrong';

export interface PanelHeader {
  /** Each seat's plain-text label, e.g. 'Jev (TypeSafe)'. No logos (RULES.md). */
  labels: SeatPair<string>;
  /**
   * Each seat's color: its model's (Jev teal, OpenAI Decisions amber, whichever seat), else a
   * neutral one (theme.ts `playerColors`). Default: both neutral.
   */
  colors?: SeatPair<string>;
  cadence: Cadence;
  /** Warm-up spend counted into the running cost from the start (match_end's cost includes it). */
  warmupCostUsd?: SeatPair<number>;
}

export interface PanelOptions {
  /** The game's label for an option id. */
  optionLabel(id: string): string;
  /** Bars per decision; default `topProbabilityCount` of the options the API reported. */
  bars?: number;
  /**
   * Which decisions can be a seat's headline (GameRenderer.headline). Default: every one. A newer
   * decision it skips is the seat's `note`.
   */
  headline?: (d: DecisionLine) => boolean;
  /**
   * The game's plain word for a `dropped` answer (GameRenderer.droppedLabel): the fighter's
   * "busy", Inbox's "too late". Default "dropped".
   */
  droppedLabel?: (d: DecisionLine) => string;
}

/** What the frame says beyond its resolved lines (FrameInfo's `tick` and `inFlight`). */
export interface PanelFrame {
  /**
   * The frame's own tick: turns played, for a turn game whose timeline lands answers before their
   * turn is played. Verdicts show once their line resolves by it. Default: the panel's tick.
   */
  playedTick?: number;
  /** Each seat's request in flight (FrameInfo.inFlight). Absent: nothing in flight. */
  inFlight?: SeatPair<InFlight | null>;
}

export interface ProbabilityBar {
  id: string;
  label: string;
  p: number;
}

/** A newer answer than the headline that the game's `headline` filter skips (a dropped move). */
export interface PanelNote {
  choiceLabel: string | null;
  status: PanelStatus;
  /** The status in plain words (`statusWord`): 'busy', 'too late', 'timeout'. */
  statusText: string;
}

/** The answer a thinking seat gave to the question before. */
export interface PreviousAnswer {
  choiceLabel: string | null;
  status: PanelStatus;
  /** The status in plain words (`statusWord`). */
  statusText: string;
  verdict: Verdict | null;
}

export interface SeatPanel {
  seat: Seat;
  /** 'P1 · Jev (TypeSafe)'. */
  label: string;
  /** The player's color (PanelHeader.colors): its model's whichever seat it sits in. */
  color: string;
  /**
   * The latest decision's choice (option id); null before the first one, when it had none, or
   * while thinking.
   */
  choice: string | null;
  /** Its label (`optionLabel`), or null. */
  choiceLabel: string | null;
  /** The latest decision's status; null before the first one or while thinking. */
  status: PanelStatus | null;
  /** `status` in plain words (`statusWord`: the game's word for dropped); null with it. */
  statusText: string | null;
  /** Graded games: ✓/✗ of the latest `ok` answer once its outcome is on screen, else null. */
  verdict: Verdict | null;
  /** Null before the first decision or while thinking. */
  latencyMs: number | null;
  /**
   * Real-time: decisions resolved over the last RATE_WINDOW_S of game time (or since the start),
   * per second. Null for turn games.
   */
  perSecond: number | null;
  /** The latest decision's top API-reported probabilities, highest first; null when it had none. */
  bars: ProbabilityBar[] | null;
  costUsd: number;
  /** 1 when a decision lands, fading to 0 (FLASH_TICKS ticks, or one turn). */
  flash: number;
  /** A request is out on a new question: the answer fields above are cleared. */
  thinking: boolean;
  /** While thinking, the last answer (to the question before); else null. */
  previous: PreviousAnswer | null;
  /** The newest answer the headline filter skipped, if newer than the headline; else null. */
  note: PanelNote | null;
}

export interface TickerEntry {
  seat: Seat;
  /** The seat's player color (PanelHeader.colors). */
  color: string;
  /** The tick (or turn) it resolved. */
  at: number;
  choice: string | null;
  status: PanelStatus;
  /** `status` in plain words (`statusWord`). */
  statusText: string;
  /** As the panel's verdict: graded games, once the outcome is on screen. */
  verdict: Verdict | null;
  /** 'P1 Jev → sweep 172 ms'. */
  text: string;
}

export interface PanelModel {
  panels: SeatPair<SeatPanel>;
  /** Newest first. */
  ticker: TickerEntry[];
}

/** The panel header a log's header gives: labels, colors, cadence and warm-up spend. */
export function panelHeaderOf(header: HeaderLine): PanelHeader {
  const [a, b] = header.seats;
  return {
    labels: [a.label, b.label],
    colors: playerColors([a.player, b.player]),
    cadence: header.cadence,
    warmupCostUsd: [a.warmup?.costUsd ?? 0, b.warmup?.costUsd ?? 0],
  };
}

/** How many probabilities a question with `optionCount` options shows: all up to 6, else 5. */
export function topProbabilityCount(optionCount: number): number {
  return optionCount > ALL_OPTIONS_MAX ? TOP_OPTIONS : optionCount;
}

export function panelStatus(d: DecisionLine): PanelStatus {
  return isRefusal(d) ? 'refusal' : d.status;
}

/**
 * A decision's status in plain words: for a dropped answer the game's word for why
 * (`droppedLabel`: "busy", "too late"; default "dropped"), else the status's name.
 */
export function statusWord(d: DecisionLine, droppedLabel?: (d: DecisionLine) => string): string {
  const status = panelStatus(d);
  return status === 'dropped' ? (droppedLabel?.(d) ?? 'dropped') : status;
}

/** A request the match's end cancelled: billed, but never an answer (validity.ts). */
export function cancelledAtEnd(d: DecisionLine): boolean {
  return d.error === MATCH_OVER;
}

/** 'Jev (TypeSafe)' -> 'Jev', 'OpenAI Decisions (gpt-6-luna)' -> 'OpenAI'. */
export function shortLabel(label: string): string {
  return label.trim().split(/\s+/)[0] ?? label;
}

function topBars(d: DecisionLine, opts: PanelOptions): ProbabilityBar[] | null {
  const probs = d.probabilities;
  if (probs === null) return null;
  const bars = Object.entries(probs)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([id, p]) => ({ id, label: opts.optionLabel(id), p }));
  if (bars.length === 0) return null;
  const n = opts.bars ?? topProbabilityCount(bars.length);
  // Stable sort: equal probabilities keep the log's (option) order.
  return bars.sort((a, b) => b.p - a.p).slice(0, n);
}

/**
 * The panel at `tick`. `lines` must be in resolution order: pass the frame's `decisions`, which
 * `frameBase` has already resolved by tick and sorted once (log order breaks ties). Nothing is
 * sorted again here, so a frame costs one pass over its lines. `frame` adds the frame's own tick
 * (for verdicts) and the requests in flight (for "thinking…").
 */
export function panelModel(
  lines: readonly DecisionLine[],
  tick: number,
  header: PanelHeader,
  opts: PanelOptions,
  frame: PanelFrame = {},
): PanelModel {
  const realtime = header.cadence.kind === 'realtime';
  const rate = header.cadence.kind === 'realtime' ? header.cadence.tickRate : 0;
  const atOf = resolvedAt(header.cadence);
  const playedTick = frame.playedTick ?? tick;
  // Only what has happened by `tick`, in the order given (resolution order).
  const seen = lines.map((d) => ({ d, at: atOf(d) })).filter((e) => e.at <= tick);
  // Requests the match's end cancelled count for cost only.
  const shown = seen.filter((e) => !cancelledAtEnd(e.d));
  const verdictOf = (e: { d: DecisionLine; at: number }): Verdict | null => {
    const { d } = e;
    if (d.status !== 'ok' || typeof d.correct !== 'boolean' || e.at > playedTick) return null;
    return d.correct ? 'right' : 'wrong';
  };

  const windowTicks = realtime ? Math.min(RATE_WINDOW_S * rate, tick) : 0;
  const flashSpan = realtime ? FLASH_TICKS : 1;
  const headlineOk = opts.headline ?? (() => true);
  const word = (d: DecisionLine): string => statusWord(d, opts.droppedLabel);
  const colors = header.colors ?? NEUTRAL_COLORS;
  const panel = (seat: Seat): SeatPanel => {
    const mine = shown.filter((e) => e.d.seat === seat);
    const last = mine[mine.length - 1];
    // The headline: the latest decision the game's filter keeps (by default the latest).
    let head: (typeof mine)[number] | undefined;
    for (let i = mine.length - 1; i >= 0 && head === undefined; i--) {
      const e = mine[i];
      if (e !== undefined && headlineOk(e.d)) head = e;
    }
    const skipped = last !== undefined && last !== head ? last : undefined;
    const note: PanelNote | null =
      skipped === undefined
        ? null
        : {
            choiceLabel: skipped.d.choice === null ? null : opts.optionLabel(skipped.d.choice),
            status: panelStatus(skipped.d),
            statusText: word(skipped.d),
          };
    const inWindow = mine.filter((e) => e.at > tick - windowTicks).length;
    const cost = seen.reduce(
      (sum, e) => (e.d.seat === seat ? sum + e.d.costUsd : sum),
      header.warmupCostUsd?.[seat] ?? 0,
    );
    const out = frame.inFlight?.[seat] ?? null;
    // A request whose line is already shown (a turn game landing it early) has been answered.
    const answered = out !== null && seen.some((e) => e.d.seat === seat && e.d.seq === out.seq);
    const thinking =
      out !== null &&
      !answered &&
      (!realtime ||
        last === undefined ||
        (last.d.questionKey !== out.questionKey && tick - last.at >= THINKING_AFTER_TICKS));
    const common = {
      seat,
      label: `P${String(seat + 1)} · ${header.labels[seat]}`,
      color: colors[seat],
      perSecond: !realtime ? null : windowTicks > 0 ? inWindow / (windowTicks / rate) : 0,
      costUsd: cost,
      flash: head === undefined ? 0 : Math.max(0, 1 - (tick - head.at) / flashSpan),
    };
    if (thinking) {
      return {
        ...common,
        choice: null,
        choiceLabel: null,
        status: null,
        statusText: null,
        verdict: null,
        latencyMs: null,
        bars: null,
        thinking: true,
        previous:
          head === undefined
            ? null
            : {
                choiceLabel: head.d.choice === null ? null : opts.optionLabel(head.d.choice),
                status: panelStatus(head.d),
                statusText: word(head.d),
                verdict: verdictOf(head),
              },
        note,
      };
    }
    const choice = head?.d.choice ?? null;
    return {
      ...common,
      choice,
      choiceLabel: choice === null ? null : opts.optionLabel(choice),
      status: head === undefined ? null : panelStatus(head.d),
      statusText: head === undefined ? null : word(head.d),
      verdict: head === undefined ? null : verdictOf(head),
      latencyMs: head?.d.latencyMs ?? null,
      bars: head === undefined ? null : topBars(head.d, opts),
      thinking: false,
      previous: null,
      note,
    };
  };

  const ticker = shown
    .slice(-TICKER_MAX)
    .reverse()
    .map((e): TickerEntry => {
      const { d, at } = e;
      const status = panelStatus(d);
      const what = d.choice !== null ? opts.optionLabel(d.choice) : word(d);
      const who = `P${String(d.seat + 1)} ${shortLabel(header.labels[d.seat])}`;
      return {
        seat: d.seat,
        color: colors[d.seat],
        at,
        choice: d.choice,
        status,
        statusText: word(d),
        verdict: verdictOf(e),
        text: `${who} → ${what} ${String(Math.round(d.latencyMs))} ms`,
      };
    });

  return { panels: [panel(0), panel(1)], ticker };
}

// ---------------------------------------------------------------------------------------------
// Drawing. Fixed logical sizes (not scaled by screen size): the smallest text is ~44 logical px,
// about 9-10 CSS px when the 1920-wide canvas is shown 390 px wide on a phone.

/** Logical height of the panel area under the stage. */
export const PANELS_H = 680;

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const STATUS_COLOR: Record<PanelStatus, string> = {
  ok: '#86efac',
  dropped: '#94a3b8',
  timeout: '#fca5a5',
  refusal: '#f0abfc',
  error: '#f87171',
};

/**
 * The verdict badge: a solid fill with a white mark and word, so it reads on any background (the
 * seat's tinted panel, a light page) and without colour (✓ vs ✗, RIGHT vs WRONG). White on these
 * fills is at least 5:1.
 */
const VERDICT_STYLE: Record<Verdict, { fill: string; edge: string; word: string }> = {
  right: { fill: '#15803d', edge: '#4ade80', word: 'RIGHT' },
  wrong: { fill: '#b91c1c', edge: '#f87171', word: 'WRONG' },
};

const GUTTER = 24;
const PAD = 28;
const PANEL_H = 476;
const BAR_ROW_H = 52;
/** The badge beside the big choice. */
const BIG_BADGE_H = 60;
const MUTED_BIG = 'rgba(255,255,255,0.5)';

/** Shrink `text` with an ellipsis until it fits `maxW` at the current font. */
export function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Set the largest font from `maxPx` down to `minPx` that fits `text` in `maxW`, then `fit` it. */
export function fitShrink(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxPx: number,
  minPx: number,
  weight: number,
): { text: string; px: number } {
  let px = maxPx;
  ctx.font = font(px, weight);
  while (px > minPx && ctx.measureText(text).width > maxW) {
    px = Math.max(minPx, px - 2);
    ctx.font = font(px, weight);
  }
  return { text: fit(ctx, text, maxW), px };
}

/** A check mark (paths, no glyph font) centred on (cx, cy), size s. */
function checkMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.lineWidth = s * 0.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.42, cy + s * 0.02);
  ctx.lineTo(cx - s * 0.12, cy + s * 0.32);
  ctx.lineTo(cx + s * 0.44, cy - s * 0.32);
  ctx.stroke();
}

/** A cross centred on (cx, cy), size s. */
function crossMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const r = s * 0.32;
  ctx.lineWidth = s * 0.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
}

export type Badge =
  { kind: 'verdict'; verdict: Verdict } | { kind: 'status'; status: PanelStatus; text: string };

/**
 * A non-ok status (in plain words, `text`: "busy", "too late"; default its name), else a graded
 * answer's verdict, else nothing (an `ok` is not news).
 */
export function badgeOf(
  status: PanelStatus | null,
  verdict: Verdict | null,
  text: string | null = status,
): Badge | null {
  if (status === null) return null;
  if (status !== 'ok') return { kind: 'status', status, text: text ?? status };
  return verdict === null ? null : { kind: 'verdict', verdict };
}

function badgeText(b: Badge): string {
  return b.kind === 'status' ? b.text.toUpperCase() : VERDICT_STYLE[b.verdict].word;
}

/** The badge's width at height `h` (sets the font). */
export function badgeWidth(ctx: CanvasRenderingContext2D, b: Badge, h: number): number {
  const px = Math.round(h * (b.kind === 'status' ? 0.667 : 0.62));
  ctx.font = font(px, b.kind === 'status' ? 700 : 800);
  const text = ctx.measureText(badgeText(b)).width;
  return b.kind === 'status' ? text + h * 0.6 : text + h * 1.45;
}

/** Draws a badge with its top-left at (x, y), `h` tall. Returns its width. */
export function drawBadge(
  ctx: CanvasRenderingContext2D,
  b: Badge,
  x: number,
  y: number,
  h: number,
): number {
  const w = badgeWidth(ctx, b, h);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (b.kind === 'status') {
    const c = STATUS_COLOR[b.status];
    ctx.fillStyle = hexA(c, 0.18);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = c;
    ctx.stroke();
    ctx.fillStyle = c;
    ctx.fillText(badgeText(b), x + h * 0.3, y + h / 2 + 1);
  } else {
    const st = VERDICT_STYLE[b.verdict];
    ctx.fillStyle = st.fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = st.edge;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    const mx = x + h * 0.55;
    if (b.verdict === 'right') checkMark(ctx, mx, y + h / 2, h * 0.56);
    else crossMark(ctx, mx, y + h / 2, h * 0.56);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(st.word, x + h * 1.0, y + h / 2 + 1);
  }
  ctx.restore();
  return w;
}

/** A small round ✓/✗ for the ticker, centred on (cx, cy), diameter d. */
export function drawVerdictDot(
  ctx: CanvasRenderingContext2D,
  v: Verdict,
  cx: number,
  cy: number,
  d: number,
): void {
  const st = VERDICT_STYLE[v];
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = st.fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = st.edge;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  if (v === 'right') checkMark(ctx, cx, cy, d * 0.62);
  else crossMark(ctx, cx, cy, d * 0.62);
  ctx.restore();
}

function emptyPanel(seat: Seat): SeatPanel {
  return {
    seat,
    label: `P${String(seat + 1)}`,
    color: NEUTRAL_COLORS[seat],
    choice: null,
    choiceLabel: null,
    status: null,
    statusText: null,
    verdict: null,
    latencyMs: null,
    perSecond: 0,
    bars: null,
    costUsd: 0,
    flash: 0,
    thinking: false,
    previous: null,
    note: null,
  };
}

/**
 * A panel note's text, longest first: a dropped answer as 'skipped (busy): throw' (the game's word
 * for why), then 'busy: throw' where that won't fit; any other status as 'timeout: throw'; just
 * the status ('refusal') without a choice.
 */
export function noteTexts(n: PanelNote): string[] {
  if (n.choiceLabel === null) return [n.statusText];
  const short = `${n.statusText}: ${n.choiceLabel}`;
  return n.status === 'dropped' ? [`skipped (${n.statusText}): ${n.choiceLabel}`, short] : [short];
}

/** A panel note's full text (`noteTexts`' first). */
export function noteText(n: PanelNote): string {
  return noteTexts(n)[0] ?? n.statusText;
}

/** The running cost in the viewer's panel, labelled so it doesn't read as a per-answer price. */
export function matchCostText(costUsd: number): string {
  return `match cost $${costUsd.toFixed(4)}`;
}

function drawSeatPanel(ctx: CanvasRenderingContext2D, p: SeatPanel, a: Area): void {
  const color = p.color;
  const flash = p.flash;
  ctx.beginPath();
  ctx.roundRect(a.x, a.y, a.w, a.h, 18);
  ctx.fillStyle = hexA(color, 0.07 + 0.2 * flash);
  ctx.fill();
  ctx.lineWidth = 4 + 4 * flash;
  ctx.strokeStyle = hexA(color, 0.35 + 0.65 * flash);
  ctx.stroke();

  const x = a.x + PAD;
  const innerW = a.w - 2 * PAD;
  let y = a.y + 20;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Player label.
  ctx.font = font(46);
  ctx.fillStyle = color;
  ctx.fillText(fit(ctx, p.label, innerW), x, y);
  y += 60;

  // Latest choice, large, with its badge (a non-ok status, or a graded answer's verdict).
  const dim = p.status === 'dropped';
  const big = p.thinking
    ? 'thinking…'
    : p.status === null
      ? 'waiting…'
      : (p.choiceLabel ?? 'no answer');
  ctx.fillStyle = p.thinking || p.status === null ? MUTED_BIG : dim ? '#cbd5e1' : '#ffffff';
  const badge = p.thinking ? null : badgeOf(p.status, p.verdict, p.statusText);
  const chipW = badge === null ? 0 : badgeWidth(ctx, badge, BIG_BADGE_H) + 24;
  // Shrink the choice (down to 64 px) before cutting it, so "WALK FORWARD" stays whole.
  const { text: bigText, px: bigPx } = fitShrink(
    ctx,
    big.toUpperCase(),
    innerW - chipW,
    96,
    64,
    800,
  );
  ctx.fillText(bigText, x, y + (96 - bigPx) * 0.7);
  if (badge !== null) {
    const bw = ctx.measureText(bigText).width;
    drawBadge(ctx, badge, x + bw + 24, y + 22, BIG_BADGE_H);
  }
  y += 112;

  // Latency · rate (real-time games) · the match's cost so far, labelled as such.
  const latency = p.latencyMs === null ? '— ms' : `${String(Math.round(p.latencyMs))} ms`;
  const rate = p.perSecond === null ? [] : [`${p.perSecond.toFixed(1)}/s`];
  const stats = [latency, ...rate, matchCostText(p.costUsd)].join('  ·  ');
  ctx.fillStyle = '#e2e8f0';
  const statsFit = fitShrink(ctx, stats, innerW, 50, 40, 600);
  ctx.fillText(statsFit.text, x, y + (50 - statsFit.px) * 0.7);
  // A newer answer the headline skipped (the fighter's dropped moves), small and muted, right of
  // the stats when it fits there (the ticker lists it either way).
  if (p.note !== null) {
    const room = innerW - ctx.measureText(stats).width - 32;
    const texts = noteTexts(p.note);
    let nt = fitShrink(ctx, texts[0] ?? '', room, 40, 32, 600);
    for (const t of texts.slice(1)) {
      if (!nt.text.endsWith('…')) break;
      nt = fitShrink(ctx, t, room, 40, 32, 600);
    }
    if (ctx.measureText(nt.text).width <= room && !nt.text.endsWith('…')) {
      ctx.fillStyle = 'rgba(203, 213, 225, 0.55)';
      ctx.textAlign = 'right';
      ctx.fillText(nt.text, x + innerW, y + (50 - nt.px) * 0.7);
      ctx.textAlign = 'left';
    }
  }
  y += 66;

  // Thinking: the answer to the question before, labelled as such, instead of the bars.
  if (p.thinking) {
    if (p.previous === null) return;
    ctx.font = font(42, 600);
    ctx.fillStyle = 'rgba(226,232,240,0.66)';
    ctx.fillText('Previous answer', x, y);
    y += 58;
    const prevBadge = badgeOf(p.previous.status, p.previous.verdict, p.previous.statusText);
    const prevBadgeH = 50;
    const prevChipW = prevBadge === null ? 0 : badgeWidth(ctx, prevBadge, prevBadgeH) + 20;
    const prev = fitShrink(
      ctx,
      (p.previous.choiceLabel ?? 'no answer').toUpperCase(),
      innerW - prevChipW,
      54,
      40,
      800,
    );
    ctx.fillStyle = 'rgba(226,232,240,0.78)';
    ctx.fillText(prev.text, x, y + (54 - prev.px) * 0.7);
    if (prevBadge !== null) {
      const pw = ctx.measureText(prev.text).width;
      drawBadge(ctx, prevBadge, x + pw + 20, y + 2, prevBadgeH);
    }
    return;
  }

  // Top probabilities.
  ctx.font = font(42, 600);
  ctx.fillStyle = 'rgba(226,232,240,0.66)';
  ctx.fillText('API-reported probabilities', x, y);
  y += 52;
  if (p.bars === null) {
    ctx.font = font(46, 600);
    ctx.fillStyle = 'rgba(226,232,240,0.5)';
    ctx.fillText('n/a', x, y + 4);
    return;
  }
  // Three bars fill the space at full size; more get shorter rows.
  const rowH = Math.min(BAR_ROW_H, Math.floor((a.y + a.h - y - 10) / p.bars.length));
  const textPx = Math.min(44, Math.round(rowH * 0.85));
  const labelW = 300;
  // Room for "100%" at full size plus a gap, so the number never touches its bar.
  const pctW = 140;
  const trackX = x + labelW;
  const trackW = innerW - labelW - pctW;
  const inset = Math.round(rowH * (10 / BAR_ROW_H));
  for (const [i, bar] of p.bars.entries()) {
    const ry = y + i * rowH;
    const chosen = bar.id === p.choice;
    ctx.font = font(textPx, chosen ? 700 : 500);
    ctx.fillStyle = chosen ? '#ffffff' : 'rgba(226,232,240,0.8)';
    ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, bar.label, labelW - 16), x, ry + rowH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(trackX, ry + inset, trackW, rowH - 2 * inset);
    ctx.fillStyle = hexA(color, chosen ? 1 : 0.55);
    ctx.fillRect(trackX, ry + inset, trackW * Math.max(0, Math.min(1, bar.p)), rowH - 2 * inset);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`${String(Math.round(bar.p * 100))}%`, x + innerW, ry + rowH / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }
}

/** Diameter of a ticker entry's ✓/✗, and the room it takes after the text. */
const TICKER_DOT = 38;
const TICKER_DOT_ROOM = TICKER_DOT + 16;

function drawTicker(ctx: CanvasRenderingContext2D, ticker: readonly TickerEntry[], a: Area): void {
  const cols = 2;
  const rows = Math.ceil(TICKER_MAX / cols);
  const colW = (a.w - GUTTER * (cols + 1)) / cols;
  const rowH = a.h / rows;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const [i, e] of ticker.entries()) {
    // Column-major, newest first: the left column is the three most recent.
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = a.x + GUTTER + col * (colW + GUTTER) + 8;
    const cy = a.y + row * rowH + rowH / 2;
    const faded = e.status === 'dropped';
    ctx.globalAlpha = faded ? 0.5 : 1;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(x + 10, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    const suffix = e.status === 'ok' || e.choice === null ? '' : ` · ${e.statusText}`;
    const room = e.verdict === null ? 0 : TICKER_DOT_ROOM;
    const shown = fitShrink(ctx, e.text + suffix, colW - 40 - room, 46, 36, i === 0 ? 700 : 600);
    ctx.fillText(shown.text, x + 32, cy + 2);
    if (faded) {
      // Strike through dropped entries so they read as "not used" without color alone.
      const w = Math.min(ctx.measureText(e.text).width, colW - 40);
      ctx.fillRect(x + 32, cy + 2, w, 3);
    }
    if (e.verdict !== null) {
      const tw = ctx.measureText(shown.text).width;
      drawVerdictDot(ctx, e.verdict, x + 32 + tw + 12 + TICKER_DOT / 2, cy + 1, TICKER_DOT);
    }
    ctx.globalAlpha = 1;
  }
}

/** Draws the panels and ticker into `area` (logical px). `model` null: neutral empty panels. */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  model: PanelModel | null,
  area: Area,
): void {
  ctx.save();
  ctx.fillStyle = '#090a14';
  ctx.fillRect(area.x, area.y, area.w, area.h);
  ctx.fillStyle = 'rgba(143, 131, 168, 0.5)';
  ctx.fillRect(area.x, area.y, area.w, 3);

  const panels = model?.panels ?? [emptyPanel(0), emptyPanel(1)];
  const pw = (area.w - 3 * GUTTER) / 2;
  const top = area.y + 20;
  for (const seat of [0, 1] as const) {
    drawSeatPanel(ctx, panels[seat], {
      x: area.x + GUTTER + seat * (pw + GUTTER),
      y: top,
      w: pw,
      h: PANEL_H,
    });
  }
  const tickerTop = top + PANEL_H + 8;
  drawTicker(ctx, model?.ticker ?? [], {
    x: area.x,
    y: tickerTop,
    w: area.w,
    h: area.y + area.h - tickerTop - 8,
  });
  ctx.restore();
}
