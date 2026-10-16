import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseMatchLog } from '../src/core/log/read.js';
import { RESULTS_DIR, matchesDir } from '../src/core/results/paths.js';
import { END_HOLD_FRAMES } from '../src/web/shell/frames.js';
import { replayCountText } from '../src/web/shell/leaderboard.js';

/**
 * Every committed log of every game replays to its recorded hash in the browser
 * (`pnpm test:determinism`), both on the game page (`/<game>?match=<id>`, the player) and in render
 * mode (`&render=1`, frame by frame). The replayed state is read from `window.__arena`
 * (docs/architecture/core.md), never guessed from pixels. Real-time games: a frame is a tick
 * (`__arena.tick`), and a finished match holds its last tick for END_HOLD_FRAMES more frames. Turn
 * games: the renderer makes its own frames, and `__arena.turn` is the turns played.
 */
const GAMES = [
  { id: 'fighter', realtime: true, homeLabel: /Fighter/ },
  { id: 'inbox', realtime: true, homeLabel: /Inbox Invaders/ },
  { id: 'clues', realtime: false, homeLabel: /Clue Clash/ },
] as const;

const GAMES_WITH_LOGS = readdirSync(RESULTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(matchesDir(d.name)))
  .map((d) => d.name)
  .sort();

const logsOf = (game: string) =>
  readdirSync(matchesDir(game))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => parseMatchLog(readFileSync(join(matchesDir(game), f), 'utf8')));

/** Ticks (real-time) or turns played on the page now. */
const played = () => window.__arena?.tick ?? window.__arena?.turn;

test('every game with committed logs is covered here', () => {
  expect(GAMES.map((g) => g.id).sort()).toEqual(GAMES_WITH_LOGS);
});

for (const game of GAMES) {
  const gameLogs = logsOf(game.id);

  test(`there is at least one committed ${game.id} log`, () => {
    expect(gameLogs.length).toBeGreaterThan(0);
  });

  for (const log of gameLogs) {
    const id = log.header.matchId;
    const end = log.matchEnd;

    test(`${id} replays to its match_end hash on /${game.id}?match=`, async ({ page }) => {
      expect(end).not.toBeNull();
      if (end === null) return;
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`/${game.id}?match=${encodeURIComponent(id)}`);
      await page.waitForFunction((g) => window.__arena?.game === g, game.id);
      await expect(page.locator('.match[aria-current="true"]')).toHaveAttribute('title', id);
      await page.evaluate(() => {
        window.__arena?.pause();
      });
      // Real-time: frame = tick. Turns: past the last frame (seek clamps).
      const last = game.realtime ? end.totalTicks : Number.MAX_SAFE_INTEGER;
      await page.evaluate((n) => {
        window.__arena?.seek(n);
      }, last);
      expect(await page.evaluate(played)).toBe(end.totalTicks);
      expect(await page.evaluate(() => window.__arena?.hash())).toBe(end.finalStateHash);
      // The panel reads the decisions resolved so far: the last one per seat is in the log. A
      // seat that never got an answer (a stalled match, excluded from the results) has none.
      const latest = await page.evaluate(() => window.__arena?.latestDecisions);
      for (const seat of [0, 1] as const) {
        const d = latest?.[seat];
        const answered = log.decisions.some((x) => x.seat === seat && x.error !== 'matchOver');
        if (!answered) continue;
        expect(d).toBeTruthy();
        expect(log.decisions).toContainEqual(d);
      }
      expect(errors).toEqual([]);
    });

    test(`${id} replays to its match_end hash in render mode`, async ({ page }) => {
      if (end === null) return;
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`/${game.id}?match=${encodeURIComponent(id)}&render=1`);
      await page.waitForFunction(() => typeof window.renderFrame === 'function');
      const info = await page.evaluate(() => window.renderInfo);
      expect(info).toMatchObject({ width: 1920, height: 1760 });
      // Real-time: a frame per tick, then the end hold. Turns: the renderer's own frames.
      if (game.realtime) expect(info?.frames).toBe(end.totalTicks + 1 + END_HOLD_FRAMES);
      else expect(info?.frames).toBeGreaterThan(end.totalTicks);
      const lastFrame = (info?.frames ?? 1) - 1;
      const reached = await page.evaluate((n) => window.renderFrame?.(n), lastFrame);
      expect(reached).toBe(lastFrame);
      expect(await page.evaluate(played)).toBe(end.totalTicks);
      expect(await page.evaluate(() => window.__arena?.hash())).toBe(end.finalStateHash);
      // Seeking back and forward again lands on the same state.
      await page.evaluate(() => window.renderFrame?.(0));
      expect(await page.evaluate(played)).toBe(0);
      await page.evaluate((n) => window.renderFrame?.(n), lastFrame);
      expect(await page.evaluate(() => window.__arena?.hash())).toBe(end.finalStateHash);
      expect(errors).toEqual([]);
    });
  }
}

// Video sizes (`size=<W>x<H>`): the canvas is exactly W × H pixels, and the replay is the same.
for (const game of GAMES) {
  for (const size of ['1080x1080', '1920x1080']) {
    test(`${game.id} render mode at ${size} draws a ${size} canvas and replays to the hash`, async ({
      page,
    }) => {
      const log = logsOf(game.id)[0];
      const end = log?.matchEnd;
      if (log === undefined || end === null || end === undefined) return;
      const [w, h] = size.split('x').map(Number);
      await page.setViewportSize({ width: w ?? 0, height: h ?? 0 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(
        `/${game.id}?match=${encodeURIComponent(log.header.matchId)}&render=1&size=${size}`,
      );
      await page.waitForFunction(() => typeof window.renderFrame === 'function');
      const info = await page.evaluate(() => window.renderInfo);
      expect(info).toMatchObject({ width: w, height: h });
      const canvas = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        return c === null ? null : { width: c.width, height: c.height, css: c.clientWidth };
      });
      expect(canvas).toEqual({ width: w, height: h, css: w });
      await page.evaluate((n) => window.renderFrame?.(n), (info?.frames ?? 1) - 1);
      expect(await page.evaluate(() => window.__arena?.hash())).toBe(end.finalStateHash);
      expect(errors).toEqual([]);
    });
  }
}

test('every video card renders at both sizes', async ({ page }) => {
  for (const card of ['intro', 'title-fighter', 'title-inbox', 'title-clues', 'outro']) {
    for (const size of ['1080x1080', '1920x1080']) {
      const [w, h] = size.split('x').map(Number);
      await page.goto(`/?card=${card}&render=1&size=${size}`);
      await page.waitForFunction(() => typeof window.renderFrame === 'function');
      const info = await page.evaluate(() => window.renderInfo);
      expect(info, `${card} ${size}`).toMatchObject({ width: w, height: h });
      expect(info?.frames).toBeGreaterThanOrEqual(90);
      expect(await page.evaluate((n) => window.renderFrame?.(n), 10_000)).toBe(
        (info?.frames ?? 0) - 1,
      );
    }
  }
  await page.goto('/?card=credits&render=1');
  await expect(page.getByRole('alert')).toContainText('credits');
});

test('an unknown match id shows an error instead of a match', async ({ page }) => {
  await page.goto('/fighter?match=does-not-exist&render=1');
  await expect(page.getByRole('alert')).toContainText('does-not-exist');
});

test('the leaderboard at / links each game with its replays, and an unknown game is not found', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Classifier Arena' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Games' });
  for (const game of GAMES) {
    const link = nav.getByRole('link', { name: game.homeLabel });
    await expect(link).toHaveAttribute('href', `/${game.id}`);
    // The page's own grammar: "no replays yet", "1 replay", "N replays".
    await expect(link).toContainText(replayCountText(logsOf(game.id).length));
  }
  await expect(
    page.getByText(/Overall = the mean of the per-game head-to-head win rates/),
  ).toBeVisible();
  await page.goto('/chess');
  await expect(page.getByRole('alert')).toContainText('Nothing at /chess');
});
