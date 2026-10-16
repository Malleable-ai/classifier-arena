import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import type { RenderSize } from '../../web/shell/render-layout.js';
import { FPS, frameRange, sourceFrames, type FrameSpec } from './args.js';

/**
 * The video pipeline behind `pnpm render` and `pnpm cut` (docs/architecture/core.md):
 *
 *   1. `vite build` once, in development mode (so render mode's dev-only `log=` and `fixture=1`
 *      work), into a temp folder; never `dist/`, never the web build.
 *   2. `vite preview` of that folder on a free loopback port.
 *   3. Headless Chromium (Playwright) opens a render-mode URL at exactly the video size, calls
 *      `window.renderFrame(n)` for each frame and reads the canvas back as PNG.
 *   4. The PNGs are piped to `ffmpeg -f image2pipe -r 60 -i - -c:v libx264 -pix_fmt yuv420p
 *      -movflags +faststart`. Clips concatenate with ffmpeg's concat demuxer.
 *
 * `close()` stops the browser and the preview server and deletes the temp build, including after
 * an error.
 */

/** The repo root (the folder with results/ and renders/). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Where a log from outside results/ is served from, next to the build. */
const STAGED_DIR = '__render';
/** Frames read back per round trip to the page. */
const BATCH = 6;
/** Seconds between progress lines. */
const PROGRESS_EVERY_S = 5;
/** H.264 quality (lower is better; 18 keeps small text crisp). */
const CRF = '18';

export const FFMPEG_MISSING =
  'ffmpeg is not on the PATH. Install it (macOS: brew install ffmpeg) and run again.';

/** Throws (FFMPEG_MISSING) unless `ffmpeg -version` runs. */
export function checkFfmpeg(): void {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error !== undefined || r.status !== 0) throw new Error(FFMPEG_MISSING);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => {
        ok(port);
      });
    });
  });
}

export interface RenderSession {
  readonly baseUrl: string;
  /** Serve a log file next to the build; returns the URL path render mode's `log=` takes. */
  stageLog(file: string, matchId: string): string;
  /** Render one clip to an MP4. */
  renderClip(job: ClipJob): Promise<ClipResult>;
  close(): Promise<void>;
}

export interface ClipJob {
  /** Shown in progress lines. */
  label: string;
  /** Render-mode path and query, e.g. `/fighter?match=<id>&render=1&size=1080x1080`. */
  path: string;
  size: RenderSize;
  from: FrameSpec | null;
  to: FrameSpec | null;
  speed: number;
  out: string;
}

export interface ClipResult {
  /** Source frames [from, to). */
  from: number;
  to: number;
  /** Frames in the video. */
  frames: number;
  out: string;
}

type Log = (line: string) => void;

/** Builds, starts the preview server and the browser. Close it in a `finally`. */
export async function openRenderSession(log: Log = console.log): Promise<RenderSession> {
  const outDir = mkdtempSync(join(tmpdir(), 'arena-render-'));
  // Set by the startup below; a holder so the cleanup sees what started.
  const live: { server: PreviewServer | null; browser: Browser | null } = {
    server: null,
    browser: null,
  };
  let startup: Promise<void> = Promise.resolve();
  let closing: Promise<void> | null = null;
  // Ctrl-C (or a kill) still stops the browser and the server and deletes the temp build. The
  // handler stays on until close, so a second Ctrl-C doesn't cut the cleanup short.
  const onSignal = (): void => {
    void close().finally(() => process.exit(130));
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      // A build in flight writes from native threads: let it finish before deleting its folder.
      await startup.catch(() => undefined);
      await live.browser?.close().catch(() => undefined);
      live.browser = null;
      await live.server?.close().catch(() => undefined);
      live.server = null;
      rmSync(outDir, { recursive: true, force: true });
    })();
    return closing;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  startup = (async () => {
    log('building the web app (development mode) …');
    // `import.meta.env.DEV` follows NODE_ENV; development keeps the dev-only render params.
    const nodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    try {
      await build({
        root: REPO_ROOT,
        mode: 'development',
        logLevel: 'warn',
        build: { outDir, emptyOutDir: true },
      });
    } finally {
      if (nodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = nodeEnv;
    }
    const port = await freePort();
    live.server = await preview({
      root: REPO_ROOT,
      mode: 'development',
      logLevel: 'warn',
      build: { outDir },
      preview: { host: '127.0.0.1', port, strictPort: true, open: false },
    });
    // Our signal handler closes the browser; Playwright's own would exit before the cleanup.
    live.browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
  })();
  try {
    await startup;
  } catch (e) {
    await close();
    throw e;
  }
  const { server, browser } = live;
  if (server === null || browser === null) throw new Error('render session closed while starting');
  const baseUrl = `http://127.0.0.1:${String(server.config.preview.port)}`;
  const b = browser;
  return {
    baseUrl,
    stageLog(file, matchId) {
      const dir = join(outDir, STAGED_DIR);
      mkdirSync(dir, { recursive: true });
      const name = `${matchId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
      copyFileSync(file, join(dir, name));
      return `/${STAGED_DIR}/${name}`;
    },
    renderClip: (job) => renderClip(b, baseUrl, job, log),
    close,
  };
}

/** Waits for render mode to be ready; throws the page's error message if it shows one. */
async function openRenderPage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(
    () => typeof window.renderFrame === 'function' || document.querySelector('[role="alert"]'),
    null,
    { timeout: 60_000 },
  );
  const alert = await page.evaluate(
    () => document.querySelector('[role="alert"]')?.textContent ?? null,
  );
  if (alert !== null) throw new Error(`render mode: ${alert}`);
}

function startFfmpeg(out: string): { proc: ChildProcessWithoutNullStreams; done: Promise<void> } {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const proc = spawn('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-r',
    String(FPS),
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-crf',
    CRF,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out,
  ]);
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  // A dead ffmpeg surfaces through `done`, not as an EPIPE on its stdin.
  proc.stdin.on('error', () => undefined);
  const done = new Promise<void>((ok, fail) => {
    proc.on('error', fail);
    proc.on('close', (code) => {
      if (code === 0) ok();
      else fail(new Error(`ffmpeg exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
  // Handled here so an early exit isn't an unhandled rejection; callers still await `done`.
  done.catch(() => undefined);
  return { proc, done };
}

function write(proc: ChildProcessWithoutNullStreams, chunk: Buffer): Promise<void> {
  return new Promise((ok, fail) => {
    proc.stdin.write(chunk, (err) => {
      if (err) fail(err);
    });
    if (proc.stdin.writableNeedDrain) proc.stdin.once('drain', ok);
    else ok();
  });
}

export function formatProgress(
  label: string,
  done: number,
  total: number,
  elapsedS: number,
): string {
  const fps = elapsedS > 0 ? done / elapsedS : 0;
  const left = fps > 0 ? Math.round((total - done) / fps) : null;
  const pct = Math.floor((100 * done) / Math.max(1, total));
  return (
    `  ${label}: ${String(done)}/${String(total)} frames (${String(pct)}%) · ` +
    `${fps.toFixed(0)} frames/s` +
    (left === null ? '' : ` · about ${String(left)} s left`)
  );
}

async function renderClip(
  browser: Browser,
  baseUrl: string,
  job: ClipJob,
  log: Log,
): Promise<ClipResult> {
  const page = await browser.newPage({
    viewport: { width: job.size.width, height: job.size.height },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let ffmpeg: ReturnType<typeof startFfmpeg> | null = null;
  try {
    await openRenderPage(page, baseUrl + job.path);
    const info = await page.evaluate(() => window.renderInfo ?? null);
    if (info === null) throw new Error('render mode set no window.renderInfo');
    if (info.width !== job.size.width || info.height !== job.size.height) {
      throw new Error(
        `render mode drew ${String(info.width)}x${String(info.height)}, not ` +
          `${String(job.size.width)}x${String(job.size.height)}`,
      );
    }
    const range = frameRange(info.frames, job.from, job.to);
    const frames = sourceFrames(range, job.speed);
    ffmpeg = startFfmpeg(job.out);
    const started = Date.now();
    let lastReport = started;
    for (let i = 0; i < frames.length; i += BATCH) {
      const batch = frames.slice(i, i + BATCH);
      const pngs = await page.evaluate((ns) => {
        const canvas = document.querySelector('canvas');
        if (canvas === null || window.renderFrame === undefined) throw new Error('no canvas');
        return ns.map((n) => {
          window.renderFrame?.(n);
          return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
        });
      }, batch);
      for (const b64 of pngs) await write(ffmpeg.proc, Buffer.from(b64, 'base64'));
      if (errors.length > 0) throw new Error(`page error: ${errors.join('; ')}`);
      const now = Date.now();
      if (now - lastReport >= PROGRESS_EVERY_S * 1000) {
        lastReport = now;
        log(formatProgress(job.label, i + batch.length, frames.length, (now - started) / 1000));
      }
    }
    ffmpeg.proc.stdin.end();
    await ffmpeg.done;
    ffmpeg = null;
    return { ...range, frames: frames.length, out: job.out };
  } finally {
    if (ffmpeg !== null) {
      ffmpeg.proc.kill('SIGKILL');
      await ffmpeg.done.catch(() => undefined);
    }
    await page.close().catch(() => undefined);
  }
}

/** Joins MP4 clips of the same size and codec into `out` (concat demuxer, no re-encode). */
export async function concatClips(parts: readonly string[], out: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'arena-concat-'));
  try {
    const list = join(dir, 'parts.txt');
    writeFileSync(
      list,
      parts.map((p) => `file '${resolve(p).replaceAll("'", "'\\''")}'`).join('\n') + '\n',
    );
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await new Promise<void>((ok, fail) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        out,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('error', fail);
      proc.on('close', (code) => {
        if (code === 0) ok();
        else fail(new Error(`ffmpeg concat exited with ${String(code)}: ${stderr.trim()}`));
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
