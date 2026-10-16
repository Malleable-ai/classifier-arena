import type { Seat } from '../../../core/classifier/types.js';
import type { DecisionLine, EventLine } from '../../../core/log/schema.js';
import { inboxResult } from '../../../games/inbox/engine/sim.js';
import {
  OUTCOME,
  type InboxLabel,
  type InboxState,
  type StreamItem,
} from '../../../games/inbox/engine/types.js';
import { secondsToLand } from '../../../games/inbox/view.js';
import type { SeatPair } from '../index.js';

/**
 * Inbox Invaders' stage, as pure functions of (state, resolved decision lines, events, tick): the
 * layout, which cards each lane shows and how far along their animations are, the health pulses,
 * the clock and the game-over banner. draw.ts paints this; nothing here touches a canvas, so the
 * tests check the numbers. Every animation is a function of ticks, never of wall time.
 */

export const TICK_RATE = 60;

// ---------------------------------------------------------------------------------------------
// Layout (logical px of the 1920×1080 stage; the shared panel is drawn under it).

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lanes: seat 0 on the left, seat 1 on the right, under the header band. */
export const LANE_TOP = 170;
export const LANE_BOTTOM = 1066;
export const LANE_W = 900;
export const LANE_X: SeatPair<number> = [36, STAGE_W - 36 - LANE_W];

/** The inbox bar at the bottom of each lane. */
export const INBOX_H = 92;
export const INBOX_PAD = 16;

/** Cards: one fixed size, so a pile-up stacks neatly (each card's header row peeks out). */
export const CARD_INSET = 30;
export const CARD_W = LANE_W - 2 * CARD_INSET;
export const CARD_PAD_X = 30;
export const CARD_PAD_TOP = 16;
export const CARD_HEAD_H = 50;
export const CARD_TEXT_GAP = 10;
export const CARD_LINE_H = 54;
export const CARD_LINES = 4;
export const CARD_PAD_BOTTOM = 16;
export const CARD_H =
  CARD_PAD_TOP + CARD_HEAD_H + CARD_TEXT_GAP + CARD_LINES * CARD_LINE_H + CARD_PAD_BOTTOM;
/** Text width inside a card. */
export const CARD_TEXT_W = CARD_W - 2 * CARD_PAD_X;

export function laneRect(seat: Seat): Rect {
  return { x: LANE_X[seat], y: LANE_TOP, w: LANE_W, h: LANE_BOTTOM - LANE_TOP };
}

export function inboxRect(seat: Seat): Rect {
  return {
    x: LANE_X[seat] + INBOX_PAD,
    y: LANE_BOTTOM - INBOX_PAD - INBOX_H,
    w: LANE_W - 2 * INBOX_PAD,
    h: INBOX_H,
  };
}

/** A card's top edge at spawn (progress 0) … */
export const CARD_TOP_START = LANE_TOP + 18;
/** … and when it lands (progress 1): its bottom edge just above the inbox bar. */
export const CARD_TOP_LAND = LANE_BOTTOM - INBOX_PAD - INBOX_H - 12 - CARD_H;

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** How far a message has fallen at `tick`: 0 at its spawn, 1 when it lands. */
export function fallProgress(item: Pick<StreamItem, 'spawnTick' | 'landTick'>, tick: number) {
  const span = item.landTick - item.spawnTick;
  return span <= 0 ? 1 : clamp01((tick - item.spawnTick) / span);
}

/** The card's top edge for a fall progress. */
export function cardTop(progress: number): number {
  return CARD_TOP_START + clamp01(progress) * (CARD_TOP_LAND - CARD_TOP_START);
}

// ---------------------------------------------------------------------------------------------
// Animation timing (ticks at 60 Hz).

/** A new card drops in over this many ticks … */
export const ENTER_TICKS = 8;
/** … from this far above its place. */
export const ENTER_DROP_PX = 48;
/** An answered card flashes … */
export const FLASH_TICKS = 6;
/** … holds in place with its verdict … */
export const RESOLVE_HOLD = 12;
/** … then swipes out of the lane and fades over 0.4 s. */
export const FADE_TICKS = 24;
export const RESOLVE_TICKS = RESOLVE_HOLD + FADE_TICKS;
/** A landed card turns grey and shakes … */
export const LAND_HOLD = 18;
export const LAND_TICKS = LAND_HOLD + FADE_TICKS;
/** The health meter pulses after a hit. */
export const PULSE_TICKS = 30;
/** How far a resolved card swipes (logical px) by the end of its fade. */
export const SWIPE_PX = 420;
/** How far a landed card sinks into the inbox by the end of its fade. */
export const SINK_PX = 70;

// ---------------------------------------------------------------------------------------------
// Cards.

/** A seat's answer to one message, from its decision line. */
export interface Resolution {
  /**
   * The first frame that shows it: `appliedTick + 1`, the state after the step the answer was fed
   * to (as `Hit.tick`), so the verdict and a wrong answer's damage appear on the same frame.
   */
  tick: number;
  choice: string;
  correct: boolean;
}

/**
 * The answers that resolved a message in `seat`'s lane, by message id: decision lines that were
 * applied (`ok`, with `correct`), each shown from the frame after its `appliedTick`. Dropped,
 * timed-out and failed lines resolve nothing. A message is only ever resolved once (the game drops
 * a second answer), so the first line wins.
 */
export function laneResolutions(
  decisions: readonly DecisionLine[],
  seat: Seat,
): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const d of decisions) {
    if (d.seat !== seat || d.status !== 'ok' || d.appliedTick === null) continue;
    if (d.choice === null || typeof d.correct !== 'boolean') continue;
    if (!out.has(d.questionKey)) {
      out.set(d.questionKey, { tick: d.appliedTick + 1, choice: d.choice, correct: d.correct });
    }
  }
  return out;
}

export type CardPhase = 'falling' | 'cleared' | 'wrong' | 'landed';

export interface LaneCard {
  /** Stream index (the card shows `#index + 1`). */
  index: number;
  id: string;
  /** The true class: drawn only once the card is resolved or landed. */
  label: InboxLabel;
  spawnTick: number;
  landTick: number;
  phase: CardPhase;
  /** Ticks since it spawned. */
  sinceSpawn: number;
  /** Ticks since it was answered or landed (0 while falling). */
  age: number;
  /** Fall progress, frozen when it is answered (1 once landed). */
  progress: number;
  /** The tag's seconds to land (the view's rounding), frozen when it is answered. */
  secondsToLand: number;
  /** The seat's answer (cleared or wrong), else null. */
  choice: string | null;
}

/** Whether a resolved or landed card is still in its hold (in place, on top) at its age. */
export function holding(card: Pick<LaneCard, 'phase' | 'age'>): boolean {
  if (card.phase === 'falling') return false;
  return card.age < (card.phase === 'landed' ? LAND_HOLD : RESOLVE_HOLD);
}

/**
 * The cards `seat`'s lane shows at `tick`, back to front:
 *   1. answered and landed cards in their fade (they slip away behind whatever is falling),
 *   2. falling cards, the soonest to land last (so the one being asked is whole),
 *   3. answered cards in their hold (the verdict on top), then landed ones (the loudest event).
 * `resolutions` may hold answers from after `tick`; they are ignored.
 */
export function laneCards(
  state: InboxState,
  seat: Seat,
  resolutions: ReadonlyMap<string, Resolution>,
  tick: number,
): LaneCard[] {
  const lane = state.lanes[seat];
  const falling: LaneCard[] = [];
  const landed: LaneCard[] = [];
  const resolved: LaneCard[] = [];
  const card = (
    index: number,
    item: StreamItem,
    phase: CardPhase,
    at: number,
    choice: string | null,
  ): LaneCard => ({
    index,
    id: item.id,
    label: item.label,
    spawnTick: item.spawnTick,
    landTick: item.landTick,
    phase,
    sinceSpawn: Math.max(0, tick - item.spawnTick),
    age: phase === 'falling' ? 0 : tick - at,
    progress: phase === 'landed' ? 1 : fallProgress(item, at),
    secondsToLand: secondsToLand(Math.max(0, item.landTick - at)),
    choice,
  });
  const spawned = Math.min(state.next, state.stream.length);
  for (let i = 0; i < spawned; i++) {
    const item = state.stream[i];
    if (item === undefined || item.spawnTick > tick) continue;
    const r = resolutions.get(item.id);
    if (r !== undefined && r.tick <= tick) {
      if (tick - r.tick < RESOLVE_TICKS) {
        resolved.push(card(i, item, r.correct ? 'cleared' : 'wrong', r.tick, r.choice));
      }
      continue;
    }
    const outcome = lane.outcomes[i];
    if (outcome === OUTCOME.landed) {
      if (tick - item.landTick < LAND_TICKS)
        landed.push(card(i, item, 'landed', item.landTick, null));
    } else if (outcome === OUTCOME.pending) {
      falling.push(card(i, item, 'falling', tick, null));
    }
    // Answered in the state but no applied line by now (live mode catching up): not drawn.
  }
  falling.sort((a, b) => b.landTick - a.landTick || b.index - a.index);
  const fading = [...resolved, ...landed].filter((c) => !holding(c));
  return [...fading, ...falling, ...resolved.filter(holding), ...landed.filter(holding)];
}

export interface CardPose {
  x: number;
  y: number;
  alpha: number;
  /** 1 on the tick a card is answered, fading to 0 over FLASH_TICKS. */
  flash: number;
  /**
   * The card's text and verdict row: 1, fading to 0 over the first SWIPE_TEXT_FADE of an answered
   * card's swipe, so its words are gone before they reach the edge of the card column.
   */
  textAlpha: number;
  /** Swiping out: drawn clipped to the card column, so no sliver shows in the lane's margin. */
  swiping: boolean;
}

/** The share of an answered card's swipe its text takes to fade (it has moved < CARD_PAD_X). */
export const SWIPE_TEXT_FADE = 0.2;

/** Where and how visibly a card is drawn: entrance, shake, swipe or sink. Deterministic. */
export function cardPose(card: LaneCard, seat: Seat): CardPose {
  let x = LANE_X[seat] + CARD_INSET;
  let y = cardTop(card.progress);
  let alpha = 1;
  let flash = 0;
  let textAlpha = 1;
  let swiping = false;
  const out = seat === 0 ? -1 : 1;
  if (card.phase === 'falling') {
    // Drops in from just above (opaque, so it hides the card fading out behind it); not at the
    // start, where frame 0 shows the first message in place.
    if (card.sinceSpawn < ENTER_TICKS && card.spawnTick > 0) {
      const e = (card.sinceSpawn + 1) / ENTER_TICKS;
      y -= (1 - e) * (1 - e) * ENTER_DROP_PX;
    }
  } else if (card.phase === 'landed') {
    if (card.age < LAND_HOLD) {
      x += Math.sin(card.age * 2.1) * 16 * (1 - card.age / LAND_HOLD);
    } else {
      const t = clamp01((card.age - LAND_HOLD) / FADE_TICKS);
      y += t * SINK_PX;
      alpha = 1 - t;
    }
  } else {
    flash = Math.max(0, 1 - card.age / FLASH_TICKS);
    if (card.age < RESOLVE_HOLD) {
      if (card.phase === 'wrong') {
        x += Math.sin(card.age * 1.7) * 18 * (1 - card.age / RESOLVE_HOLD);
      }
    } else {
      const t = clamp01((card.age - RESOLVE_HOLD) / FADE_TICKS);
      x += out * SWIPE_PX * t * t;
      alpha = 1 - t;
      textAlpha = clamp01(1 - t / SWIPE_TEXT_FADE);
      swiping = true;
    }
  }
  return { x, y, alpha, flash, textAlpha, swiping };
}

// ---------------------------------------------------------------------------------------------
// Which parts of a card show. Cards overlap (a pile, a verdict held over the cards behind it),
// and a row of text cut by another card's edge reads as garbage, so a card draws only the rows
// nothing covers: its header row and each text line, whole or not at all. Its outline always
// shows, so a pile still reads as a pile.

/** A horizontal band of a card, in logical px from the card's top edge. */
export interface CardRow {
  top: number;
  bottom: number;
}

/** The header row: the id and timer pill, or the verdict. */
export const HEADER_ROW: CardRow = { top: CARD_PAD_TOP, bottom: CARD_PAD_TOP + CARD_HEAD_H };

/** Text line `i` (0-based) of the message, lines `lineH` apart (messageLayout). */
export function textRow(i: number, lineH = CARD_LINE_H): CardRow {
  const top = CARD_PAD_TOP + CARD_HEAD_H + CARD_TEXT_GAP + i * lineH;
  return { top, bottom: top + lineH };
}

/** The message text's design size (logical px): 46 px on CARD_LINES lines CARD_LINE_H apart. */
export const MESSAGE_PX = 46;
/** The largest message size a raised floor gets. */
export const MESSAGE_MAX_PX = 64;

export interface MessageLayout {
  /** Font size (logical px). */
  px: number;
  /** Line pitch. */
  lineH: number;
  /** Lines that fit in the card's text area (CARD_LINES × CARD_LINE_H). */
  lines: number;
}

/**
 * How a card's message is set for a legibility floor (shell/theme.ts legibleFloor, logical px):
 * the design (46 px, four lines) while the floor is under it; above it (the square video, a
 * phone) a quarter over the floor, up to MESSAGE_MAX_PX, on as many lines as the same text area
 * holds (three in the square video: about 34 px of the 1080 frame). The rest of a long message
 * ends in an ellipsis.
 */
export function messageLayout(floor: number): MessageLayout {
  if (floor <= MESSAGE_PX) return { px: MESSAGE_PX, lineH: CARD_LINE_H, lines: CARD_LINES };
  const px = Math.min(MESSAGE_MAX_PX, Math.round(floor * 1.25));
  const area = CARD_LINES * CARD_LINE_H;
  const lines = Math.max(1, Math.floor(area / (px * 1.12)));
  return { px, lineH: Math.floor(area / lines), lines };
}

/** A card in front covers from just above its edge (its stroke) to the bottom of its shadow. */
export const COVER_ABOVE = 4;
export const COVER_BELOW = 10;

/** Where cards can be seen: inside the lane, above the inbox bar (drawn over the cards). */
export function openBand(seat: Seat): { top: number; bottom: number } {
  return { top: LANE_TOP + 4, bottom: inboxRect(seat).y };
}

/** The game-over banner's band of the stage (draw.ts paints it opaque over the lanes). */
export const BANNER_BAND = { top: 560, bottom: 810 } as const;

/**
 * Whether `row` of the card at `tops[i]` is drawn: inside `open`, clear of every `hidden` band
 * (something opaque drawn over the lane, like the game-over banner) and of every card drawn after
 * it (in front; `tops[j]` null for a card not drawn, e.g. fully faded).
 */
export function rowVisible(
  tops: readonly (number | null)[],
  i: number,
  row: CardRow,
  open: { top: number; bottom: number },
  hidden: readonly { top: number; bottom: number }[] = [],
): boolean {
  const y = tops[i];
  if (y === null || y === undefined) return false;
  const top = y + row.top;
  const bottom = y + row.bottom;
  if (top < open.top || bottom > open.bottom) return false;
  if (hidden.some((b) => bottom > b.top && top < b.bottom)) return false;
  for (let j = i + 1; j < tops.length; j++) {
    const f = tops[j];
    if (f === null || f === undefined) continue;
    if (bottom > f - COVER_ABOVE && top < f + CARD_H + COVER_BELOW) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Health pulses, clock, chapters, banner.

export interface Hit {
  /** The first frame that shows the hit (the event's tick + 1: the state after that step). */
  tick: number;
  cause: 'wrong' | 'landed';
  damage: number;
}

/** `seat`'s latest `hit` event in `events` (logged before the frame), or null. */
export function lastHit(events: readonly EventLine[], seat: Seat): Hit | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const g = events[i]?.game;
    if (g === undefined || g.kind !== 'hit' || g.seat !== seat) continue;
    const cause = g.cause === 'landed' ? 'landed' : 'wrong';
    const damage = typeof g.damage === 'number' ? g.damage : 0;
    return { tick: (events[i]?.tick ?? 0) + 1, cause, damage };
  }
  return null;
}

/** 1 on the frame a hit shows, fading to 0 over PULSE_TICKS. */
export function pulseAt(hit: Hit | null, tick: number): number {
  if (hit === null) return 0;
  const age = tick - hit.tick;
  return age < 0 || age >= PULSE_TICKS ? 0 : 1 - age / PULSE_TICKS;
}

/** Ticks → `m:ss` (whole seconds, rounded down). */
export function formatClock(ticks: number, rate = TICK_RATE): string {
  const secs = Math.max(0, Math.floor(ticks / rate));
  return `${String(Math.floor(secs / 60))}:${String(secs % 60).padStart(2, '0')}`;
}

/** 'P1 · Jev (TypeSafe)', or just 'P1' without a label. */
export function seatLabel(seat: Seat, label: string): string {
  const p = `P${String(seat + 1)}`;
  return label === '' ? p : `${p} · ${label}`;
}

/**
 * The header's label, longest first: the full seat label, then without its trailing parenthetical
 * (the model version, "P2 · OpenAI Decisions"), then for a model's label its first word
 * ("P2 · OpenAI"). The header takes the first that fits its fixed space; the panel under the stage
 * always shows the full label.
 */
export function headerLabels(seat: Seat, label: string): string[] {
  const full = seatLabel(seat, label);
  const bare = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const short = seatLabel(seat, bare);
  if (short === full || label.trim() === '') return [full];
  // A model's label: then just its first word ("P2 · OpenAI"), for the legibility floor.
  const first = seatLabel(seat, bare.split(/\s+/)[0] ?? bare);
  return first === short ? [full, short] : [full, short, first];
}

/** Digits of the widest health number a lane can show (its starting health). */
export function healthDigits(maxHealth: number): number {
  return String(Math.max(0, Math.trunc(maxHealth))).length;
}

/** The inbox bar's accuracy text, longest first: "92% right", then "92%". */
export function accuracyTexts(pct: number): string[] {
  return [`${String(pct)}% right`, `${String(pct)}%`];
}

const OPTION_LABELS: Readonly<Record<string, string>> = {
  legit: 'Legit',
  spam: 'Spam',
  smishing: 'Smishing',
};

export function optionLabel(id: string): string {
  return OPTION_LABELS[id] ?? id;
}

/** Correct answers as a percentage of answers applied, or null before the first. */
export function accuracyPct(lane: { answered: number; correct: number }): number | null {
  return lane.answered === 0 ? null : Math.round((lane.correct / lane.answered) * 100);
}

/** The game-over banner (and the winning seat, for its color), or null while the game is on. */
export function bannerText(
  state: InboxState,
  labels: SeatPair<string>,
): { title: string; sub: string; winner: Seat | null } | null {
  if (!state.over) return null;
  const { winner } = inboxResult(state);
  const [a, b] = state.lanes;
  const pct = (l: typeof a): string => {
    const p = accuracyPct(l);
    return p === null ? '—' : `${String(p)}%`;
  };
  const sub =
    `Inbox health ${String(a.health)} – ${String(b.health)}` + ` · accuracy ${pct(a)} – ${pct(b)}`;
  if (winner === null || winner === 'draw') return { title: 'Draw', sub, winner: null };
  return { title: `${seatLabel(winner, labels[winner])} wins`, sub, winner };
}

// ---------------------------------------------------------------------------------------------
// Text.

export const ELLIPSIS = '…';

/**
 * Word-wraps `text` into at most `maxLines` lines of width ≤ `maxW` (by `measure`). A word wider
 * than a line (a long URL) is broken by characters. If the text doesn't fit, the last line ends in
 * an ellipsis.
 */
export function wrapText(
  text: string,
  maxW: number,
  maxLines: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let cur = '';
  const breakWord = (word: string): string => {
    let rest = word;
    while (rest.length > 1 && measure(rest) > maxW) {
      let n = rest.length - 1;
      while (n > 1 && measure(rest.slice(0, n)) > maxW) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    return rest;
  };
  for (const word of words) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (measure(candidate) <= maxW) {
      cur = candidate;
      continue;
    }
    if (cur !== '') lines.push(cur);
    cur = breakWord(word);
  }
  if (cur !== '') lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] ?? '';
  while (last.length > 0 && measure(`${last}${ELLIPSIS}`) > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}${ELLIPSIS}`;
  return kept;
}
