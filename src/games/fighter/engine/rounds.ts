import { createFighter } from './fighter.js';
import type { MatchState, RoundEndReason, Side, StepEvent } from './types.js';

/**
 * Rounds and match end. Called from sim.ts's `step`; see the step order there.
 *
 * Rules:
 * - KO: a fighter at health <= 0 loses the round. Both at <= 0 on the same tick is a double KO,
 *   a drawn round.
 * - Timeout: when `roundTick === config.roundTicks`, higher health wins; equal health is a drawn
 *   round. A KO on the last tick counts as a KO, not a timeout.
 * - Drawn rounds don't count toward `roundsToWin`. The first fighter to `roundsToWin` wins the
 *   match. If `maxRounds` rounds have been played without a match winner, the match is a draw.
 * - Between rounds: status 'roundOver' for `config.roundPauseTicks` ticks (inputs are dropped by
 *   sim.ts), then a fresh round. A pause of 0 starts the next round on the same tick.
 */

/**
 * Called by `step` at the end of every fighting tick, after the clock advanced (so
 * `roundTick === state.config.roundTicks` means time is up). Detects KO / double KO / timeout,
 * pushes a RoundResult, bumps `roundsWon`, emits `roundEnd`, drops any waiting input (`dropped`
 * 'notFighting'), then either ends the match
 * (status 'matchOver', `winner`, `matchEnd`) or starts the between-round pause.
 */
export function checkRoundEnd(state: MatchState, events: StepEvent[]): void {
  if (state.status !== 'fighting') return;
  const [a, b] = state.fighters;
  const koA = a.health <= 0;
  const koB = b.health <= 0;

  let winner: Side | 'draw';
  let reason: RoundEndReason;
  if (koA && koB) {
    winner = 'draw';
    reason = 'doubleKo';
  } else if (koA || koB) {
    winner = koA ? 1 : 0;
    reason = 'ko';
  } else if (state.roundTick >= state.config.roundTicks) {
    winner = a.health === b.health ? 'draw' : a.health > b.health ? 0 : 1;
    reason = 'timeout';
  } else {
    return;
  }

  state.roundResults.push({
    round: state.round,
    winner,
    reason,
    endTick: state.tick,
    health: [a.health, b.health],
  });
  if (winner !== 'draw') state.fighters[winner].roundsWon += 1;
  events.push({ type: 'roundEnd', tick: state.tick, round: state.round, winner, reason });
  dropWaitingInputs(state, events);

  let matchWinner: Side | 'draw' | null = null;
  if (winner !== 'draw' && state.fighters[winner].roundsWon >= state.config.roundsToWin) {
    matchWinner = winner;
  } else if (state.roundResults.length >= state.config.maxRounds) {
    matchWinner = 'draw';
  }

  if (matchWinner !== null) {
    state.status = 'matchOver';
    state.winner = matchWinner;
    state.pauseTicksLeft = 0;
    events.push({ type: 'matchEnd', tick: state.tick, winner: matchWinner });
    return;
  }

  state.status = 'roundOver';
  state.pauseTicksLeft = state.config.roundPauseTicks;
  if (state.pauseTicksLeft <= 0) startNextRound(state);
}

/** The round is over: anything still waiting (buffered one-shot, pending hold) is dropped. */
function dropWaitingInputs(state: MatchState, events: StepEvent[]): void {
  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    const waiting = [f.buffered?.move ?? null, f.pendingHold];
    for (const move of waiting) {
      if (move === null) continue;
      events.push({
        type: 'dropped',
        tick: state.tick,
        fighter: side,
        move,
        reason: 'notFighting',
      });
    }
    f.buffered = null;
    f.pendingHold = null;
  }
}

/**
 * Called by `step` instead of the fighting steps on every tick while status === 'roundOver'.
 * Counts `pauseTicksLeft` down; the tick it reaches 0 the next round starts, so the pause lasts
 * exactly `config.roundPauseTicks` ticks and the first fighting tick of the next round is the
 * one after that.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the step contract; no pause events yet.
export function updateRoundPause(state: MatchState, _events: StepEvent[]): void {
  if (state.status !== 'roundOver') return;
  state.pauseTicksLeft -= 1;
  if (state.pauseTicksLeft <= 0) startNextRound(state);
}

/**
 * Fresh fighters at their start positions (health, cooldowns, buffer, pending hold, lastMoves,
 * phases all reset; roundsWon kept), no projectiles, round clock at 0. The PRNG carries on.
 */
function startNextRound(state: MatchState): void {
  for (const side of [0, 1] as const) {
    const roundsWon = state.fighters[side].roundsWon;
    const fresh = createFighter(side, state.config);
    fresh.roundsWon = roundsWon;
    state.fighters[side] = fresh;
  }
  state.projectiles = [];
  state.round += 1;
  state.roundTick = 0;
  state.pauseTicksLeft = 0;
  state.status = 'fighting';
}
