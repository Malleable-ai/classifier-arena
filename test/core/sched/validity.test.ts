import { describe, expect, it } from 'vitest';
import { REFUSAL_ERROR, type Seat } from '../../../src/core/classifier/types.js';
import type { DecisionLine } from '../../../src/core/log/schema.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';
import {
  MATCH_OVER,
  MAX_MISS_RATE,
  REALTIME_STALL_MS,
  TURN_STALL_SLACK_MS,
  decisionCount,
  droppedRate,
  failureRate,
  invalidReasonText,
  invalidReasons,
  invalidReasonsOfLog,
  isFailure,
  isProviderSeat,
  isRefusal,
  isValidLog,
  isValidMatch,
  logStalls,
  missRate,
  refusalRate,
  stallSlackMs,
  timeoutRate,
} from '../../../src/core/sched/validity.js';

function lines(
  seat: Seat,
  total: number,
  misses: number,
  status: 'timeout' | 'error' | 'refusal' = 'timeout',
) {
  return Array.from({ length: total }, (_, i): DecisionLine => ({
    type: 'decision',
    seat,
    seq: i,
    questionKey: 'k',
    sentTick: i,
    appliedTick: i < misses ? null : i + 1,
    latencyMs: 10,
    choice: i < misses ? null : 'a',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: i < misses ? status : 'ok',
    ...(i < misses && status === 'refusal' ? { error: REFUSAL_ERROR } : {}),
  }));
}

/** `lines` whose first `n` are refusals the way logs wrote them before the `refusal` status. */
function legacyRefusals(seat: Seat, total: number, n: number): DecisionLine[] {
  return lines(seat, total, n, 'error').map((l, i) => (i < n ? { ...l, error: REFUSAL_ERROR } : l));
}

describe('validity', () => {
  it('allows at most 2% misses per seat', () => {
    expect(MAX_MISS_RATE).toBe(0.02);
  });

  it('is invalid at 2.1% transport errors and valid at 2.0%, per seat, in either cadence', () => {
    for (const cadence of ['realtime', 'turns'] as const) {
      expect(isValidMatch([...lines(0, 1000, 21, 'error'), ...lines(1, 1000, 0)], cadence)).toBe(
        false,
      );
      expect(
        isValidMatch([...lines(0, 1000, 20, 'error'), ...lines(1, 1000, 20, 'error')], cadence),
      ).toBe(true);
      expect(isValidMatch([...lines(0, 1000, 0), ...lines(1, 1000, 21, 'error')], cadence)).toBe(
        false,
      );
    }
  });

  it('real-time: a match where a seat times out a lot stays valid (timeouts never count)', () => {
    // The slower model timed out on 30% of its requests: those are its own misses (no move),
    // and the match is scored, not rerun (approved 2026-10-16).
    const slow = [...lines(0, 400, 0), ...lines(1, 200, 60)];
    expect(missRate(slow, 1)).toBeCloseTo(0.3);
    expect(timeoutRate(slow, 1)).toBeCloseTo(0.3);
    expect(isValidMatch(slow, 'realtime')).toBe(true);
    expect(invalidReasons(slow, 'realtime', { providerSeats: [true, true] })).toEqual([]);
    // Every request timing out still leaves it valid: the seat simply made no moves.
    expect(isValidMatch([...lines(0, 50, 0), ...lines(1, 50, 50)], 'realtime')).toBe(true);
    // Timeouts beside errors: only the errors count. 2 errors and 40 timeouts in 100 decisions
    // is valid (2% errors); one more error (3 in 101) is not.
    const mixed = [...lines(0, 60, 2, 'error'), ...lines(0, 40, 40), ...lines(1, 10, 0)];
    expect(missRate(mixed, 0)).toBeCloseTo(0.42);
    expect(isValidMatch(mixed, 'realtime')).toBe(true);
    expect(isValidMatch([...mixed, ...lines(0, 1, 1, 'error')], 'realtime')).toBe(false);
  });

  it('turns: does not count timeouts toward validity, only transport failures (errors)', () => {
    // One timeout in 48 asks per seat (2.08%): a scored 0, but the match stays valid.
    const timeouts = [...lines(0, 48, 1), ...lines(1, 48, 1)];
    expect(isValidMatch(timeouts, 'turns')).toBe(true);
    expect(isValidMatch(timeouts, 'realtime')).toBe(true);
    // Even every ask timing out leaves a turn match valid: the seat simply scores nothing.
    expect(isValidMatch([...lines(0, 48, 48), ...lines(1, 48, 0)], 'turns')).toBe(true);
    // One error in 48 is over 2%: invalid, for either seat.
    expect(isValidMatch([...lines(0, 48, 0), ...lines(1, 48, 1, 'error')], 'turns')).toBe(false);
    expect(isValidMatch([...lines(0, 48, 1, 'error'), ...lines(1, 48, 0)], 'turns')).toBe(false);
    // The same 2% bound on errors: 20 in 1,000 is valid, 21 is not.
    expect(isValidMatch([...lines(0, 1000, 20, 'error'), ...lines(1, 10, 0)], 'turns')).toBe(true);
    expect(isValidMatch([...lines(0, 1000, 21, 'error'), ...lines(1, 10, 0)], 'turns')).toBe(false);
  });

  it('splits misses into timeouts and failures, over every decision', () => {
    const mixed = [...lines(0, 10, 2), ...lines(0, 10, 3, 'error').map((l) => ({ ...l }))];
    expect(missRate(mixed, 0)).toBeCloseTo(5 / 20);
    expect(timeoutRate(mixed, 0)).toBeCloseTo(2 / 20);
    expect(failureRate(mixed, 0)).toBeCloseTo(3 / 20);
    expect(timeoutRate([], 0)).toBe(0);
    expect(failureRate([], 1)).toBe(0);
  });

  it('counts errors as misses like timeouts', () => {
    expect(missRate(lines(1, 10, 3, 'error'), 1)).toBeCloseTo(0.3);
    expect(missRate(lines(1, 10, 3, 'error'), 0)).toBe(0);
  });

  it('does not count dropped as a miss, reports it separately, and ignores post-match answers', () => {
    const l = lines(0, 10, 0);
    const first = l[0];
    if (!first) throw new Error('no line');
    l[0] = { ...first, status: 'dropped', error: 'dropped: stale' };
    l.push({ ...first, seq: 10, status: 'dropped', appliedTick: null, error: MATCH_OVER });
    expect(missRate(l, 0)).toBe(0);
    expect(droppedRate(l, 0)).toBeCloseTo(0.1);
    expect(decisionCount(l, 0)).toBe(10);
    l[1] = { ...first, seq: 1, status: 'timeout', appliedTick: null, choice: null };
    expect(missRate(l, 0)).toBeCloseTo(0.1);
    expect(missRate([], 0)).toBe(0);
    expect(droppedRate([], 1)).toBe(0);
  });

  it('never counts refusals toward validity, in either cadence, for either seat', () => {
    // Half of seat 0's decisions and a tenth of seat 1's are refusals: still valid.
    const refused = [...lines(0, 100, 50, 'refusal'), ...lines(1, 100, 10, 'refusal')];
    for (const cadence of ['realtime', 'turns'] as const) {
      expect(isValidMatch(refused, cadence)).toBe(true);
    }
    expect(missRate(refused, 0)).toBe(0);
    expect(failureRate(refused, 0)).toBe(0);
    expect(refusalRate(refused, 0)).toBeCloseTo(0.5);
    expect(refusalRate(refused, 1)).toBeCloseTo(0.1);
    expect(refusalRate([], 0)).toBe(0);
  });

  it('reads a refusal in the older form (error + REFUSAL_ERROR) as a refusal, nothing else', () => {
    const old = [...legacyRefusals(0, 100, 11), ...lines(1, 100, 0)];
    expect(old.filter((l) => isRefusal(l))).toHaveLength(11);
    expect(old.some((l) => isFailure(l))).toBe(false);
    expect(refusalRate(old, 0)).toBeCloseTo(0.11);
    expect(missRate(old, 0)).toBe(0);
    expect(isValidMatch(old, 'realtime')).toBe(true);
    expect(isValidMatch(old, 'turns')).toBe(true);
    // Any other error is a transport failure.
    const near = lines(0, 10, 1, 'error').map((l, i) =>
      i === 0 ? { ...l, error: `${REFUSAL_ERROR} ` } : l,
    );
    expect(isRefusal(near[0] as DecisionLine)).toBe(false);
    expect(failureRate(near, 0)).toBeCloseTo(0.1);
  });

  it('still counts transport errors over 2% beside any number of refusals', () => {
    const mixed = [
      ...lines(0, 100, 3, 'error'),
      ...lines(0, 100, 40, 'refusal').map((l) => ({ ...l, seq: l.seq + 100 })),
      ...lines(1, 10, 0),
    ];
    expect(missRate(mixed, 0)).toBeCloseTo(3 / 200);
    expect(isValidMatch(mixed, 'realtime')).toBe(true);
    const over = [...mixed, ...lines(0, 2, 2, 'error')];
    // 5 errors in 202 decisions: 2.5%, over the limit; the 40 refusals still don't count.
    expect(failureRate(over, 0)).toBeCloseTo(5 / 202);
    expect(isValidMatch(over, 'realtime')).toBe(false);
    expect(isValidMatch(over, 'turns')).toBe(false);
  });

  it('isValidLog re-scores a log with the same rule, whatever its cadence', () => {
    // One timeout in 48 (no count) and refusals (no count); then one error (counts).
    const decisions = [...lines(0, 48, 1), ...lines(1, 48, 5, 'refusal')];
    const turns = { header: { cadence: { kind: 'turns' as const } }, decisions };
    const realtime = { header: { cadence: { kind: 'realtime' as const } }, decisions };
    expect(isValidLog(turns, NO_EXCLUSIONS)).toBe(true);
    expect(isValidLog(realtime, NO_EXCLUSIONS)).toBe(true);
    expect(isValidLog(turns, NO_EXCLUSIONS)).toBe(isValidMatch(decisions, 'turns'));
    for (const log of [turns, realtime]) {
      const withError = { ...log, decisions: [...decisions, ...lines(1, 1, 1, 'error')] };
      expect(isValidLog(withError, NO_EXCLUSIONS)).toBe(false);
      expect(invalidReasonsOfLog(withError, NO_EXCLUSIONS)).toEqual([
        { kind: 'failures', seat: 1, rate: 1 / 49 },
      ]);
    }
  });

  it('is invalid with any recorded stall, in either cadence, whatever the decisions say', () => {
    const clean = [...lines(0, 100, 0), ...lines(1, 100, 0)];
    const stalls = [{ atTick: 120, gapMs: 5000 }];
    for (const cadence of ['realtime', 'turns'] as const) {
      expect(isValidMatch(clean, cadence)).toBe(true);
      expect(isValidMatch(clean, cadence, { stalls: [] })).toBe(true);
      expect(isValidMatch(clean, cadence, { stalls })).toBe(false);
      const header = { cadence: { kind: cadence } };
      expect(isValidLog({ header, decisions: clean, matchEnd: { stalls } }, NO_EXCLUSIONS)).toBe(
        false,
      );
      // Older logs have no stalls field: re-scored as before.
      expect(isValidLog({ header, decisions: clean, matchEnd: {} }, NO_EXCLUSIONS)).toBe(true);
      expect(isValidLog({ header, decisions: clean, matchEnd: null }, NO_EXCLUSIONS)).toBe(true);
    }
  });

  it('real-time: is invalid when a provider seat made no decisions (0 misses of 0 is not valid)', () => {
    const onlySeat1 = lines(1, 50, 0);
    expect(decisionCount(onlySeat1, 0)).toBe(0);
    expect(isValidMatch(onlySeat1, 'realtime')).toBe(true); // no seat named: the old rule
    expect(isValidMatch(onlySeat1, 'realtime', { providerSeats: [true, true] })).toBe(false);
    // A baseline seat with no decisions doesn't trigger it, nor does a turn game.
    expect(isValidMatch(onlySeat1, 'realtime', { providerSeats: [false, true] })).toBe(true);
    expect(isValidMatch(onlySeat1, 'turns', { providerSeats: [true, true] })).toBe(true);
    // Lines cancelled at match end are not decisions.
    const cancelled = lines(0, 3, 3, 'error').map((l) => ({ ...l, error: MATCH_OVER }));
    const providers = [true, false] as const;
    expect(
      isValidMatch([...cancelled, ...onlySeat1], 'realtime', { providerSeats: providers }),
    ).toBe(false);
    // isValidLog takes the provider seats from the header (a seat with a format).
    const provider = { format: 'systemone' };
    const baseline = { format: null };
    const header = { cadence: { kind: 'realtime' as const }, seats: [provider, baseline] as const };
    expect(isValidLog({ header, decisions: onlySeat1 }, NO_EXCLUSIONS)).toBe(false);
    const swapped = { ...header, seats: [baseline, provider] as const };
    expect(isValidLog({ header: swapped, decisions: onlySeat1 }, NO_EXCLUSIONS)).toBe(true);
    expect(isProviderSeat(provider)).toBe(true);
    expect(isProviderSeat(baseline)).toBe(false);
  });

  it('isValidLog: a match on the exclusion list is never valid', () => {
    const decisions = [...lines(0, 100, 0), ...lines(1, 100, 0)];
    const header = { cadence: { kind: 'realtime' as const }, matchId: 'm-1' };
    expect(isValidLog({ header, decisions }, NO_EXCLUSIONS)).toBe(true);
    expect(isValidLog({ header, decisions }, new Map([['m-1', 'machine slept']]))).toBe(false);
    expect(isValidLog({ header, decisions }, new Map([['m-2', 'machine slept']]))).toBe(true);
  });

  it('ignores lines that are not decisions', () => {
    expect(
      decisionCount(
        [{ type: 'event', tick: 0, game: { kind: 'x' } }, ...lines(0, 2, 0), ...lines(1, 3, 0)],
        1,
      ),
    ).toBe(3);
  });

  it('stalls from the log: a line longer than the timeout plus the slack (any status)', () => {
    expect(stallSlackMs('realtime')).toBe(REALTIME_STALL_MS);
    expect(stallSlackMs('turns')).toBe(TURN_STALL_SLACK_MS);
    const base = [...lines(0, 50, 0), ...lines(1, 50, 0)];
    const at = (over: Partial<DecisionLine>): DecisionLine => ({
      ...(base[0] as DecisionLine),
      seq: 99,
      sentTick: 8748,
      appliedTick: null,
      choice: null,
      ...over,
    });
    // The machine slept: both seats' last requests ended the match after ~15 minutes.
    const slept = [
      ...base,
      at({ seat: 0, status: 'dropped', error: MATCH_OVER, latencyMs: 923_561.4 }),
      at({ seat: 1, status: 'dropped', error: MATCH_OVER, latencyMs: 923_562 }),
    ];
    expect(logStalls(slept, 'realtime', 1000)).toEqual([
      { atTick: 8748, gapMs: 922_561 },
      { atTick: 8748, gapMs: 922_562 },
    ]);
    // Real time: up to the timeout plus 250 ms is not a stall; past it is.
    const edge = (latencyMs: number) => [...base, at({ status: 'timeout', latencyMs })];
    expect(logStalls(edge(1250), 'realtime', 1000)).toEqual([]);
    expect(logStalls(edge(1250.1), 'realtime', 1000)).toEqual([{ atTick: 8748, gapMs: 250 }]);
    // Turns use the turn rule's 3 s slack.
    expect(logStalls(edge(4000), 'turns', 1000)).toEqual([]);
    expect(logStalls(edge(4000.1), 'turns', 1000)).toHaveLength(1);
    expect(logStalls(edge(1250.1), 'turns', 1000)).toEqual([]);
    for (const cadence of ['realtime', 'turns'] as const) {
      // Checked only with the header's timeout; reported once, as a stall from the log.
      expect(isValidMatch(slept, cadence)).toBe(true);
      expect(isValidMatch(slept, cadence, { timeoutMs: 1000 })).toBe(false);
      const reasons = invalidReasons(slept, cadence, { timeoutMs: 1000 });
      expect(reasons.map((r) => r.kind)).toEqual(['stall']);
      expect(reasons[0]).toMatchObject({ kind: 'stall', from: 'log' });
      // A measured stall is reported instead, once.
      const measured = invalidReasons(slept, cadence, {
        timeoutMs: 1000,
        stalls: [{ atTick: 8748, gapMs: 920_000 }],
      });
      expect(measured).toEqual([
        { kind: 'stall', from: 'scheduler', stalls: [{ atTick: 8748, gapMs: 920_000 }] },
      ]);
      // isValidLog takes the timeout from the header.
      const header = { cadence: { kind: cadence }, timing: { timeoutMs: 1000 } };
      expect(isValidLog({ header, decisions: slept, matchEnd: {} }, NO_EXCLUSIONS)).toBe(false);
      expect(isValidLog({ header, decisions: base, matchEnd: {} }, NO_EXCLUSIONS)).toBe(true);
      expect(
        isValidLog({ header: { cadence: { kind: cadence } }, decisions: slept }, NO_EXCLUSIONS),
      ).toBe(true);
    }
  });

  it('lists every reason, and says each in words', () => {
    const decisions = [...lines(0, 10, 1, 'error')];
    const reasons = invalidReasons(decisions, 'realtime', {
      providerSeats: [true, true],
      stalls: [{ atTick: 3, gapMs: 400 }],
    });
    expect(reasons).toEqual([
      { kind: 'stall', from: 'scheduler', stalls: [{ atTick: 3, gapMs: 400 }] },
      { kind: 'noDecisions', seat: 1 },
      { kind: 'failures', seat: 0, rate: 0.1 },
    ]);
    expect(reasons.map((r) => invalidReasonText(r))).toEqual([
      'stall',
      'seat 1 made no decisions',
      'seat 0 had transport errors on 10.0% of its decisions (limit 2%)',
    ]);
    expect(invalidReasonText(reasons[2] as (typeof reasons)[number], ['Jev', 'OpenAI'])).toBe(
      'Jev (seat 0) had transport errors on 10.0% of its decisions (limit 2%)',
    );
    expect(invalidReasonText({ kind: 'stall', from: 'log', stalls: [] })).toBe(
      'stall (from the log)',
    );
    expect(invalidReasonText({ kind: 'excluded', reason: 'slept' })).toBe(
      'excluded by hand: slept',
    );
    const header = { cadence: { kind: 'realtime' as const }, matchId: 'm-1' };
    expect(invalidReasonsOfLog({ header, decisions }, new Map([['m-1', 'machine slept']]))).toEqual(
      [{ kind: 'excluded', reason: 'machine slept' }],
    );
  });
});
