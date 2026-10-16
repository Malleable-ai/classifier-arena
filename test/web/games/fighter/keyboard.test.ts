import { describe, expect, it } from 'vitest';
import type { HumanFighterView } from '../../../../src/web/games/fighter/keyboard.js';
import {
  createKeyState,
  desiredHold,
  keyDown,
  keyUp,
  nextHumanMove,
} from '../../../../src/web/games/fighter/keyboard.js';

const idle = (action: HumanFighterView['action']): HumanFighterView => ({
  phase: 'idle',
  action,
  buffered: null,
});

describe('desiredHold', () => {
  it('maps A/D to walk by facing, later key wins', () => {
    expect(desiredHold(['KeyD'], 1)).toBe('walk_forward');
    expect(desiredHold(['KeyD'], -1)).toBe('walk_back');
    expect(desiredHold(['KeyA'], 1)).toBe('walk_back');
    expect(desiredHold(['KeyA'], -1)).toBe('walk_forward');
    expect(desiredHold(['KeyA', 'KeyD'], 1)).toBe('walk_forward');
    expect(desiredHold(['KeyD', 'KeyA'], 1)).toBe('walk_back');
  });

  it('prefers Shift, then S, and falls back to high guard', () => {
    expect(desiredHold(['KeyD', 'KeyS'], 1)).toBe('block_low');
    expect(desiredHold(['KeyS', 'ShiftLeft'], 1)).toBe('block_high');
    expect(desiredHold([], 1)).toBe('block_high');
  });
});

describe('nextHumanMove', () => {
  it('sends a hold only when it changes something', () => {
    const ks = createKeyState();
    keyDown(ks, 'KeyD');
    expect(nextHumanMove(ks, idle('stand'), 1)).toBe('walk_forward');
    expect(nextHumanMove(ks, idle('walk_forward'), 1)).toBeNull();
    keyUp(ks, 'KeyD');
    expect(nextHumanMove(ks, idle('walk_forward'), 1)).toBe('block_high');
    expect(nextHumanMove(ks, idle('block_high'), 1)).toBeNull();
  });

  it('does not send holds while busy or buffering', () => {
    const ks = createKeyState();
    keyDown(ks, 'KeyS');
    expect(nextHumanMove(ks, { phase: 'recovery', action: 'jab', buffered: null }, 1)).toBeNull();
    expect(
      nextHumanMove(
        ks,
        { phase: 'idle', action: 'stand', buffered: { move: 'jab', ticksLeft: 3 } },
        1,
      ),
    ).toBeNull();
  });

  it('queues one-shots on press, ignores auto-repeat, sends one per tick even while busy', () => {
    const ks = createKeyState();
    expect(keyDown(ks, 'KeyJ')).toBe(true);
    expect(keyDown(ks, 'KeyJ', true)).toBe(true);
    keyDown(ks, 'KeyI');
    const busy: HumanFighterView = { phase: 'active', action: 'jab', buffered: null };
    expect(nextHumanMove(ks, busy, 1)).toBe('jab');
    expect(nextHumanMove(ks, busy, 1)).toBe('fireball');
    expect(nextHumanMove(ks, busy, 1)).toBeNull();
  });

  it('maps every one-shot key', () => {
    const ks = createKeyState();
    const got: string[] = [];
    for (const code of ['KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'KeyW']) {
      keyDown(ks, code);
      got.push(String(nextHumanMove(ks, idle('block_high'), 1)));
    }
    expect(got).toEqual([
      'jab',
      'heavy_punch',
      'sweep',
      'uppercut',
      'fireball',
      'throw',
      'jump_in',
    ]);
    expect(keyDown(ks, 'KeyX')).toBe(false);
  });
});
