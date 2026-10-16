import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMatchLog } from '../core/log/read.js';
import { matchFile } from '../core/results/paths.js';
import { GAMES } from '../games/index.js';
import { cardNames } from '../web/cards/index.js';
import { formatRenderSize, type RenderSize } from '../web/shell/render-layout.js';
import {
  defaultOutPath,
  FPS,
  parseRenderArgs,
  RENDER_USAGE,
  UsageError,
  type RenderArgs,
} from './video/args.js';
import { checkFfmpeg, openRenderSession, REPO_ROOT, type RenderSession } from './video/pipeline.js';

/**
 * `pnpm render`: one match (any game) or one card to an MP4 at 60 fps, through headless Chromium
 * and ffmpeg (src/cli/video/pipeline.ts; docs/architecture/core.md).
 *
 *   pnpm render results/fighter/matches/<id>.jsonl --size 1920x1080
 *   pnpm render fighter/<id> --from 10s --to 25s
 *   pnpm render ~/somewhere/<id>.jsonl            any v2 log, served to the dev build for this run
 *   pnpm render --card outro --fixture            a card (intro, title-<game>, outro)
 *
 * Default size 1080x1080; default output `renders/<game>-<id>-<size>.mp4` (gitignored).
 */

export interface MatchRef {
  game: string;
  id: string;
  /** The log file on disk. */
  file: string;
  /** Under results/<game>/matches/ by its id, so the build bundles it (no `log=` needed). */
  committed: boolean;
}

/**
 * `<game>/<id>` names a log under results/; anything else is a path to a v2 log (`.jsonl`).
 * Reads the header to learn the game and match id.
 */
export function resolveMatchRef(ref: string, cwd = process.cwd(), root = REPO_ROOT): MatchRef {
  const asPath = resolve(cwd, ref);
  const isFile = existsSync(asPath) && statSync(asPath).isFile();
  const short = /^([a-z0-9_]+)\/([a-z0-9_-]+)$/.exec(ref);
  let file: string;
  if (isFile) file = asPath;
  else if (short !== null) {
    const [, game = '', id = ''] = short;
    if (!GAMES.some((g) => g.id === game)) throw new UsageError(`unknown game "${game}"`);
    file = resolve(root, matchFile(game, id));
    if (!existsSync(file))
      throw new UsageError(`no committed ${game} match "${id}" (${matchFile(game, id)})`);
  } else {
    throw new UsageError(`no such match log: ${ref}`);
  }
  const log = parseMatchLog(readFileSync(file, 'utf8'));
  const { game, matchId: id } = log.header;
  if (!GAMES.some((g) => g.id === game)) throw new UsageError(`${ref}: unknown game "${game}"`);
  return { game, id, file, committed: resolve(root, matchFile(game, id)) === file };
}

/** The render-mode path for a match (`log` when it isn't bundled) or a card. */
export function renderPath(
  target:
    | { kind: 'match'; game: string; id: string; log?: string }
    | { kind: 'card'; name: string; fixture: boolean },
  size: RenderSize,
): string {
  const q = new URLSearchParams();
  if (target.kind === 'card') {
    q.set('card', target.name);
    q.set('render', '1');
    q.set('size', formatRenderSize(size));
    if (target.fixture) q.set('fixture', '1');
    return `/?${q.toString()}`;
  }
  q.set('match', target.id);
  q.set('render', '1');
  q.set('size', formatRenderSize(size));
  if (target.log !== undefined) q.set('log', target.log);
  return `/${encodeURIComponent(target.game)}?${q.toString()}`;
}

/** Throws a UsageError naming every card unless `name` is one. */
export function checkCardName(name: string): void {
  const names = cardNames(GAMES.map((g) => g.id));
  if (!names.includes(name)) {
    throw new UsageError(`unknown card "${name}" (cards: ${names.join(', ')})`);
  }
}

async function renderOne(args: RenderArgs, session: RenderSession): Promise<void> {
  let path: string;
  let out: string;
  let label: string;
  if (args.target.kind === 'card') {
    checkCardName(args.target.name);
    path = renderPath({ kind: 'card', name: args.target.name, fixture: args.fixture }, args.size);
    out = args.out ?? resolve(REPO_ROOT, defaultOutPath(args.target, args.size));
    label = `card ${args.target.name}`;
  } else {
    const m = resolveMatchRef(args.target.ref);
    const log = m.committed ? undefined : session.stageLog(m.file, m.id);
    path = renderPath(
      { kind: 'match', game: m.game, id: m.id, ...(log === undefined ? {} : { log }) },
      args.size,
    );
    out = args.out ?? resolve(REPO_ROOT, defaultOutPath({ kind: 'match', ...m }, args.size));
    label = `${m.game} ${m.id}`;
  }
  const started = Date.now();
  const r = await session.renderClip({
    label,
    path,
    size: args.size,
    from: args.from,
    to: args.to,
    speed: args.speed,
    out,
  });
  const secs = (Date.now() - started) / 1000;
  console.log(
    `wrote ${relative(process.cwd(), r.out) || r.out}: frames ${String(r.from)}–${String(r.to)}, ` +
      `${(r.frames / FPS).toFixed(2)} s of video at ${formatRenderSize(args.size)}, ` +
      `rendered in ${secs.toFixed(1)} s`,
  );
}

export async function runRenderCli(argv: readonly string[]): Promise<void> {
  const args = parseRenderArgs(argv);
  // Fail fast, before building anything.
  if (args.target.kind === 'match') resolveMatchRef(args.target.ref);
  else checkCardName(args.target.name);
  checkFfmpeg();
  const session = await openRenderSession();
  try {
    await renderOne(args, session);
  } finally {
    await session.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  runRenderCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof UsageError) console.error(RENDER_USAGE);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
