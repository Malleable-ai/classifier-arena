import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gameBaselines } from '../core/classifier/baselines.js';
import type { MatchLog } from '../core/log/read.js';
import { buildResultsIndex } from '../core/replay/results-index.js';
import { GAMES } from '../games/index.js';
import { cardFor } from '../web/cards/index.js';
import { formatRenderSize } from '../web/shell/render-layout.js';
import { readAllMatchLogs, readExclusions, readFeatured } from './index-results.js';
import { renderPath } from './render.js';
import { activityOf } from './video/activity.js';
import { FPS, UsageError } from './video/args.js';
import {
  checkFfmpeg,
  concatClips,
  openRenderSession,
  REPO_ROOT,
  type RenderSession,
} from './video/pipeline.js';
import {
  chooseMatch,
  CUT_SPECS,
  cutPieces,
  cutSeconds,
  pieceFrames,
  type CutKind,
  type CutPiece,
  type GameSegment,
} from './video/plan.js';
import { pickWindow } from './video/segments.js';

/**
 * `pnpm cut [--square] [--wide] [--dry-run]`: the LinkedIn cuts (docs/architecture/core.md).
 *
 * For each game it takes the featured match (results/featured.json), else the first valid
 * head-to-head, else (development, before the published runs) the first committed log, and cuts
 * its end: about 13 s per game for the square cut and 26 s for the wide one, ending with the
 * match's result banner (the end hold); Clue Clash windows hold whole words. It renders
 * intro → (title → segment) × 3 → outro through the render pipeline and joins them with ffmpeg's
 * concat demuxer into `renders/arena-square.mp4` (1080 × 1080, 45–60 s) and
 * `renders/arena-wide.mp4` (1920 × 1080). Neither flag: both cuts. `--dry-run` prints the plan
 * without rendering.
 */

export const CUT_USAGE = 'usage: pnpm cut [--square] [--wide] [--dry-run]';
/** Clips rendered at once (one browser page and one ffmpeg each). */
const JOBS = 3;

export interface CutArgs {
  kinds: CutKind[];
  dryRun: boolean;
}

export function parseCutArgs(argv: readonly string[]): CutArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        square: { type: 'boolean' },
        wide: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const kinds: CutKind[] = [];
  if (values.square === true) kinds.push('square');
  if (values.wide === true) kinds.push('wide');
  return {
    kinds: kinds.length === 0 ? ['square', 'wide'] : kinds,
    dryRun: values['dry-run'] === true,
  };
}

const WHY: Record<GameSegment['choice']['why'], string> = {
  featured: 'featured',
  'head-to-head': 'first head-to-head (none featured)',
  any: 'DEVELOPMENT ONLY: no featured match or head-to-head yet',
};

/** Each game's match and its activity, read once for both cuts. */
function chooseMatches(): { game: string; log: MatchLog; why: GameSegment['choice']['why'] }[] {
  const logs = readAllMatchLogs(REPO_ROOT);
  const featured = readFeatured(REPO_ROOT);
  const excluded = readExclusions(REPO_ROOT, logs);
  const index = buildResultsIndex(logs, { featured: {}, excluded }).matches;
  return GAMES.map((game) => {
    const ids = logs.filter((l) => l.header.game === game.id).map((l) => l.header.matchId);
    const baselines = new Set(gameBaselines(game).map((b) => b.id));
    const choice = chooseMatch(game.id, baselines, featured, index, ids);
    if (choice === null) throw new Error(`${game.id}: no committed match logs to cut from`);
    const log = logs.find((l) => l.header.matchId === choice.id);
    if (log === undefined) throw new Error(`${game.id}: log ${choice.id} not found`);
    return { game: game.id, log, why: choice.why };
  });
}

/** "Jev (TypeSafe) wins 2–1", "draw 33–33", or that the log has no result. */
export function resultOf(log: MatchLog): string {
  const end = log.matchEnd;
  if (end === null) return 'no result (the log stops early)';
  const [a, b] = end.scores;
  if (end.winner === 'draw' || end.winner === null) return `draw ${String(a)}–${String(b)}`;
  const w = end.winner;
  const score = w === 0 ? `${String(a)}–${String(b)}` : `${String(b)}–${String(a)}`;
  return `${log.header.seats[w].label} wins ${score}${a === b ? ' on the tiebreak' : ''}`;
}

function describe(p: CutPiece, results: ReadonlyMap<string, string>): string {
  const secs = `${(pieceFrames(p) / FPS).toFixed(2)} s`;
  if (p.kind === 'card') return `card ${p.name} (${secs})`;
  return (
    `${p.game} ${p.id} frames ${String(p.window.from)}–${String(p.window.to)} (${secs}, ` +
    `ends on the result: ${results.get(p.id) ?? '?'}; ${p.window.score.toFixed(1)} activity/s; ` +
    `${WHY[p.why]})`
  );
}

/** Runs `tasks` with at most `jobs` at once; results in task order. */
async function pool<T>(tasks: readonly (() => Promise<T>)[], jobs: number): Promise<T[]> {
  const out: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (task !== undefined) out[i] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return out;
}

async function renderCut(
  session: RenderSession,
  kind: CutKind,
  pieces: readonly CutPiece[],
): Promise<string> {
  const spec = CUT_SPECS[kind];
  const dir = mkdtempSync(join(tmpdir(), `arena-cut-${kind}-`));
  try {
    const tasks = pieces.map((p, i) => async (): Promise<string> => {
      const out = join(dir, `${String(i).padStart(2, '0')}.mp4`);
      if (p.kind === 'card') {
        await session.renderClip({
          label: `${kind} card ${p.name}`,
          path: renderPath({ kind: 'card', name: p.name, fixture: false }, spec.size),
          size: spec.size,
          from: null,
          to: null,
          speed: 1,
          out,
        });
      } else {
        await session.renderClip({
          label: `${kind} ${p.game}`,
          path: renderPath({ kind: 'match', game: p.game, id: p.id }, spec.size),
          size: spec.size,
          from: { frame: p.window.from },
          to: { frame: p.window.to },
          speed: 1,
          out,
        });
      }
      return out;
    });
    const parts = await pool(tasks, JOBS);
    const out = resolve(REPO_ROOT, spec.out);
    await concatClips(parts, out);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCutCli(argv: readonly string[]): Promise<void> {
  const args = parseCutArgs(argv);
  if (!args.dryRun) checkFfmpeg();
  const started = Date.now();
  const chosen = chooseMatches();
  const activity = new Map(chosen.map((c) => [c.game, activityOf(c.log)]));
  const results = new Map(chosen.map((c) => [c.log.header.matchId, resultOf(c.log)]));
  const cardData = { leaderboard: null, games: GAMES.map((g) => ({ id: g.id, label: g.label })) };
  const cardFrames = (name: string): number => cardFor(name, cardData)?.frames ?? 0;

  const plans = args.kinds.map((kind) => {
    const spec = CUT_SPECS[kind];
    const segments: GameSegment[] = chosen.map((c) => {
      const a = activity.get(c.game);
      if (a === undefined) throw new Error(`no activity for ${c.game}`);
      const seconds = a.bounds === null ? spec.segmentS : spec.turnMaxS;
      return {
        game: c.game,
        choice: { id: c.log.header.matchId, why: c.why },
        window: pickWindow(a, seconds),
      };
    });
    const pieces = cutPieces(segments, cardFrames);
    console.log(`${kind} cut (${formatRenderSize(spec.size)}) → ${spec.out}`);
    for (const p of pieces) console.log(`  ${describe(p, results)}`);
    console.log(`  total ${cutSeconds(pieces).toFixed(2)} s`);
    return { kind, pieces };
  });
  if (args.dryRun) return;

  const session = await openRenderSession();
  try {
    for (const plan of plans) {
      const t0 = Date.now();
      const out = await renderCut(session, plan.kind, plan.pieces);
      console.log(
        `wrote ${relative(process.cwd(), out) || out}: ${cutSeconds(plan.pieces).toFixed(2)} s ` +
          `(rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
      );
    }
  } finally {
    await session.close();
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  runCutCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof UsageError) console.error(CUT_USAGE);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
