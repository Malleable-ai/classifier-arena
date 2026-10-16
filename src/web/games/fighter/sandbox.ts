import type { DecisionLine } from '../../../core/log/schema.js';
import { TICK_RATE } from '../../../games/fighter/engine/constants.js';
import { facingOf } from '../../../games/fighter/engine/fighter.js';
import { hashState } from '../../../games/fighter/engine/hash.js';
import { createMatch, step } from '../../../games/fighter/engine/sim.js';
import type { MatchState, MoveId, Side, StepEvent } from '../../../games/fighter/engine/types.js';
import { FIGHTER_QUESTION_KEY } from '../../../games/fighter/question.js';
import { installArenaDebug } from '../../debug.js';
import type { PlayerKind, SandboxRoute } from '../../route.js';
import { frameBase } from '../../shell/frames.js';
import { mountStageCanvas } from '../../shell/stage.js';
import { playerColors } from '../../shell/theme.js';
import { createRandomBot } from './bots/random.js';
import type { KeyState } from './keyboard.js';
import { attachKeys, clearKeys, createKeyState, nextHumanMove } from './keyboard.js';
import type { Effect } from './effects.js';
import { effectsFromEvents, pruneEffects } from './effects.js';
import { createFixedStepLoop } from './loop.js';
import { fighterRenderer, shownState, type FighterFrame } from './renderer.js';

/**
 * The fighter's dev sandbox (`/fighter?sandbox=1`): human or random on the left, random on the
 * right, no deciders, no log. `createSandbox` is DOM-free so tests run it headless;
 * `mountSandbox` wires keyboard, loop and the stage canvas.
 */

export interface Decision {
  move: MoveId;
  /** The tick the input was fed on. */
  tick: number;
}

export const RECENT_EVENTS_MAX = 20;

export interface SandboxOptions {
  seed: number;
  p1: PlayerKind;
}

export interface Sandbox {
  readonly seed: number;
  readonly players: readonly [PlayerKind, PlayerKind];
  readonly state: MatchState;
  readonly keys: KeyState;
  readonly lastDecision: readonly [Decision | null, Decision | null];
  readonly recentEvents: readonly StepEvent[];
  readonly effects: readonly Effect[];
  /** One engine tick: gather inputs, step, record. */
  tick(): StepEvent[];
  /** Fresh match on the same seed (same bot sequence). */
  restart(): void;
  hash(): string;
}

type Controller = (state: MatchState, side: Side) => MoveId | null;

export function createSandbox(opts: SandboxOptions): Sandbox {
  const players: [PlayerKind, PlayerKind] = [opts.p1, 'random'];
  const keys = createKeyState();
  let state: MatchState;
  let controllers: [Controller, Controller];
  let lastDecision: [Decision | null, Decision | null];
  let recentEvents: StepEvent[];
  let effects: Effect[];

  const makeController = (kind: PlayerKind, side: Side): Controller => {
    if (kind === 'human') {
      return (s, sd) => nextHumanMove(keys, s.fighters[sd], facingOf(s, sd));
    }
    const bot = createRandomBot(opts.seed, side);
    return (s) => bot.next(s.tick);
  };

  const reset = (): void => {
    state = createMatch(opts.seed);
    controllers = [makeController(players[0], 0), makeController(players[1], 1)];
    lastDecision = [null, null];
    recentEvents = [];
    effects = [];
    clearKeys(keys, true);
  };
  reset();

  return {
    seed: opts.seed,
    players,
    get state() {
      return state;
    },
    keys,
    get lastDecision() {
      return lastDecision;
    },
    get recentEvents() {
      return recentEvents;
    },
    get effects() {
      return effects;
    },
    tick() {
      const fighting = state.status === 'fighting';
      // Between rounds nobody decides (the engine would only drop the inputs).
      const inputs: [MoveId | null, MoveId | null] = fighting
        ? [controllers[0](state, 0), controllers[1](state, 1)]
        : [null, null];
      if (!fighting) clearKeys(keys, true);
      for (const side of [0, 1] as const) {
        const move = inputs[side];
        if (move !== null) lastDecision[side] = { move, tick: state.tick };
      }
      const prevProjectiles = state.projectiles.map((p) => ({ ...p }));
      const events = step(state, inputs);
      if (events.length > 0) {
        recentEvents = [...recentEvents, ...events].slice(-RECENT_EVENTS_MAX);
        effects = pruneEffects(
          [...effects, ...effectsFromEvents(events, state, prevProjectiles)],
          state.tick,
        );
      }
      return events;
    },
    restart() {
      reset();
    },
    hash() {
      return hashState(state);
    },
  };
}

const CONTROLS_HUMAN =
  'A / D walk · S block low · Shift block high · W jump-in · J jab · K heavy · L sweep · ' +
  'U uppercut · I fireball · O throw · no key held = high guard · R restart';
const CONTROLS_RANDOM = 'Random vs random · R restart';
/** Sandbox inputs kept for the panel (the oldest are dropped past this). */
const MAX_INPUTS = 600;

export function mountSandbox(root: HTMLElement, route: SandboxRoute): void {
  root.innerHTML = '';
  const stage = mountStageCanvas(root, fighterRenderer, 'Fight');
  const bar = document.createElement('div');
  bar.className = 'controls';
  const help = document.createElement('p');
  help.textContent = route.p1 === 'human' ? CONTROLS_HUMAN : CONTROLS_RANDOM;
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart';
  bar.append(help, restart);
  root.append(bar);

  const sandbox = createSandbox({ seed: route.seed, p1: route.p1 });
  const labels = [route.p1 === 'human' ? 'Human' : 'Random', 'Random'] as const;
  const players = [route.p1 === 'human' ? 'human' : 'random', 'random'] as const;
  const cadence = { kind: 'realtime', tickRate: TICK_RATE } as const;
  // The sandbox's inputs as decision lines (no latency, no probabilities, no cost) for the panels.
  let inputs: DecisionLine[] = [];
  const seqs: [number, number] = [0, 0];
  const recordInputs = (): void => {
    for (const side of [0, 1] as const) {
      const d = sandbox.lastDecision[side];
      if (d === null || d.tick !== sandbox.state.tick - 1) continue;
      inputs.push({
        type: 'decision',
        seat: side,
        seq: seqs[side]++,
        questionKey: FIGHTER_QUESTION_KEY,
        sentTick: d.tick,
        appliedTick: d.tick,
        latencyMs: 0,
        choice: d.move,
        probabilities: null,
        confidence: null,
        inputTokens: null,
        costUsd: 0,
        status: 'ok',
      });
    }
    if (inputs.length > MAX_INPUTS) inputs = inputs.slice(-MAX_INPUTS / 2);
  };
  const frameNow = (): FighterFrame => {
    const st = sandbox.state;
    return {
      ...frameBase({
        frame: st.tick,
        tick: st.tick,
        state: st,
        labels,
        players,
        cadence,
        decisions: inputs,
        events: [],
        ...(loop.paused ? { note: 'PAUSED' } : {}),
      }),
      effects: sandbox.effects,
      shown: shownState(st),
    };
  };

  const loop = createFixedStepLoop({
    onTick: () => {
      sandbox.tick();
      recordInputs();
    },
    onFrame: () => {
      stage.draw(frameNow(), { labels, colors: playerColors(players), cadence });
    },
  });

  const restartAll = (): void => {
    sandbox.restart();
    inputs = [];
    seqs[0] = 0;
    seqs[1] = 0;
  };
  restart.addEventListener('click', () => {
    restartAll();
    restart.blur();
  });
  attachKeys(window, sandbox.keys, {
    enabled: () => route.p1 === 'human',
    onKey: (e) => {
      if (e.code !== 'KeyR' || e.repeat) return false;
      restartAll();
      return true;
    },
  });

  if (import.meta.env.DEV) {
    installArenaDebug({
      game: fighterRenderer.gameId,
      cadence: 'realtime',
      frame: frameNow,
      hash: () => sandbox.hash(),
      controls: {
        get paused() {
          return loop.paused;
        },
        pause: () => {
          loop.pause();
        },
        resume: () => {
          loop.resume();
        },
        stepFrames: (n) => {
          loop.stepTicks(n);
        },
      },
    });
  }
  loop.start();
}
