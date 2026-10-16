import type {
  MatchState,
  Projectile,
  Side,
  StepEvent,
} from '../../../games/fighter/engine/types.js';

/**
 * Visual effects derived only from engine events and state: hit sparks, block flashes, knockdown
 * dust and fireball clashes. Everything is a function of (effect, tick), so a replayed or
 * offline-rendered frame looks identical. No Math.random.
 */

export type EffectKind = 'spark' | 'block' | 'dust' | 'clash';

export interface Effect {
  kind: EffectKind;
  /** Tick the effect starts showing. */
  tick: number;
  /** Engine x (sub-units) and height above the floor in logical px. */
  x: number;
  height: number;
  /** Direction the hit travelled: +1 = to the right. */
  dir: 1 | -1;
  /** Side whose colors tint the effect (the attacker). */
  side: Side;
  /** 0..1, scales size (damage based). */
  strength: number;
}

export const EFFECT_TICKS: Readonly<Record<EffectKind, number>> = {
  spark: 12,
  block: 10,
  dust: 26,
  clash: 16,
};

/** Ticks after a knockdown hit when the body meets the floor (matches the pose's fall). */
export const DUST_DELAY = 7;

const HEIGHT_PX: Readonly<Record<string, number>> = {
  mid: 210,
  low: 50,
  overhead: 270,
  throw: 190,
  projectile: 190,
};

function strikeHeight(move: string): number {
  if (move === 'sweep') return HEIGHT_PX.low ?? 50;
  if (move === 'jump_in') return HEIGHT_PX.overhead ?? 270;
  if (move === 'throw') return HEIGHT_PX.throw ?? 190;
  if (move === 'fireball') return HEIGHT_PX.projectile ?? 190;
  if (move === 'uppercut') return 250;
  return HEIGHT_PX.mid ?? 210;
}

/**
 * New effects for one tick's events. `state` is the state after the step; `prevProjectiles` the
 * projectiles before it (a clash removes both, so their positions come from before).
 */
export function effectsFromEvents(
  events: readonly StepEvent[],
  state: MatchState,
  prevProjectiles: readonly Projectile[],
): Effect[] {
  const out: Effect[] = [];
  for (const e of events) {
    if (e.type === 'hit' || e.type === 'blocked') {
      const target = state.fighters[e.target];
      const attacker = state.fighters[e.fighter];
      const dir: 1 | -1 = target.x >= attacker.x ? 1 : -1;
      const height = strikeHeight(e.move);
      const strength = Math.min(1, (e.type === 'hit' ? e.damage : 4) / 10);
      out.push({
        kind: e.type === 'hit' ? 'spark' : 'block',
        tick: e.tick,
        x: target.x - dir * 2400,
        height,
        dir,
        side: e.fighter,
        strength,
      });
      if (e.type === 'hit' && e.knockdown) {
        out.push({
          kind: 'dust',
          tick: e.tick + DUST_DELAY,
          x: target.x,
          height: 0,
          dir,
          side: e.target,
          strength: 1,
        });
      }
    } else if (e.type === 'fireballClash') {
      const xs = prevProjectiles.map((pr) => pr.x + pr.vx);
      const x = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 50_000;
      out.push({ kind: 'clash', tick: e.tick, x, height: 190, dir: 1, side: 0, strength: 1 });
    }
  }
  return out;
}

/** Effects still visible at `tick` (started, not expired). */
export function liveEffects(effects: readonly Effect[], tick: number): Effect[] {
  return effects.filter((fx) => tick >= fx.tick && tick < fx.tick + EFFECT_TICKS[fx.kind]);
}

/** Drop effects that can never show again (keeps the list short). */
export function pruneEffects(effects: Effect[], tick: number): Effect[] {
  return effects.filter((fx) => tick < fx.tick + EFFECT_TICKS[fx.kind]);
}

/** Deterministic pseudo-random in [0,1) from integers (for spark ray jitter). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 0x100000000;
}

export interface EffectDrawContext {
  ctx: CanvasRenderingContext2D;
  /** Engine x to logical canvas x. */
  toX: (x: number) => number;
  floorY: number;
  colors: readonly [string, string];
}

export function drawEffect(dc: EffectDrawContext, fx: Effect, tick: number): void {
  const { ctx } = dc;
  const age = tick - fx.tick;
  const life = EFFECT_TICKS[fx.kind];
  const t = age / life;
  const cx = dc.toX(fx.x);
  const cy = dc.floorY - fx.height;
  ctx.save();
  switch (fx.kind) {
    case 'spark': {
      const rays = 9;
      const reach = (70 + 80 * fx.strength) * (0.4 + 0.6 * Math.min(1, t * 3));
      ctx.globalAlpha = 1 - t;
      ctx.lineCap = 'round';
      for (let i = 0; i < rays; i++) {
        const jitter = hash01(fx.tick * 31 + i, Math.round(fx.x));
        const a = (i / rays) * Math.PI * 2 + jitter * 0.5;
        const len = reach * (0.55 + 0.45 * jitter);
        ctx.strokeStyle = i % 2 === 0 ? '#fff7d6' : dc.colors[fx.side];
        ctx.lineWidth = 12 * (1 - t) + 3;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * len * 0.25, cy + Math.sin(a) * len * 0.25);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 26 * (1 - t) + 6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'block': {
      // A bright shield arc in front of the defender, facing the attacker.
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = '#bfe9ff';
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      const r = 60 + 50 * t;
      const mid = fx.dir === 1 ? Math.PI : 0;
      ctx.beginPath();
      ctx.arc(cx + fx.dir * 40, cy, r, mid - 1.0, mid + 1.0);
      ctx.stroke();
      ctx.fillStyle = 'rgba(191, 233, 255, 0.35)';
      ctx.beginPath();
      ctx.arc(cx, cy, 34 * (1 - t) + 8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'dust': {
      ctx.fillStyle = '#c8b8a0';
      for (let i = 0; i < 7; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const spread = (30 + i * 22) * (0.3 + 0.7 * Math.sqrt(t));
        const rise = 26 * Math.sin(Math.PI * Math.min(1, t * 1.4)) * (1 + (i % 3) * 0.4);
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.beginPath();
        ctx.arc(cx + side * spread, dc.floorY - 10 - rise, 16 + i * 2 + 14 * t, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'clash': {
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 + 140 * t, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#ffd36b';
      ctx.beginPath();
      ctx.arc(cx, cy, 20 + 90 * t, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** Fireball: a glowing core with a short trail behind it, pulsing with the tick. */
export function drawProjectile(dc: EffectDrawContext, pr: Projectile, tick: number): void {
  if (!pr.active) return;
  const { ctx } = dc;
  const cx = dc.toX(pr.x);
  const cy = dc.floorY - 190;
  const dir = pr.vx >= 0 ? 1 : -1;
  const pulse = 1 + 0.12 * Math.sin(tick * 0.9);
  const color = dc.colors[pr.owner];
  ctx.save();
  for (let i = 4; i >= 1; i--) {
    ctx.globalAlpha = 0.18 * (5 - i);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx - dir * i * 26, cy, (44 - i * 7) * pulse, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 46 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fffbea';
  ctx.beginPath();
  ctx.arc(cx + dir * 6, cy, 24 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
