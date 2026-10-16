import { describe, expect, it } from 'vitest';
import { STAGE_MAX, STAGE_MIN, SUB } from '../../../../src/games/fighter/engine/constants.js';
import { createPrng, nextBelow } from '../../../../src/core/util/prng.js';
import { createMatch, step } from '../../../../src/games/fighter/engine/sim.js';
import type {
  FighterState,
  MatchState,
  MoveId,
  PrngState,
} from '../../../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../../src/games/fighter/engine/types.js';

/** Fairness: resolution order must not favour either side, so mirrored inputs stay mirrored. */

const CENTER = (STAGE_MIN + STAGE_MAX) / 2;

/** Fighters `half` sub-units either side of the stage center. */
function mirroredMatch(half: number, seed = 1): MatchState {
  const s = createMatch(seed);
  s.fighters[0].x = CENTER - half;
  s.fighters[1].x = CENTER + half;
  return s;
}

function mirrorSnapshot(s: MatchState) {
  const [a, b] = s.fighters;
  return {
    p0: { dist: a.x - STAGE_MIN, y: a.y, health: a.health, phase: a.phase, action: a.action },
    p1: { dist: STAGE_MAX - b.x, y: b.y, health: b.health, phase: b.phase, action: b.action },
  };
}

function mirrorOf(a: FighterState, b: FighterState) {
  return [
    { dist: a.x - STAGE_MIN, y: a.y, health: a.health, phase: a.phase, action: a.action },
    { dist: STAGE_MAX - b.x, y: b.y, health: b.health, phase: b.phase, action: b.action },
  ];
}

function maybeMove(rng: PrngState, density: number): MoveId | null {
  if (nextBelow(rng, density) !== 0) return null;
  return MOVE_IDS[nextBelow(rng, MOVE_IDS.length)] ?? null;
}

function expectMirrored(s: MatchState, label: string): void {
  const { p0, p1 } = mirrorSnapshot(s);
  expect(p0, label).toEqual(p1);
}

describe('mirror symmetry', () => {
  it('simultaneous jumps from symmetric gaps stay mirror-equal every tick', () => {
    for (let half = 30 * SUB; half <= 250 * SUB; half += 37) {
      const s = mirroredMatch(half);
      for (let t = 0; t < 60; t++) {
        step(s, t === 0 ? ['jump_in', 'jump_in'] : [null, null]);
        expectMirrored(s, `half=${String(half)} tick=${String(t)}`);
      }
    }
  });

  it('random mirrored inputs keep the state mirror-symmetric', () => {
    for (const seed of [1, 2, 3, 42, 20261007]) {
      const rng = createPrng(seed);
      const s = mirroredMatch((50 + nextBelow(rng, 250)) * SUB, seed);
      for (let t = 0; t < 4000 && s.status !== 'matchOver'; t++) {
        let move: MoveId | null = null;
        if (nextBelow(rng, 4) === 0) move = MOVE_IDS[nextBelow(rng, MOVE_IDS.length)] ?? null;
        const events = step(s, [move, move]);
        expectMirrored(s, `seed=${String(seed)} tick=${String(t)}`);
        const shots = (owner: 0 | 1) =>
          s.projectiles
            .filter((p) => p.owner === owner)
            .map((p) => (owner === 0 ? p.x - STAGE_MIN : STAGE_MAX - p.x));
        expect(shots(0)).toEqual(shots(1));
        const winners = events.flatMap((e) => (e.type === 'roundEnd' ? [e.winner] : []));
        for (const w of winners) expect(w, `seed=${String(seed)} tick=${String(t)}`).toBe('draw');
      }
    }
  });
  // Different moves per side: match A gets [m0, m1], match B (same mirrored start) gets
  // [m1, m0]. A's fighter 0 must mirror B's fighter 1 every tick, so no rule can depend on side
  // order. Seeds 1666 and 1912 caught the pushbox giving fighter 1 the odd sub-unit.
  it('swapped inputs give the mirrored result (no side-order bias)', () => {
    for (const seed of [1, 2, 3, 1666, 1912]) {
      const rng = createPrng(seed);
      const half = (30 + nextBelow(rng, 400)) * SUB + nextBelow(rng, 100);
      const a = mirroredMatch(half, seed);
      const b = mirroredMatch(half, seed);
      const density = 1 + nextBelow(rng, 8);
      for (let t = 0; t < 3000 && a.status !== 'matchOver'; t++) {
        const m0 = maybeMove(rng, density);
        const m1 = maybeMove(rng, density);
        step(a, [m0, m1]);
        step(b, [m1, m0]);
        const label = `seed=${String(seed)} tick=${String(t)}`;
        expect(mirrorOf(a.fighters[0], a.fighters[1]), label).toEqual(
          mirrorOf(b.fighters[0], b.fighters[1]).reverse(),
        );
      }
    }
  });
});
