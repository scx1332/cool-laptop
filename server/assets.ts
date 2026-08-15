/**
 * Access to the PowerShell sidecars in both builds.
 *
 * Running from source they are just files in the tree. In a compiled binary
 * there is no tree, so they are embedded with an import attribute and unpacked
 * to a temp directory on first use — powershell.exe -File needs a real path on
 * a real filesystem and cannot read out of the embedded bundle.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sidecarPs1 from './telemetry/sidecar.ps1' with { type: 'file' };
import topologyPs1 from './telemetry/topology.ps1' with { type: 'file' };
import { config } from './config.ts';

const EMBEDDED = {
  'sidecar.ps1': sidecarPs1,
  'topology.ps1': topologyPs1,
} as const;

export type ScriptName = keyof typeof EMBEDDED;

const unpacked = new Map<ScriptName, string>();

export async function scriptPath(name: ScriptName): Promise<string> {
  if (!config.compiled) return resolve(config.root, 'server', 'telemetry', name);

  const cached = unpacked.get(name);
  if (cached) return cached;

  const dir = resolve(tmpdir(), 'powermanagement-scripts');
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, name);
  await Bun.write(out, Bun.file(EMBEDDED[name]));
  unpacked.set(name, out);
  return out;
}

/** Command line that re-invokes this program with a subcommand.
 *  Compiled, that is the executable itself; from source it is bun plus the
 *  entry script, because a compiled binary cannot be handed a .ts file to run
 *  and bun cannot be handed a subcommand it knows nothing about. */
export function selfCommand(args: string[]): string[] {
  // process.execPath, not "bun": on Windows `bun` on PATH is a .cmd shim that
  // launches the real binary as a child, and affinity set on the shim does not
  // reach that child.
  return config.compiled
    ? [process.execPath, ...args]
    : [process.execPath, resolve(config.root, 'server', 'main.ts'), ...args];
}
