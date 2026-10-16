import { describe, expect, it } from 'vitest';
import { MOVES } from '../../../../src/games/fighter/engine/moves.js';
import type { FighterState, MoveId, Phase } from '../../../../src/games/fighter/engine/types.js';
import { MOVE_IDS, MOVE_KIND } from '../../../../src/games/fighter/engine/types.js';
import type { Point, Pose, PoseInput } from '../../../../src/web/games/fighter/poses.js';
import { poseFor, skeleton } from '../../../../src/web/games/fighter/poses.js';

function f(over: Partial<FighterState>): PoseInput {
  return { action: 'stand', phase: 'idle', phaseTick: 0, busyTicks: 0, x: 35_000, ...over };
}

function numbers(p: Pose): number[] {
  return [
    p.torso,
    p.head,
    ...p.frontArm,
    ...p.backArm,
    ...p.frontLeg,
    ...p.backLeg,
    p.rot,
    p.lift / 100,
  ];
}

function distance(a: Pose, b: Pose): number {
  const x = numbers(a);
  const y = numbers(b);
  return x.reduce((s, v, i) => s + Math.abs(v - (y[i] ?? 0)), 0);
}

function phasesFor(move: MoveId): Phase[] {
  if (MOVE_KIND[move] === 'hold') return ['idle', 'hitstun', 'blockstun', 'knockdown'];
  const m = MOVES[move];
  return ['startup', ...(m.active > 0 ? (['active'] as const) : []), 'recovery'];
}

function durationOf(move: MoveId, phase: Phase): number {
  const m = MOVES[move];
  if (phase === 'startup') return m.startup;
  if (phase === 'active') return m.active;
  if (phase === 'recovery') return m.recovery;
  return 20;
}

describe('poseFor', () => {
  it('gives a finite, grounded pose for every move x phase x tick', () => {
    for (const move of MOVE_IDS) {
      for (const phase of phasesFor(move)) {
        const dur = durationOf(move, phase);
        for (let t = 0; t < dur; t++) {
          const pose = poseFor(f({ action: move, phase, phaseTick: t, busyTicks: dur - t }));
          expect(numbers(pose).every(Number.isFinite), `${move}:${phase}:${String(t)}`).toBe(true);
          const sk = skeleton(pose);
          const ys = (Object.values(sk) as Point[]).map((pt) => pt.y);
          expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-6);
        }
      }
    }
  });

  it('is pure: the same input gives the same pose', () => {
    const input = f({ action: 'heavy_punch', phase: 'startup', phaseTick: 4 });
    expect(poseFor(input, { tick: 7 })).toEqual(poseFor(input, { tick: 7 }));
  });

  it('names the pose after action and phase', () => {
    expect(poseFor(f({ action: 'jab', phase: 'active' })).name).toBe('jab:active');
    expect(poseFor(f({ action: 'block_low' })).name).toBe('block_low:idle');
    expect(poseFor(f({ phase: 'knockdown', busyTicks: 30, phaseTick: 10 })).name).toBe('knockdown');
  });

  it('gives every key state a clearly different pose', () => {
    const states: Record<string, PoseInput> = {
      idle: f({}),
      walk: f({ action: 'walk_forward', x: 35_000 + 1150 }),
      blockHigh: f({ action: 'block_high' }),
      blockLow: f({ action: 'block_low' }),
      jab: f({ action: 'jab', phase: 'active', phaseTick: 1 }),
      heavy: f({ action: 'heavy_punch', phase: 'active', phaseTick: 1 }),
      sweep: f({ action: 'sweep', phase: 'active', phaseTick: 1 }),
      fireballThrow: f({ action: 'fireball', phase: 'recovery', phaseTick: 2 }),
      uppercut: f({ action: 'uppercut', phase: 'active', phaseTick: 3 }),
      throwGrab: f({ action: 'throw', phase: 'active', phaseTick: 0 }),
      jumpKick: f({ action: 'jump_in', phase: 'active', phaseTick: 6 }),
      jumpRise: f({ action: 'jump_in', phase: 'startup', phaseTick: 12 }),
      hitstun: f({ phase: 'hitstun', phaseTick: 1, busyTicks: 15 }),
      blockstun: f({ action: 'block_high', phase: 'blockstun', phaseTick: 1, busyTicks: 10 }),
      blockstunLow: f({ action: 'block_low', phase: 'blockstun', phaseTick: 1, busyTicks: 10 }),
      knockdown: f({ phase: 'knockdown', phaseTick: 20, busyTicks: 20 }),
    };
    const names = Object.keys(states);
    const poses = names.map((n) => poseFor(states[n] as PoseInput));
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j++) {
        const d = distance(poses[i] as Pose, poses[j] as Pose);
        expect(d, `${names[i] ?? ''} vs ${names[j] ?? ''}`).toBeGreaterThan(0.5);
      }
    }
  });

  it('animates the walk cycle with position and moves through a strike', () => {
    const a = poseFor(f({ action: 'walk_forward', x: 35_000 }));
    const b = poseFor(f({ action: 'walk_forward', x: 35_000 + 1100 }));
    expect(distance(a, b)).toBeGreaterThan(0.3);
    const s0 = poseFor(f({ action: 'heavy_punch', phase: 'startup', phaseTick: 0 }));
    const s8 = poseFor(f({ action: 'heavy_punch', phase: 'startup', phaseTick: 8 }));
    expect(distance(s0, s8)).toBeGreaterThan(0.3);
  });

  it('crouches for block_low and sweep, rises for uppercut, lies flat in knockdown', () => {
    const headY = (input: PoseInput) => skeleton(poseFor(input)).head.y;
    const stand = headY(f({}));
    expect(headY(f({ action: 'block_low' }))).toBeLessThan(stand * 0.85);
    expect(headY(f({ action: 'sweep', phase: 'active' }))).toBeLessThan(stand * 0.85);
    expect(headY(f({ action: 'uppercut', phase: 'active', phaseTick: 5 }))).toBeGreaterThan(stand);
    expect(headY(f({ phase: 'knockdown', phaseTick: 20, busyTicks: 20 }))).toBeLessThan(
      stand * 0.4,
    );
  });
});
