// Dependency installs from the first-run readiness screen (spec 006 FR-005, FR-006, FR-010,
// FR-011; research.md decision 6): one function per dependency, each downloading that vendor's
// own official installer/script over plain HTTPS (Git for Windows, the GitHub CLI) or invoking
// it directly (OMP's own install script) to a scratch file under `app.getPath('temp')`, running
// it with an unattended/no-admin flag set, and reporting progress through
// `DependencyInstallProgress`. A failure at any phase reports `'failed'` with an actionable
// `detail`, never throws past the IPC boundary (`ipc/readiness.ts` awaits these and translates
// a thrown error into `dependency-install-failed`).
//
// Security (constitution V): every fetch is a fixed, hard-coded host (contracts/ipc.md); every
// spawn resolves an absolute path first (`resolveExecutable`/`resolvePowerShell`/`msiexecPath`,
// never a bare name); no caller-supplied value is ever interpolated into a shell command (the OMP
// script's `-Command` argument embeds only this module's own fixed constants, never anything
// from the renderer); every spawn is bounded (`maxBuffer`, `timeout`) and no secret is ever
// logged. Quality-gate remediation (Medium): Git/GitHub CLI download URLs and every redirect hop
// are checked against a fixed host allowlist (`fetchFromAllowedHost`); the temp download path is
// a fresh `mkdtemp` directory with the asset's `path.basename`-only name, written with `wx`
// (refuses to overwrite); OMP's install script URL is pinned to a tag/commit instead of a moving
// redirect.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { msiexecPath, primeExecutableCache, resolvePowerShell } from './process/executables';
import type { DependencyInstallProgress } from '../shared/ipc';

const GIT_RELEASES_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
const GITHUB_CLI_RELEASES_API = 'https://api.github.com/repos/cli/cli/releases/latest';

// UNVERIFIED: gate T001 pending (research.md decision 7). The Install action always targets this
// pinned supported-line tag, never "whatever -Ref defaults to" (constitution IV, spec.md
// Assumptions: "never run OMP's own self-update to the latest version"). `18.5.1` is the newest
// version `src/main/readiness.ts`'s own comment records as specifically verified (FINDINGS item
// 29); the exact tag-to-version mapping (for example whether the GitHub release tag is literally
// `v18.5.1` or `18.5.1`) has not yet been confirmed against a real install run, per research.md
// decision 6's own "UNVERIFIED (probe, T001)" note. If T001 finds a different tag string is
// needed, update this one constant.
const OMP_PINNED_TAG = 'v18.5.1';

// Quality-gate remediation (Medium, security "OMP install script URL is a moving redirect"):
// `https://omp.sh/install.ps1` 302s to this exact `raw.githubusercontent.com` path on the
// upstream repo's `main` branch -- fetching `main` means a compromised or force-pushed upstream
// branch changes what this runs with no change on Refract's side at all. Pinned to
// `OMP_PINNED_TAG` instead, the same tag `-Ref` below already targets, so this fetches the
// install script version-matched to the binary it installs. Also added to contracts/ipc.md's
// fixed host list (`raw.githubusercontent.com`).
const OMP_INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/can1357/oh-my-pi/${OMP_PINNED_TAG}/scripts/install.ps1`;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const FETCH_JSON_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_DETAIL_LENGTH = 200;

// Quality-gate remediation (Medium "Git/GitHub CLI download URLs and redirects aren't checked
// against allowed hosts"): `browser_download_url` comes straight from `api.github.com`'s own
// JSON response, never independently validated before this. GitHub's own download URLs
// (`github.com/.../releases/download/...`) redirect once to one of these CDN hosts.
const ALLOWED_DOWNLOAD_HOSTS = new Set(['github.com']);
const ALLOWED_REDIRECT_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_REDIRECTS = 5;

const GIT_MANUAL_HINT = 'If this keeps failing, install Git for Windows yourself from git-scm.com and choose Re-check.';
const GITHUB_CLI_MANUAL_HINT = 'If this keeps failing, install the GitHub CLI yourself from cli.github.com and choose Re-check.';
const OMP_MANUAL_HINT = 'If this keeps failing, install omp yourself and choose Re-check.';

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

function assertAllowedUrl(rawUrl: string, allowedHosts: ReadonlySet<string>, label: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new Error(`${label} must be an https URL on ${[...allowedHosts].join(' or ')}, got ${parsed.protocol}//${parsed.hostname}`);
  }
  return parsed;
}

/** Follows a download URL's redirect(s) MANUALLY (`redirect: 'manual'`), checking every hop's
 * own host against a fixed allowlist, rather than letting `fetch` silently follow to wherever a
 * response happens to point -- `initialUrl` must already be `github.com`
 * (`ALLOWED_DOWNLOAD_HOSTS`), and the one redirect GitHub's own release-asset URLs make must land
 * on its CDN (`ALLOWED_REDIRECT_HOSTS`). */
async function fetchFromAllowedHost(initialUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  let current = assertAllowedUrl(initialUrl, ALLOWED_DOWNLOAD_HOSTS, 'Download URL');
  for (let redirects = 0; redirects < MAX_REDIRECTS; redirects++) {
    const res = await fetch(current.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`${current.toString()} redirected with no Location header.`);
      current = assertAllowedUrl(new URL(location, current).toString(), ALLOWED_REDIRECT_HOSTS, 'Redirect target');
      continue;
    }
    if (!res.ok) throw new Error(`${current.toString()} responded with HTTP ${res.status}.`);
    return res;
  }
  throw new Error(`${initialUrl} redirected too many times.`);
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetchFromAllowedHost(url, { 'User-Agent': 'refract-dependency-install' }, DOWNLOAD_TIMEOUT_MS);
  const buffer = Buffer.from(await res.arrayBuffer());
  // `wx`: refuses to overwrite an existing file rather than silently clobbering one -- defence
  // alongside `tempPath`'s fresh-per-call `mkdtemp` directory below, which already makes a
  // collision between two concurrent installs of the same dependency impossible.
  await fs.writeFile(destPath, buffer, { flag: 'wx' });
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

/** Quality-gate remediation (Medium "failure detail could be a raw multi-line stderr dump"):
 * every failure path appends a short, actionable manual-install hint and caps the whole message
 * to one line within `MAX_DETAIL_LENGTH` -- the readiness screen's progress text must never show
 * a raw multi-line stderr/exception dump. */
function failDetail(err: unknown, manualHint: string): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const combined = `${raw} ${manualHint}`;
  return combined.length > MAX_DETAIL_LENGTH ? `${combined.slice(0, MAX_DETAIL_LENGTH - 1)}…` : combined;
}

/** `app.getPath('temp')` is a per-OS scratch directory Refract already trusts for other scratch
 * work (`readiness.ts`'s own `checkOmpSignedIn` uses `os.tmpdir()`/`app.getPath('temp')` the same
 * way). Quality-gate remediation (Medium "no per-dependency lock stops two Install clicks
 * overlapping"/"the temp file path is predictable"): a fresh `mkdtemp` directory per call makes a
 * same-filename clash between two concurrent installs impossible even without the IPC-level
 * in-flight guard (`ipc/readiness.ts`), and `path.basename` strips any path segment the asset
 * name (external, GitHub-release-sourced data) might contain. The downloaded vendor installer is
 * run once and left in its own scratch directory, never re-used. */
async function tempPath(fileName: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'refract-dep-'));
  return path.join(dir, path.basename(fileName));
}

/** Primes `resolveExecutable`'s cache with `name`'s known fixed install path(s), tried in order,
 * once a vendor installer's own process has already exited 0 -- research.md decision 6: this
 * process's in-memory PATH does not pick up a just-installed tool's PATH write, so probing the
 * known fixed location directly (instead of `resolveExecutable`'s own PATH search) lets the
 * immediate `readiness.check()` an install triggers find it without a restart. Quality-gate
 * remediation (Medium "the OMP path can be cached as a relative path"): a candidate built from an
 * unset env var (e.g. `LOCALAPPDATA`) is not absolute, which `executables.ts` requires every
 * cached path to be -- those are skipped rather than wrongly cached. Returns `true` only if one
 * candidate was found and cached. */
async function primeIfInstalled(name: string, candidates: string[]): Promise<boolean> {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate);
      primeExecutableCache(name, candidate);
      return true;
    } catch {
      // Not at this candidate path; try the next one, or fall through to `restartRequired`.
    }
  }
  return false;
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
    const installerPath = await tempPath(asset.name);
    await downloadToFile(asset.browser_download_url, installerPath);

    onProgress({ dependency, phase: 'running' });
    // UNVERIFIED: gate T002 pending (research.md decision 6) -- whether `/CURRENTUSER` actually
    // produces a no-admin install on this installer is not yet confirmed; FR-011 allows Git's
    // own installer to make Windows ask, so a non-zero exit here is reported as a failure rather
    // than silently retried with a different flag set.
    const result = await runProcess(installerPath, ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CURRENTUSER'], INSTALL_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`Git installer exited with code ${result.code}.${result.message ? ` ${result.message}` : ''}`);

    // Quality-gate remediation (Medium "after a successful Git/gh install, the automatic
    // re-check can never pass in the same run"): `/CURRENTUSER` installs to
    // `%LOCALAPPDATA%\Programs\Git`; some Git for Windows releases/configurations still land in
    // `Program Files\Git` instead, so both are tried.
    const found = await primeIfInstalled('git', [
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')
    ]);
    onProgress(found ? { dependency, phase: 'done' } : { dependency, phase: 'done', restartRequired: true });
  } catch (err) {
    const detail = failDetail(err, GIT_MANUAL_HINT);
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
    const installerPath = await tempPath(asset.name);
    await downloadToFile(asset.browser_download_url, installerPath);

    onProgress({ dependency, phase: 'running' });
    // UNVERIFIED: gate T002 pending (research.md decision 6). Quality-gate remediation (Medium):
    // the official MSI is per-machine only, so `/quiet` (which suppresses the elevation prompt
    // entirely) was likely making this fail rather than let Windows ask as FR-011 allows --
    // `/passive` keeps it unattended (no user interaction needed beyond an elevation prompt) while
    // still letting that prompt appear. 3010 (reboot required) and 1641 (reboot initiated) are
    // documented successful-MSI-install exit codes, not failures.
    const MSI_SUCCESS_CODES = new Set([0, 3010, 1641]);
    const result = await runProcess(msiexecPath(), ['/i', installerPath, '/passive', '/norestart'], INSTALL_TIMEOUT_MS);
    if (!MSI_SUCCESS_CODES.has(result.code)) {
      throw new Error(`GitHub CLI installer exited with code ${result.code}.${result.message ? ` ${result.message}` : ''}`);
    }

    // Quality-gate remediation (Medium, same PATH-refresh fix as Git above): the MSI always
    // installs per-machine, to `Program Files\GitHub CLI`.
    const found = await primeIfInstalled('gh', [path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]);
    onProgress(found ? { dependency, phase: 'done' } : { dependency, phase: 'done', restartRequired: true });
  } catch (err) {
    const detail = failDetail(err, GITHUB_CLI_MANUAL_HINT);
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
    // User-scope PATH write, so `primeIfInstalled` probes the known fixed install path directly
    // instead of `resolveExecutable`'s PATH search.
    const found = await primeIfInstalled('omp', [path.join(process.env['LOCALAPPDATA'] ?? '', 'omp', 'omp.exe')]);
    onProgress(found ? { dependency, phase: 'done' } : { dependency, phase: 'done', restartRequired: true });
  } catch (err) {
    const detail = failDetail(err, OMP_MANUAL_HINT);
    onProgress({ dependency, phase: 'failed', detail });
    throw new Error(detail);
  }
}
