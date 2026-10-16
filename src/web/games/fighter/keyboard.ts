import { facingOf } from '../../../games/fighter/engine/fighter.js';
import type {
  FighterState,
  MatchState,
  MoveId,
  Side,
} from '../../../games/fighter/engine/types.js';
import type { HumanInput } from '../../../games/fighter/human.js';

/**
 * Human keyboard controls, as a decider: the keys become one MoveId per tick at most, and only
 * when it would change something.
 *
 * - One-shots (J jab, K heavy, L sweep, U uppercut, I fireball, O throw, W jump_in) fire on key
 *   press (auto-repeat ignored) and are sent on the next tick, even while busy (the engine buffers).
 * - Holds come from the keys held right now: Shift = block_high, S = block_low, A / D = walk left /
 *   right (mapped to walk_forward / walk_back by facing; the later-pressed one wins).
 *   With no hold key held the fighter stands in high guard: block_high is the closest thing
 *   to "neutral" in the 11 options (there is no 'stand' option).
 * - The desired hold is sent only while the fighter is idle, not buffering, and not already in it,
 *   so it re-sends after a one-shot ends (the engine leaves the fighter in 'stand') but never spams.
 *
 * Pure apart from `attachKeys`, which feeds it KeyboardEvent.code values (sandbox and live mode).
 */

export const ONE_SHOT_KEYS: Readonly<Record<string, MoveId>> = {
  KeyJ: 'jab',
  KeyK: 'heavy_punch',
  KeyL: 'sweep',
  KeyU: 'uppercut',
  KeyI: 'fireball',
  KeyO: 'throw',
  KeyW: 'jump_in',
};

export const HOLD_KEYS: readonly string[] = ['KeyA', 'KeyD', 'KeyS', 'ShiftLeft', 'ShiftRight'];

/** The hold used when no hold key is down. */
export const NEUTRAL_HOLD: MoveId = 'block_high';

const MAX_QUEUED = 2;

export interface KeyState {
  /** Hold keys currently down, in press order. */
  held: string[];
  /** One-shots pressed and not yet sent, oldest first. */
  queued: MoveId[];
}

export function createKeyState(): KeyState {
  return { held: [], queued: [] };
}

export function isGameKey(code: string): boolean {
  return code in ONE_SHOT_KEYS || HOLD_KEYS.includes(code);
}

/** Returns true if the key is a game key (caller should preventDefault). */
export function keyDown(ks: KeyState, code: string, repeat = false): boolean {
  const shot = ONE_SHOT_KEYS[code];
  if (shot !== undefined) {
    if (!repeat && ks.queued.length < MAX_QUEUED) ks.queued.push(shot);
    return true;
  }
  if (HOLD_KEYS.includes(code)) {
    if (!ks.held.includes(code)) ks.held.push(code);
    return true;
  }
  return false;
}

export function keyUp(ks: KeyState, code: string): boolean {
  const i = ks.held.indexOf(code);
  if (i >= 0) ks.held.splice(i, 1);
  return isGameKey(code);
}

/** Forget everything (window blur, between rounds). */
export function clearKeys(ks: KeyState, keepHeld = false): void {
  if (!keepHeld) ks.held.length = 0;
  ks.queued.length = 0;
}

/** The hold the held keys ask for. `facing` is +1 when the fighter faces right. */
export function desiredHold(held: readonly string[], facing: 1 | -1): MoveId {
  if (held.includes('ShiftLeft') || held.includes('ShiftRight')) return 'block_high';
  if (held.includes('KeyS')) return 'block_low';
  for (let i = held.length - 1; i >= 0; i--) {
    const k = held[i];
    if (k === 'KeyA' || k === 'KeyD') {
      const screenDir = k === 'KeyD' ? 1 : -1;
      return screenDir === facing ? 'walk_forward' : 'walk_back';
    }
  }
  return NEUTRAL_HOLD;
}

export type HumanFighterView = Pick<FighterState, 'phase' | 'action' | 'buffered'>;

/** The move to send this tick, or null. Consumes one queued one-shot if there is one. */
export function nextHumanMove(
  ks: KeyState,
  fighter: HumanFighterView,
  facing: 1 | -1,
): MoveId | null {
  const shot = ks.queued.shift();
  if (shot !== undefined) return shot;
  if (fighter.phase !== 'idle' || fighter.buffered !== null) return null;
  const hold = desiredHold(ks.held, facing);
  return fighter.action === hold ? null : hold;
}

export interface AttachKeysOptions {
  /** Whether key presses count right now (e.g. only while a human plays). Default: always. */
  enabled?: () => boolean;
  /** Extra key handling before the game keys (the sandbox's R = restart). True: handled. */
  onKey?: (e: KeyboardEvent) => boolean;
}

/** Feed `target`'s key events into `keys`; returns a function that stops listening. */
export function attachKeys(
  target: Window,
  keys: KeyState,
  opts: AttachKeysOptions = {},
): () => void {
  const enabled = opts.enabled ?? (() => true);
  const down = (e: KeyboardEvent): void => {
    if (opts.onKey?.(e) === true) return;
    if (!enabled() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLSelectElement) return;
    if (keyDown(keys, e.code, e.repeat)) e.preventDefault();
  };
  const up = (e: KeyboardEvent): void => {
    if (!enabled()) return;
    if (keyUp(keys, e.code) && isGameKey(e.code)) e.preventDefault();
  };
  const blur = (): void => {
    clearKeys(keys);
  };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}

export interface KeyboardHumanInput {
  input: HumanInput;
  /**
   * Call on every live loop pass with the live state: while a request is waiting it turns the keys
   * into a move (nextHumanMove) and hands it over. Between rounds the queued presses are dropped.
   */
  pump(state: MatchState, side: Side): void;
}

/** The keyboard as the fighter's `HumanInput` (live mode's `human` player). */
export function createKeyboardHumanInput(keys: KeyState): KeyboardHumanInput {
  const listeners = new Set<(move: MoveId) => void>();
  return {
    input: {
      onMove(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    pump(state, side) {
      if (state.status !== 'fighting') {
        clearKeys(keys, true);
        return;
      }
      if (listeners.size === 0) return;
      const move = nextHumanMove(keys, state.fighters[side], facingOf(state, side));
      if (move === null) return;
      for (const l of [...listeners]) l(move);
    },
  };
}
