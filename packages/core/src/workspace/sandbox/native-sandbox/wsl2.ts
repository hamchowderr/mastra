/**
 * WSL2 (Windows Subsystem for Linux 2)
 *
 * Windows sandboxing by running commands inside a WSL2 Linux VM instead of
 * directly on the Windows host. WSL2 runs a real Linux kernel in a
 * lightweight VM, so this is a genuine boundary — a sandboxed command can't
 * see or touch Windows host processes, and its filesystem access is limited
 * to whatever the distro's DrvFs mounts expose.
 *
 * That boundary only holds if WSL interop is disabled on the target distro
 * (`/etc/wsl.conf`'s `[interop] enabled=false`). With interop enabled — the
 * WSL default — a sandboxed command can invoke a Windows `.exe` by full path
 * and step around the VM boundary entirely. `LocalSandbox.start()` checks
 * for this and refuses to start otherwise; this module does not re-check it.
 *
 * When `bwrap` is also installed inside the distro, the command is layered
 * through it for the same namespace/network isolation Linux hosts get
 * natively — see {@link buildBwrapCommand}.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildBwrapCommand } from './bubblewrap';
import type { NativeSandboxConfig } from './types';

const execFileAsync = promisify(execFile);

/**
 * Convert a Windows path to its WSL2 DrvFs equivalent.
 * `C:\Users\foo\bar` -> `/mnt/c/Users/foo/bar`. Paths that aren't a drive-letter
 * Windows path (already POSIX, or a UNC path) are passed through unchanged.
 */
export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (!match) {
    return normalized;
  }
  const [, drive, rest] = match;
  return `/mnt/${drive!.toLowerCase()}/${rest}`;
}

/** POSIX single-quote escaping for embedding a fully-built argv into `sh -c "..."`. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface BuildWsl2CommandOptions {
  /** Whether `bwrap` was detected inside the target distro at sandbox start. */
  bwrapAvailable?: boolean;
}

/**
 * Build the `wsl.exe` command arguments for the given configuration.
 *
 * @param command - The full shell command string to run inside the sandbox
 * @param workspacePath - The workspace directory, as a Windows path (converted to its WSL2/DrvFs form)
 * @param config - Additional sandbox configuration (`wslDistro`, and the bwrap allowlist options when `bwrapAvailable`)
 * @returns Wrapped command and arguments for `wsl.exe`
 */
export function buildWsl2Command(
  command: string,
  workspacePath: string,
  config: NativeSandboxConfig,
  options: BuildWsl2CommandOptions = {},
): { command: string; args: string[] } {
  const linuxWorkspace = toWslPath(workspacePath);

  let innerCommand = command;
  if (options.bwrapAvailable) {
    const linuxConfig: NativeSandboxConfig = {
      ...config,
      readOnlyPaths: (config.readOnlyPaths ?? []).map(toWslPath),
      readWritePaths: (config.readWritePaths ?? []).map(toWslPath),
    };
    const wrapped = buildBwrapCommand(command, linuxWorkspace, linuxConfig);
    innerCommand = [wrapped.command, ...wrapped.args.map(shellQuote)].join(' ');
  }

  const args: string[] = [];
  if (config.wslDistro) {
    args.push('-d', config.wslDistro);
  }
  args.push('--cd', linuxWorkspace, '--', 'sh', '-c', innerCommand);

  return { command: 'wsl.exe', args };
}

export interface Wsl2DistroCheck {
  /** Whether `/etc/wsl.conf`'s `[interop]` section has `enabled=false` on this distro. */
  interopDisabled: boolean;
  /** Whether `bwrap` is on PATH inside this distro. */
  bwrapAvailable: boolean;
}

/**
 * Probe the target WSL2 distro for the interop setting and `bwrap` availability.
 * Meant to run once, at sandbox `start()` — not on the per-command hot path.
 *
 * The interop check is a plain grep for `enabled=false` rather than a full INI parse:
 * `enabled` is a WSL-conf key used only by `[interop]`, so a file-wide match is
 * unambiguous in practice.
 */
export async function checkWsl2Distro(distro?: string): Promise<Wsl2DistroCheck> {
  const args = distro ? ['-d', distro] : [];
  const script =
    "if grep -Eq '^[[:space:]]*enabled[[:space:]]*=[[:space:]]*false[[:space:]]*$' /etc/wsl.conf 2>/dev/null; then echo INTEROP_DISABLED; else echo INTEROP_ENABLED; fi; " +
    'command -v bwrap >/dev/null 2>&1 && echo BWRAP_YES || echo BWRAP_NO';
  try {
    const { stdout } = await execFileAsync('wsl.exe', [...args, '--', 'sh', '-c', script]);
    return {
      interopDisabled: stdout.includes('INTEROP_DISABLED'),
      bwrapAvailable: stdout.includes('BWRAP_YES'),
    };
  } catch {
    return { interopDisabled: false, bwrapAvailable: false };
  }
}
