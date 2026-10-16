import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Env } from '../core/classifier/providers.js';

/**
 * Where a match ran, as two header fields (Node only: `pnpm match`, `pnpm tournament` and the live
 * proxy; core and the browser are handed these, never compute them).
 *
 * - `runId`: automatic. A machine id that is stable across runs on one machine and says nothing
 *   about where that machine is, so the published logs can show they all came from one machine.
 *   Simulated runs (`--sim`) are `sim`.
 * - `runLocation`: an optional free-text label from `RUN_LOCATION`.
 *
 * The id comes from the operating system's own random per-machine identifier, which survives
 * reboots and network changes: macOS `IOPlatformUUID`, Linux `/etc/machine-id` (or
 * `/var/lib/dbus/machine-id`), Windows `MachineGuid`. Only a hash of it is ever printed or logged.
 * The host name is a last resort: on macOS it changes with the network, and a guessable name like
 * "Alexs-Mac.local" could be hashed and confirmed.
 */

/** The run id of a simulated run. */
export const SIM_RUN_ID = 'sim';

/** `runLocation` when `RUN_LOCATION` is unset or blank (and the run is not simulated). */
export const UNSPECIFIED_LOCATION = 'unspecified';

/**
 * Hashed in front of the identifier (domain separation): the id is a hash of this string plus the
 * identifier, so it can't be matched against a hash of the bare identifier made anywhere else.
 * `v2` because v1 ids (logs before 2026-10-15) hashed the host name.
 */
export const RUN_ID_HASH_PREFIX = 'classifier-arena run id v2:';

/** How long reading the identifier may take (`ioreg` or `reg`) before the host name is used. */
export const IDENTIFIER_TIMEOUT_MS = 2_000;

/** What reading the identifier needs; tests inject every part. */
export interface MachineIdDeps {
  platform?: NodeJS.Platform;
  /** Runs a program without a shell and returns its stdout; throws on failure or timeout. */
  run?: (file: string, args: readonly string[]) => string;
  /** Reads a text file; throws when it can't. */
  readFile?: (path: string) => string;
  hostname?: () => string;
}

const runFile = (file: string, args: readonly string[]): string =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: IDENTIFIER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

const readText = (path: string): string => readFileSync(path, 'utf8');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;

/** A usable identifier, lowercased; null for a malformed or all-zero one (shared by many VMs). */
function usable(raw: string | undefined, re: RegExp): string | null {
  const id = raw?.trim().toLowerCase() ?? '';
  return re.test(id) && /[1-9a-f]/.test(id) ? id : null;
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * This machine's stable identifier (lowercased), or null when none is readable. Never logged or
 * printed: only `runIdFromIdentifier`'s hash of it leaves this module.
 */
export function readMachineIdentifier(deps: MachineIdDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runFile;
  const readFile = deps.readFile ?? readText;
  if (platform === 'darwin') {
    const out = attempt(() => run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']));
    return usable(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out ?? '')?.[1], UUID_RE);
  }
  if (platform === 'win32') {
    const out = attempt(() =>
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
    );
    return usable(/MachineGuid\s+REG_SZ\s+(\S+)/.exec(out ?? '')?.[1], UUID_RE);
  }
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const id = usable(attempt(() => readFile(path)) ?? undefined, MACHINE_ID_RE);
    if (id !== null) return id;
  }
  return null;
}

const hash12 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

/**
 * `m-` and the first 12 hex digits of SHA-256 over RUN_ID_HASH_PREFIX + the identifier
 * (lowercased and trimmed, so `ioreg`'s uppercase UUID and a lowercase one give the same id).
 */
export function runIdFromIdentifier(identifier: string): string {
  return `m-${hash12(RUN_ID_HASH_PREFIX + identifier.trim().toLowerCase())}`;
}

/**
 * The fallback when no identifier is readable: `h-` (not `m-`, so readers can tell it can change
 * with the network) and the same hash over RUN_ID_HASH_PREFIX + `hostname:` + the host name.
 */
export function runIdFromHostname(host: string): string {
  return `h-${hash12(`${RUN_ID_HASH_PREFIX}hostname:${host}`)}`;
}

let cached: string | null = null;

/**
 * This machine's run id: `runIdFromIdentifier` of its stable identifier, else
 * `runIdFromHostname`. With no `deps` it reads the real machine once per process and caches it.
 */
export function machineRunId(deps?: MachineIdDeps): string {
  if (deps === undefined && cached !== null) return cached;
  const identifier = readMachineIdentifier(deps);
  const id =
    identifier !== null
      ? runIdFromIdentifier(identifier)
      : runIdFromHostname((deps?.hostname ?? hostname)());
  if (deps === undefined) cached = id;
  return id;
}

/** True for an id made from the host name (`h-…`), the fallback that can change. */
export function isHostnameRunId(runId: string): boolean {
  return runId.startsWith('h-');
}

/** `sim` for a simulated run, else this machine's id. */
export function runIdFor(sim: boolean, deps?: MachineIdDeps): string {
  return sim ? SIM_RUN_ID : machineRunId(deps);
}

/** `RUN_LOCATION` when set (and not blank), else `sim` for a simulated run, else `unspecified`. */
export function runLocationFor(env: Env, sim: boolean): string {
  const set = env.RUN_LOCATION?.trim() ?? '';
  return set !== '' ? set : sim ? SIM_RUN_ID : UNSPECIFIED_LOCATION;
}
