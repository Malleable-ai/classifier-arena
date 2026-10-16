import { parseMatchLog, type MatchLog } from '../core/log/read.js';
import { rendererFor } from './games/index.js';
import { loadCommittedLog } from './logs.js';
import type { RenderRoute } from './route.js';
import { exposeReplayDebug, mountReplayStage, showError } from './shell/player.js';
import { stageSize } from './shell/stage.js';

/**
 * Render mode (`/<game>?match=<id>&render=1`): loads one committed log, draws frame 0 and exposes
 * `window.renderFrame(n)`, which moves to frame n and draws it synchronously, and
 * `window.renderInfo = { frames, width, height }`. No clock, no loop: the caller (Playwright,
 * `pnpm render`) drives every frame. For a real-time game a frame is a tick.
 *
 * - Without `size`: the logical canvas, stage plus the full panel (the fighter's 1920 × 1760),
 *   as large as fits the window and centred in it.
 * - With `size=<W>x<H>`: a canvas of exactly W × H pixels in the video layout
 *   (shell/render-layout.ts), the size `renderInfo` reports. `pnpm render` sets the viewport to it.
 * - `log=<url>`, dev builds only: fetch the log from that URL instead of the committed ones, so
 *   `pnpm render` can render any v2 log (it builds in development mode and serves the file next
 *   to the build). `vite build` and `build:web` drop this branch.
 */

async function fetchLog(url: string, game: string, matchId: string): Promise<MatchLog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch the match log at ${url} (${String(res.status)})`);
  const log = parseMatchLog(await res.text());
  if (log.header.game !== game) {
    throw new Error(`the log at ${url} is a ${log.header.game} log, not ${game}`);
  }
  if (log.header.matchId !== matchId) {
    throw new Error(`the log at ${url} is match ${log.header.matchId}, not ${matchId}`);
  }
  return log;
}

export async function mountRenderMode(root: HTMLElement, route: RenderRoute): Promise<void> {
  const renderer = rendererFor(route.game);
  if (renderer === null) {
    showError(root, `No renderer for ${route.game} yet.`);
    return;
  }
  let log: MatchLog;
  try {
    log =
      import.meta.env.DEV && route.log !== undefined
        ? await fetchLog(route.log, route.game, route.matchId)
        : await loadCommittedLog(route.game, route.matchId);
  } catch (e) {
    showError(root, e instanceof Error ? e.message : String(e));
    return;
  }
  root.innerHTML = '';
  root.className = route.size === undefined ? 'render-fit' : 'render-root';
  const rs = mountReplayStage(root, log, renderer, route.size);
  exposeReplayDebug(log, rs, {
    paused: true,
    pause() {},
    resume() {},
    stepFrames(n) {
      rs.renderFrame(rs.current.frame + n);
    },
    seek(n) {
      rs.renderFrame(n);
    },
  });
  const { width, height } = route.size ?? stageSize(renderer);
  window.renderInfo = { frames: rs.timeline.frames, width, height };
  window.renderFrame = (n) => rs.renderFrame(n);
}
