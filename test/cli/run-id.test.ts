import { describe, expect, it } from 'vitest';
import {
  RUN_ID_HASH_PREFIX,
  SIM_RUN_ID,
  UNSPECIFIED_LOCATION,
  isHostnameRunId,
  machineRunId,
  readMachineIdentifier,
  runIdFor,
  runIdFromHostname,
  runIdFromIdentifier,
  runLocationFor,
  type MachineIdDeps,
} from '../../src/cli/run-id.js';

/** The run id every log carries: which machine, never where it is. */

const MAC_UUID = '5C1D8E3A-7B2F-4E9A-9C41-0F6D2B8A7E13';
const LINUX_ID = '3f2a9c1e5b7d4a608e1c2b3d4f5a6b7c';
const WIN_GUID = '5c1d8e3a-7b2f-4e9a-9c41-0f6d2b8a7e13';

const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000254, registered, matched>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXXXX"
      "IOPlatformUUID" = "${MAC_UUID}"
      "model" = <"MacBookPro18,1">
    }
`;
const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    ${WIN_GUID}

`;

/** Deps for one platform; every call is recorded, and nothing touches the real machine. */
function fake(platform: NodeJS.Platform, over: Partial<MachineIdDeps> = {}) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const reads: string[] = [];
  const deps: MachineIdDeps = {
    platform,
    run: (file, args) => {
      runs.push({ file, args });
      if (file === 'ioreg') return IOREG;
      if (file === 'reg') return REG;
      throw new Error(`unexpected ${file}`);
    },
    readFile: (path) => {
      reads.push(path);
      if (path === '/etc/machine-id') return `${LINUX_ID}\n`;
      throw new Error('ENOENT');
    },
    hostname: () => 'example-mac.local',
    ...over,
  };
  return { deps, runs, reads };
}

const fails = (): never => {
  throw new Error('nope');
};

describe('readMachineIdentifier', () => {
  it('macOS: IOPlatformUUID from ioreg (no shell), lowercased', () => {
    const { deps, runs } = fake('darwin');
    expect(readMachineIdentifier(deps)).toBe(MAC_UUID.toLowerCase());
    expect(runs).toEqual([{ file: 'ioreg', args: ['-rd1', '-c', 'IOPlatformExpertDevice'] }]);
  });

  it('Linux: /etc/machine-id, else /var/lib/dbus/machine-id', () => {
    expect(readMachineIdentifier(fake('linux').deps)).toBe(LINUX_ID);
    const dbus = fake('linux', {
      readFile: (path) => {
        if (path === '/var/lib/dbus/machine-id') return LINUX_ID;
        throw new Error('ENOENT');
      },
    });
    expect(readMachineIdentifier(dbus.deps)).toBe(LINUX_ID);
  });

  it('Windows: MachineGuid from reg query', () => {
    const { deps, runs } = fake('win32');
    expect(readMachineIdentifier(deps)).toBe(WIN_GUID);
    expect(runs).toEqual([
      {
        file: 'reg',
        args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      },
    ]);
  });

  it('is null when the command fails or times out, the file is missing, or the value is unusable', () => {
    expect(readMachineIdentifier(fake('darwin', { run: fails }).deps)).toBeNull();
    expect(readMachineIdentifier(fake('win32', { run: fails }).deps)).toBeNull();
    expect(readMachineIdentifier(fake('linux', { readFile: fails }).deps)).toBeNull();
    expect(readMachineIdentifier(fake('darwin', { run: () => 'no uuid here' }).deps)).toBeNull();
    // Malformed, or all zeros (a value many VMs share): not an identifier.
    for (const bad of ['uninitialized', '', '0'.repeat(32)]) {
      expect(readMachineIdentifier(fake('linux', { readFile: () => bad }).deps)).toBeNull();
    }
    const zeroUuid = IOREG.replace(MAC_UUID, '00000000-0000-0000-0000-000000000000');
    expect(readMachineIdentifier(fake('darwin', { run: () => zeroUuid }).deps)).toBeNull();
  });
});

describe('run ids', () => {
  it('m- plus the first 12 hex digits of SHA-256 over the v2 prefix and the identifier', () => {
    expect(RUN_ID_HASH_PREFIX).toBe('classifier-arena run id v2:');
    // Pinned against `printf '%s' 'classifier-arena run id v2:<id>' | shasum -a 256`.
    expect(runIdFromIdentifier(MAC_UUID.toLowerCase())).toBe('m-802e92a5fa54');
    expect(runIdFromIdentifier(MAC_UUID)).toBe('m-802e92a5fa54');
    expect(runIdFromIdentifier(LINUX_ID)).toBe('m-ed1451f02981');
  });

  it('falls back to h- over the host name only when no identifier is readable', () => {
    expect(runIdFromHostname('example-host')).toBe('h-5816ad830d90');
    const none = fake('linux', { readFile: fails, hostname: () => 'example-host' });
    expect(machineRunId(none.deps)).toBe('h-5816ad830d90');
    expect(isHostnameRunId('h-5816ad830d90')).toBe(true);
    expect(isHostnameRunId('m-802e92a5fa54')).toBe(false);
  });

  it('is the same whatever the host name, so a network change keeps the id', () => {
    const at = (host: string) => machineRunId(fake('darwin', { hostname: () => host }).deps);
    expect(at('Example-MacBook-Pro.local')).toBe('m-802e92a5fa54');
    expect(at('example-mbp.lan')).toBe('m-802e92a5fa54');
    expect(at('192-168-1-20.example.net')).toBe('m-802e92a5fa54');
  });

  it('never contains the identifier or the host name', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const id = machineRunId(fake(platform).deps);
      expect(id).toMatch(/^m-[0-9a-f]{12}$/);
      for (const secret of [MAC_UUID, LINUX_ID, WIN_GUID, 'example']) {
        expect(id.toLowerCase()).not.toContain(secret.toLowerCase().slice(0, 8));
      }
    }
  });

  it('defaults to this machine, read once and cached (whatever it is: m- or h-, 12 hex)', () => {
    const id = machineRunId();
    expect(id).toMatch(/^[mh]-[0-9a-f]{12}$/);
    expect(machineRunId()).toBe(id);
  });
});

describe('runIdFor', () => {
  it('is sim for a simulated run, else the machine id', () => {
    expect(SIM_RUN_ID).toBe('sim');
    expect(runIdFor(true)).toBe('sim');
    expect(runIdFor(true, fake('darwin').deps)).toBe('sim');
    expect(runIdFor(false, fake('darwin').deps)).toBe('m-802e92a5fa54');
    expect(runIdFor(false)).toBe(machineRunId());
  });
});

describe('runLocationFor', () => {
  it('is RUN_LOCATION when set, trimmed', () => {
    expect(runLocationFor({ RUN_LOCATION: ' nyc-home ' }, false)).toBe('nyc-home');
    expect(runLocationFor({ RUN_LOCATION: 'nyc-home' }, true)).toBe('nyc-home');
  });

  it('is unspecified when unset or blank (sim for a simulated run); never required', () => {
    expect(UNSPECIFIED_LOCATION).toBe('unspecified');
    for (const env of [{}, { RUN_LOCATION: '' }, { RUN_LOCATION: '   ' }]) {
      expect(runLocationFor(env, false)).toBe('unspecified');
      expect(runLocationFor(env, true)).toBe('sim');
    }
  });
});
