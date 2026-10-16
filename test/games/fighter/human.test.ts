import { describe, expect, it } from 'vitest';
import { createMatch } from '../../../src/games/fighter/engine/sim.js';
import type { MoveId } from '../../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { createHumanDecider } from '../../../src/games/fighter/human.js';
import type { HumanInput } from '../../../src/games/fighter/human.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import { createFakeClock } from '../../core/util/fake-clock.js';

function fakeInput() {
  const listeners = new Set<(m: MoveId) => void>();
  const input: HumanInput = {
    onMove(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    input,
    listeners,
    press: (m: MoveId) => {
      for (const l of [...listeners]) l(m);
    },
  };
}

const view = buildView(createMatch(1), 0);
const question = buildQuestion(MOVE_IDS);

describe('human decider', () => {
  it('resolves with the next input and unsubscribes', async () => {
    const f = fakeInput();
    const d = createHumanDecider({ input: f.input, clock: createFakeClock() });
    expect(d.player).toBe('human');
    const p = d.decide(view, question, new AbortController().signal);
    f.press('sweep');
    expect(await p).toMatchObject({ choice: 'sweep', status: 'ok', costUsd: 0 });
    expect(f.listeners.size).toBe(0);
  });

  it('times out with no move on abort', async () => {
    const f = fakeInput();
    const ac = new AbortController();
    const p = createHumanDecider({ input: f.input, clock: createFakeClock() }).decide(
      view,
      question,
      ac.signal,
    );
    ac.abort();
    expect(await p).toMatchObject({ choice: null, status: 'timeout' });
    expect(f.listeners.size).toBe(0);
  });
});
