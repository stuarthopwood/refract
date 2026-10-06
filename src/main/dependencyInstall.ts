// Dependency installs from the first-run readiness screen (spec 006 FR-005, FR-006, FR-010,
// FR-011; research.md decision 6): one function per dependency, each downloading that vendor's
// own official installer/script over plain HTTPS (Git for Windows, the GitHub CLI) or invoking
// it directly (OMP's own install script) to a scratch file under `app.getPath('temp')`, running
// it with an unattended/no-admin flag set, and reporting progress through
// `DependencyInstallProgress`. A failure at any phase reports `'failed'` with an actionable
// `detail`, never throws past the IPC boundary (`ipc/readiness.ts` awaits these and translates
// a thrown error into `dependency-install-failed`).
//
// Security (constitution V): every fetch is a fixed, hard-coded host; every spawn resolves an
// absolute path first (`resolveExecutable`/`resolvePowerShell`/`msiexecPath`, never a bare
// name); no caller-supplied value is ever interpolated into a shell command (the OMP script's
// `-Command` argument embeds only this module's own fixed constants, never anything from the
// renderer); every spawn is bounded (`maxBuffer`, `timeout`) and no secret is ever logged.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { msiexecPath, primeExecutableCache, resolvePowerShell } from './process/executables';
import type { DependencyInstallProgress } from '../shared/ipc';

const GIT_RELEASES_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
const GITHUB_CLI_RELEASES_API = 'https://api.github.com/repos/cli/cli/releases/latest';
const OMP_INSTALL_SCRIPT_URL = 'https://omp.sh/install.ps1';

// UNVERIFIED: gate T001 pending (research.md decision 7). The Install action always targets this
// pinned supported-line tag, never "whatever -Ref defaults to" (constitution IV, spec.md
// Assumptions: "never run OMP's own self-update to the latest version"). `18.5.1` is the newest
// version `src/main/readiness.ts`'s own comment records as specifically verified (FINDINGS item
// 29); the exact tag-to-version mapping (for example whether the GitHub release tag is literally
// `v18.5.1` or `18.5.1`) has not yet been confirmed against a real `omp.sh/install.ps1` run, per
// research.md decision 6's own "UNVERIFIED (probe, T001)" note. If T001 finds a different tag
// string is needed, update this one constant.
const OMP_PINNED_TAG = 'v18.5.1';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const FETCH_JSON_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

interface GhReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GhLatestRelease {
  assets: GhReleaseAsset[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'refract-dependency-install', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_JSON_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${url} responded with HTTP ${res.status}.`);
  return (await res.json()) as T;
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'refract-dependency-install' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${url} responded with HTTP ${res.status}.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

/** Runs `execPath args` with no shell, bounded stdout/stderr (`MAX_PROCESS_OUTPUT_BYTES`) and a
* hard `timeoutMs` (the process is killed, never left to hang indefinitely -- the closest
* equivalent to "cancellable" this one-shot, awaited install has, since the contract defines no
* renderer-facing cancel action). Never rejects: callers branch on `.code`, the same discipline
* `src/main/github/gh.ts`'s `ghRaw` already uses for a spawned CLI. */
function runProcess(execPath: string, args: string[], timeoutMs: number): Promise<{ code: number; message: string }> {
  return new Promise((resolve) => {
    execFile(
      execPath,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_PROCESS_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, message: '' });
          return;
        }
        const code = 'code' in error && typeof (error as { code: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1;
        const message = (stderr || stdout || error.message || '').trim();
        resolve({ code, message });
      }
    );
  });
}

function failDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `app.getPath('temp')` is a per-OS scratch directory Refract already trusts for other scratch
 * work (`readiness.ts`'s own `checkOmpSignedIn` uses `os.tmpdir()`/`app.getPath('temp')` the same
 * way); the downloaded vendor installer is run once and left there, never re-used. */
function tempPath(fileName: string): string {
  return path.join(app.getPath('temp'), fileName);
}

/** Git for Windows: fetches the latest official 64-bit installer and runs it unattended,
 * per-user (research.md decision 6, sourced from gitforwindows.org/silent-or-unattended-
 * installation). */
export async function installGit(onProgress: (progress: DependencyInstallProgress) => void): Promise<void> {
  const dependency = 'git' as const;
  try {
    onProgress({ dependency, phase: 'downloading' });
    const release = await fetchJson<GhLatestRelease>(GIT_RELEASES_API);
    const asset = release.assets.find((a) => /-64-bit\.exe$/i.test(a.name));
    if (!asset) throw new Error('Could not find a 64-bit Git for Windows installer asset in the latest release.');
    const installerPath = tempPath(asset.name);
    await downloadToFile(asset.browser_download_url, installerPath);

    onProgress({ dependency, phase: 'running' });
    // UNVERIFIED: gate T002 pending (research.md decision 6) -- whether `/CURRENTUSER` actually
    // produces a no-admin install on this installer is not yet confirmed; FR-011 allows Git's
    // own installer to make Windows ask, so a non-zero exit here is reported as a failure rather
    // than silently retried with a different flag set.
    const result = await runProcess(installerPath, ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CURRENTUSER'], INSTALL_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`Git installer exited with code ${result.code}.${result.message ? ` ${result.message}` : ''}`);
    onProgress({ dependency, phase: 'done' });
  } catch (err) {
    const detail = failDetail(err);
    onProgress({ dependency, phase: 'failed', detail });
    throw new Error(detail);
  }
}

/** GitHub CLI: fetches the latest official Windows amd64 MSI and runs it unattended (research.md
 * decision 6). */
export async function installGithubCli(onProgress: (progress: DependencyInstallProgress) => void): Promise<void> {
  const dependency = 'github-cli' as const;
  try {
    onProgress({ dependency, phase: 'downloading' });
    const release = await fetchJson<GhLatestRelease>(GITHUB_CLI_RELEASES_API);
    const asset = release.assets.find((a) => /_windows_amd64\.msi$/i.test(a.name));
    if (!asset) throw new Error('Could not find a Windows amd64 GitHub CLI installer asset in the latest release.');
    const installerPath = tempPath(asset.name);
    await downloadToFile(asset.browser_download_url, installerPath);

    onProgress({ dependency, phase: 'running' });
    // UNVERIFIED: gate T002 pending (research.md decision 6) -- whether the official MSI installs
    // per-machine (needing elevation Windows itself may prompt for, FR-011) or supports a
    // per-user target is not yet confirmed; either way a non-zero exit is reported as a failure.
    const result = await runProcess(msiexecPath(), ['/i', installerPath, '/quiet', '/norestart'], INSTALL_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`GitHub CLI installer exited with code ${result.code}.${result.message ? ` ${result.message}` : ''}`);
    onProgress({ dependency, phase: 'done' });
  } catch (err) {
    const detail = failDetail(err);
    onProgress({ dependency, phase: 'failed', detail });
    throw new Error(detail);
  }
}

/** OMP: invokes OMP's own official install script with a pinned supported-line tag (research.md
 * decisions 6 and 7), never "whatever -Ref defaults to". The script does its own download and
 * install in one unattended PowerShell invocation, so there is no separate Refract-side
 * `'downloading'` phase to report here -- only `'running'` for the whole invocation. */
export async function installOmp(onProgress: (progress: DependencyInstallProgress) => void): Promise<void> {
  const dependency = 'omp' as const;
  try {
    const pwsh = await resolvePowerShell();
    onProgress({ dependency, phase: 'running' });
    // Fixed constants only (OMP_INSTALL_SCRIPT_URL, OMP_PINNED_TAG) are embedded in this
    // `-Command` script string; nothing from the renderer or any caller ever reaches it --
    // same pattern research.md decision 6 already documents for this exact invocation.
    const script = `& ([scriptblock]::Create((irm ${OMP_INSTALL_SCRIPT_URL}))) -Binary -Ref ${OMP_PINNED_TAG}`;
    const result = await runProcess(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], INSTALL_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`OMP install script exited with code ${result.code}.${result.message ? ` ${result.message}` : ''}`);

    // research.md decision 6: this process's in-memory PATH does not pick up the child script's
    // User-scope PATH write, so probe the known fixed install path directly instead of
    // `resolveExecutable`'s PATH search, priming its cache so the immediate `readiness.check()`
    // this install triggers (and every one after it, this run) finds `omp` without a restart.
    const fixedInstallPath = path.join(process.env['LOCALAPPDATA'] ?? '', 'omp', 'omp.exe');
    try {
      await fs.access(fixedInstallPath);
      primeExecutableCache('omp', fixedInstallPath);
    } catch {
      // Falls back to a full `readiness.check()` on Refract's next restart, once the
      // shell/process PATH catches up (research.md decision 6) -- not an install failure.
    }
    onProgress({ dependency, phase: 'done' });
  } catch (err) {
    const detail = failDetail(err);
    onProgress({ dependency, phase: 'failed', detail });
    throw new Error(detail);
  }
}
