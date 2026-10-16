import { SUB } from '../../../games/fighter/engine/constants.js';
import { MOVES } from '../../../games/fighter/engine/moves.js';
import type { FighterState, MoveId } from '../../../games/fighter/engine/types.js';

/**
 * Fighter poses: a pure map from (action, phase, phaseTick) to limb angles, plus forward
 * kinematics to joint positions. No DOM, no clock, no Math.random.
 *
 * Local frame: origin on the floor under the hip, +x = the direction the fighter faces, +y = up,
 * units are logical pixels (the 1920x1080 canvas). Angles are radians:
 * - limb upper angle: 0 = pointing straight down, +PI/2 = pointing forward, PI = straight up;
 * - limb lower angle: relative to the upper segment (arms bend +, knees bend -);
 * - torso: lean from vertical, + = forward; rot: whole-body tilt, + = forward, - = falling back.
 */

/** [upper absolute angle, lower angle relative to the upper]. */
export type Limb = readonly [number, number];

export interface Pose {
  /** `${action}:${phase}` or a named sub-pose, for debugging and tests. */
  name: string;
  torso: number;
  head: number;
  frontArm: Limb;
  backArm: Limb;
  frontLeg: Limb;
  backLeg: Limb;
  rot: number;
  /** Extra local px above the floor after grounding (a small uppercut hop, never a jump). */
  lift: number;
  /** Open palms (fireball, throw) vs fists. */
  open: boolean;
}

export type PoseInput = Pick<FighterState, 'action' | 'phase' | 'phaseTick' | 'busyTicks' | 'x'>;

export interface PoseOptions {
  /** Global tick, for the idle bob. Default 0. */
  tick?: number;
  /** +1 facing right, -1 facing left. Drives the walk cycle direction. Default +1. */
  facing?: 1 | -1;
}

export const SEGMENTS = {
  torso: 118,
  neck: 12,
  headR: 34,
  upperArm: 72,
  foreArm: 68,
  thigh: 88,
  shin: 86,
} as const;

/** Stroke widths, used for grounding (half width) and drawing. */
export const WIDTHS = {
  torso: 62,
  upperArm: 30,
  foreArm: 26,
  thigh: 38,
  shin: 32,
  fist: 20,
} as const;

const D = Math.PI / 180;

function p(
  name: string,
  torso: number,
  frontArm: [number, number],
  backArm: [number, number],
  frontLeg: [number, number],
  backLeg: [number, number],
  extra: Partial<Pick<Pose, 'head' | 'rot' | 'lift' | 'open'>> = {},
): Pose {
  return {
    name,
    torso: torso * D,
    head: (extra.head ?? 0) * D,
    frontArm: [frontArm[0] * D, frontArm[1] * D],
    backArm: [backArm[0] * D, backArm[1] * D],
    frontLeg: [frontLeg[0] * D, frontLeg[1] * D],
    backLeg: [backLeg[0] * D, backLeg[1] * D],
    rot: (extra.rot ?? 0) * D,
    lift: extra.lift ?? 0,
    open: extra.open ?? false,
  };
}

/** Named key poses (degrees in the table, radians in the result). */
export const KEY_POSES = {
  guard: p('guard', 8, [62, 105], [22, 128], [22, -30], [-16, -8]),
  blockHigh: p('block_high', -6, [100, 66], [62, 100], [22, -24], [-18, -6], { head: -8 }),
  blockLow: p('block_low', 12, [78, 70], [18, 134], [70, -112], [6, -96]),
  jabChamber: p('jab_chamber', 12, [70, 100], [40, 118], [26, -30], [-22, -8]),
  jab: p('jab', 16, [92, 0], [36, 120], [28, -28], [-24, -6]),
  heavyChamber: p('heavy_chamber', -8, [72, 96], [14, 130], [20, -26], [-26, -10]),
  heavy: p('heavy', 36, [38, 110], [88, 0], [46, -24], [-30, -4]),
  sweepChamber: p('sweep_chamber', 26, [50, 40], [-10, 20], [70, -120], [8, -100]),
  sweep: p('sweep', 34, [40, 30], [-24, 10], [90, -2], [14, -118], { head: 10 }),
  fireballChamber: p('fireball_chamber', -10, [-28, 104], [-40, 100], [20, -26], [-26, -10], {
    open: true,
  }),
  fireball: p('fireball', 18, [92, 4], [86, 10], [36, -20], [-30, -4], { open: true }),
  uppercutChamber: p('uppercut_chamber', 24, [24, 80], [44, 110], [62, -96], [-6, -70]),
  uppercut: p('uppercut', -10, [176, 6], [30, 110], [6, -6], [-12, -40], { head: -16 }),
  throwReach: p('throw_reach', 18, [86, 22], [74, 30], [30, -26], [-24, -8], { open: true }),
  throwGrab: p('throw_grab', 24, [96, -12], [90, -6], [34, -22], [-26, -6]),
  throwToss: p('throw_toss', -26, [150, 50], [170, 30], [-8, -24], [-34, -12], { head: -12 }),
  jumpTuck: p('jump_tuck', 6, [110, 70], [70, 90], [92, -128], [46, -118]),
  jumpKick: p('jump_kick', -18, [140, 40], [-30, 60], [62, 0], [-6, -104], { head: 6 }),
  land: p('land', 20, [70, 90], [40, 110], [62, -96], [-8, -70]),
  hitstun: p('hitstun', -26, [-34, 46], [-56, 64], [12, -22], [-30, -10], { head: -24 }),
  blockstunHigh: p('blockstun_high', -12, [104, 70], [62, 100], [18, -30], [-20, -6], {
    head: -16,
  }),
  blockstunLow: p('blockstun_low', 4, [84, 76], [18, 134], [70, -118], [6, -92], { head: -14 }),
  fall: p('fall', -20, [-80, 40], [-110, 30], [40, -30], [10, -40], { rot: -50, head: -20 }),
  down: p('down', 0, [135, 20], [100, 30], [8, -6], [-4, -12], { rot: -90, head: 10 }),
} as const;

export type KeyPoseName = keyof typeof KEY_POSES;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpLimb(a: Limb, b: Limb, t: number): Limb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

/** Component-wise blend; `t` is clamped to [0, 1]. The name is the target's unless overridden. */
export function mixPoses(a: Pose, b: Pose, t: number, name = b.name): Pose {
  const u = Math.min(1, Math.max(0, t));
  return {
    name,
    torso: lerp(a.torso, b.torso, u),
    head: lerp(a.head, b.head, u),
    frontArm: lerpLimb(a.frontArm, b.frontArm, u),
    backArm: lerpLimb(a.backArm, b.backArm, u),
    frontLeg: lerpLimb(a.frontLeg, b.frontLeg, u),
    backLeg: lerpLimb(a.backLeg, b.backLeg, u),
    rot: lerp(a.rot, b.rot, u),
    lift: lerp(a.lift, b.lift, u),
    open: u < 0.5 ? a.open : b.open,
  };
}

function easeOut(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 1 - (1 - u) * (1 - u);
}

function named(pose: Pose, name: string): Pose {
  return { ...pose, name };
}

/** Max hop of the uppercut in local px (a few engine units once scaled). */
export const UPPERCUT_HOP = 6;

/** Walk stride in engine units: one full leg cycle per this much travel. */
const STRIDE_UNITS = 46;

function walkPose(f: PoseInput, facing: 1 | -1, name: string): Pose {
  const phase = (((f.x / SUB) * facing) / STRIDE_UNITS) * Math.PI * 2;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const g = KEY_POSES.guard;
  return {
    ...g,
    name,
    torso: g.torso + 4 * D,
    frontLeg: [(4 + 26 * s) * D, (-18 - 22 * Math.max(0, c)) * D],
    backLeg: [(-4 - 26 * s) * D, (-18 - 22 * Math.max(0, -c)) * D],
    frontArm: [g.frontArm[0] - 8 * s * D, g.frontArm[1]],
    backArm: [g.backArm[0] + 8 * s * D, g.backArm[1]],
  };
}

function holdPose(f: PoseInput, tick: number, facing: 1 | -1): Pose {
  switch (f.action) {
    case 'walk_forward':
      return walkPose(f, facing, 'walk_forward:idle');
    case 'walk_back':
      return walkPose(f, facing, 'walk_back:idle');
    case 'block_high':
      return named(KEY_POSES.blockHigh, 'block_high:idle');
    case 'block_low':
      return named(KEY_POSES.blockLow, 'block_low:idle');
    default: {
      // 'stand' (or a one-shot that somehow sits in idle): guard with a slow breathing bob.
      const bob = Math.sin((tick / 18) * Math.PI) * 2 * D;
      const g = KEY_POSES.guard;
      return {
        ...g,
        name: `${f.action}:idle`,
        torso: g.torso + bob,
        frontArm: [g.frontArm[0] + bob, g.frontArm[1]],
      };
    }
  }
}

/** Chamber (startup target), strike (active) for the simple one-shots. */
const STRIKES: Partial<Record<MoveId, readonly [Pose, Pose]>> = {
  jab: [KEY_POSES.jabChamber, KEY_POSES.jab],
  heavy_punch: [KEY_POSES.heavyChamber, KEY_POSES.heavy],
  sweep: [KEY_POSES.sweepChamber, KEY_POSES.sweep],
};

function oneShotPose(move: MoveId, f: PoseInput): Pose {
  const m = MOVES[move];
  const name = `${move}:${f.phase}`;
  const g = KEY_POSES.guard;
  // +1 so the first tick of a phase already shows motion away from the previous pose.
  const tIn = (dur: number) => (dur <= 0 ? 1 : (f.phaseTick + 1) / dur);

  const strike = STRIKES[move];
  if (strike !== undefined) {
    const [chamber, hit] = strike;
    if (f.phase === 'startup') return mixPoses(g, chamber, easeOut(tIn(m.startup)), name);
    if (f.phase === 'active') return named(hit, name);
    return mixPoses(hit, g, easeOut(tIn(m.recovery)), name);
  }

  switch (move) {
    case 'fireball': {
      if (f.phase === 'startup') {
        return mixPoses(g, KEY_POSES.fireballChamber, easeOut(tIn(m.startup)), name);
      }
      if (f.phase === 'active') return named(KEY_POSES.fireball, name);
      // Recovery: hold the thrust for 10 ticks, then settle back to guard.
      const settle = (f.phaseTick - 10) / Math.max(1, m.recovery - 10);
      return mixPoses(KEY_POSES.fireball, g, easeOut(settle), name);
    }
    case 'uppercut': {
      if (f.phase === 'startup') {
        return mixPoses(g, KEY_POSES.uppercutChamber, easeOut(tIn(m.startup)), name);
      }
      // The engine keeps y at 0 for the uppercut, so the body only extends upward: the feet
      // leave the floor by at most UPPERCUT_HOP px. Vertical position always comes from engine y.
      if (f.phase === 'active') {
        const t = m.active <= 1 ? 1 : f.phaseTick / (m.active - 1);
        return { ...named(KEY_POSES.uppercut, name), lift: UPPERCUT_HOP * Math.min(1, t) };
      }
      // Recovery: settle over 10 ticks, arm stays up, then a slow return to guard.
      const fall = Math.max(0, 1 - f.phaseTick / 10);
      const up = { ...KEY_POSES.uppercut, lift: UPPERCUT_HOP * fall * fall };
      const back = mixPoses(up, KEY_POSES.land, Math.min(1, f.phaseTick / 10));
      if (f.phaseTick < 10) return named(back, name);
      return mixPoses(KEY_POSES.land, g, (f.phaseTick - 10) / (m.recovery - 10), name);
    }
    case 'throw': {
      if (f.phase === 'startup') {
        return mixPoses(g, KEY_POSES.throwReach, easeOut(tIn(m.startup)), name);
      }
      if (f.phase === 'active') return named(KEY_POSES.throwGrab, name);
      const half = m.recovery / 2;
      if (f.phaseTick < half) {
        return mixPoses(KEY_POSES.throwGrab, KEY_POSES.throwToss, easeOut(tIn(half)), name);
      }
      return mixPoses(KEY_POSES.throwToss, g, (f.phaseTick - half) / half, name);
    }
    case 'jump_in': {
      if (f.phase === 'startup') {
        // Crouched take-off for 3 ticks, then the tuck for the rest of the rise.
        if (f.phaseTick < 3)
          return mixPoses(KEY_POSES.land, KEY_POSES.jumpTuck, f.phaseTick / 3, name);
        return named(KEY_POSES.jumpTuck, name);
      }
      if (f.phase === 'active') {
        return mixPoses(KEY_POSES.jumpTuck, KEY_POSES.jumpKick, (f.phaseTick + 1) / 3, name);
      }
      return mixPoses(KEY_POSES.land, g, easeOut(tIn(m.recovery)), name);
    }
    default:
      return holdPose(f, 0, 1);
  }
}

function knockdownPose(f: PoseInput): Pose {
  const name = 'knockdown';
  const total = f.phaseTick + Math.max(0, f.busyTicks);
  const fallTicks = 8;
  const riseTicks = 8;
  if (f.phaseTick < fallTicks) {
    const t = f.phaseTick / fallTicks;
    return t < 0.5
      ? mixPoses(KEY_POSES.hitstun, KEY_POSES.fall, t * 2, name)
      : mixPoses(KEY_POSES.fall, KEY_POSES.down, (t - 0.5) * 2, name);
  }
  const left = total - f.phaseTick;
  if (left <= riseTicks && total > fallTicks + riseTicks) {
    return mixPoses(KEY_POSES.down, KEY_POSES.land, 1 - left / riseTicks, name);
  }
  return named(KEY_POSES.down, name);
}

/** The pose for a fighter this tick. Pure: same input, same pose. */
export function poseFor(f: PoseInput, opts: PoseOptions = {}): Pose {
  const tick = opts.tick ?? 0;
  const facing = opts.facing ?? 1;
  switch (f.phase) {
    case 'idle':
      return holdPose(f, tick, facing);
    case 'hitstun': {
      // Snap back on the first ticks, then ease toward guard near the end.
      const total = f.phaseTick + Math.max(0, f.busyTicks);
      const t = total > 0 ? f.phaseTick / total : 1;
      return t < 0.7
        ? named(KEY_POSES.hitstun, 'hitstun')
        : mixPoses(KEY_POSES.hitstun, KEY_POSES.guard, (t - 0.7) / 0.3, 'hitstun');
    }
    case 'blockstun':
      return f.action === 'block_low'
        ? named(KEY_POSES.blockstunLow, 'blockstun:low')
        : named(KEY_POSES.blockstunHigh, 'blockstun:high');
    case 'knockdown':
      return knockdownPose(f);
    case 'airborne':
      return named(KEY_POSES.jumpTuck, 'airborne');
    case 'startup':
    case 'active':
    case 'recovery':
      if (f.action === 'stand') return holdPose(f, tick, facing);
      return oneShotPose(f.action, f);
  }
}

export interface Point {
  x: number;
  y: number;
}

/** Joint positions in the local frame, grounded so the lowest limb edge touches y = 0. */
export interface Skeleton {
  hip: Point;
  neck: Point;
  head: Point;
  frontElbow: Point;
  frontHand: Point;
  backElbow: Point;
  backHand: Point;
  frontKnee: Point;
  frontFoot: Point;
  backKnee: Point;
  backFoot: Point;
  shoulder: Point;
}

function down(angle: number, len: number): Point {
  return { x: Math.sin(angle) * len, y: -Math.cos(angle) * len };
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** Forward kinematics, then rotate by `rot` around the hip, then ground and lift. */
export function skeleton(pose: Pose): Skeleton {
  const S = SEGMENTS;
  const hip = { x: 0, y: 0 };
  const torsoDir = { x: Math.sin(pose.torso), y: Math.cos(pose.torso) };
  const neck = { x: torsoDir.x * S.torso, y: torsoDir.y * S.torso };
  const headAngle = pose.torso + pose.head;
  const head = add(neck, {
    x: Math.sin(headAngle) * (S.neck + S.headR),
    y: Math.cos(headAngle) * (S.neck + S.headR),
  });
  const shoulder = { x: torsoDir.x * (S.torso - 14), y: torsoDir.y * (S.torso - 14) };
  const limb = (root: Point, l: Limb, a: number, b: number): [Point, Point] => {
    const mid = add(root, down(l[0], a));
    return [mid, add(mid, down(l[0] + l[1], b))];
  };
  const [frontElbow, frontHand] = limb(shoulder, pose.frontArm, S.upperArm, S.foreArm);
  const [backElbow, backHand] = limb(shoulder, pose.backArm, S.upperArm, S.foreArm);
  const [frontKnee, frontFoot] = limb(hip, pose.frontLeg, S.thigh, S.shin);
  const [backKnee, backFoot] = limb(hip, pose.backLeg, S.thigh, S.shin);

  const raw: Skeleton = {
    hip,
    neck,
    head,
    frontElbow,
    frontHand,
    backElbow,
    backHand,
    frontKnee,
    frontFoot,
    backKnee,
    backFoot,
    shoulder,
  };
  // Positive rot tips forward: a clockwise rotation in this y-up frame.
  const c = Math.cos(-pose.rot);
  const s = Math.sin(-pose.rot);
  const keys = Object.keys(raw) as (keyof Skeleton)[];
  const rotated = {} as Skeleton;
  for (const k of keys) {
    const q = raw[k];
    rotated[k] = { x: q.x * c - q.y * s, y: q.x * s + q.y * c };
  }
  // Lowest edge: limbs by half their stroke width, the head by its radius.
  const edges: number[] = [
    rotated.frontFoot.y - WIDTHS.shin / 2,
    rotated.backFoot.y - WIDTHS.shin / 2,
    rotated.frontKnee.y - WIDTHS.thigh / 2,
    rotated.backKnee.y - WIDTHS.thigh / 2,
    rotated.frontHand.y - WIDTHS.fist,
    rotated.backHand.y - WIDTHS.fist,
    rotated.head.y - S.headR,
    rotated.hip.y - WIDTHS.torso / 2,
    rotated.neck.y - WIDTHS.torso / 2,
  ];
  const lift = -Math.min(...edges) + pose.lift;
  for (const k of keys) rotated[k] = { x: rotated[k].x, y: rotated[k].y + lift };
  return rotated;
}

/**
 * Horizontal extent of the core silhouette (torso, head and back limbs, with their stroke widths)
 * in the local frame, +x forward. Front limbs are left out on purpose: they are what reaches toward
 * the opponent.
 */
export function bodyExtent(sk: Skeleton): { back: number; front: number } {
  const W = WIDTHS;
  const pts: [Point, number][] = [
    [sk.hip, W.torso / 2],
    [sk.neck, W.torso / 2],
    [sk.shoulder, W.torso / 2],
    [sk.head, SEGMENTS.headR],
    [sk.backElbow, W.upperArm / 2],
    [sk.backHand, W.fist],
    [sk.backKnee, W.thigh / 2],
    [sk.backFoot, W.shin / 2],
  ];
  let back = Infinity;
  let front = -Infinity;
  for (const [q, r] of pts) {
    back = Math.min(back, q.x - r);
    front = Math.max(front, q.x + r);
  }
  return { back, front };
}
