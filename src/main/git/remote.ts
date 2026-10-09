// Generic (not GitHub-specific) remote detection for the Session list's group-header icons
// (issue #528): whether a repository has ANY configured remote, and that remote's host when it
// does -- used only to pick an icon and its tooltip text, never to open a link or reach the
// network. Deliberately separate from `github.ts`'s own `parseOwnerRepo`, which throws away
// anything that is not a github.com URL; a GitLab, Azure DevOps or self-hosted remote must still
// read as "has a remote", not silently fall back to "local only".

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { gitRaw } from './git';
import type { RepositoryRemote } from '../../shared/model';

const TIMEOUT_MS = 3000;

/** The bare authority host from a git remote URL, with any userinfo/credentials stripped before
 * it ever leaves this function (a remote URL can embed a token, for example
 * `https://x-access-token:ghp_xxx@github.com/owner/repo.git`) -- a privacy requirement, never a
 * display nicety. Handles the scp-like SSH form (`user@host:owner/repo.git`, no scheme) in
 * addition to any URL node's own `URL` parser accepts (`https://`, `ssh://`, `git://`, ...). */
function hostFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  // Gate round 1 fix (Medium, all four reviewers): git itself treats a drive-letter prefix
  // (`C:/...`, `C:\...`) as a LOCAL path, never a remote host -- without this check it matches
  // the scp-like pattern below and reports a false host of a single letter ("c").
  if (/^[a-z]:[\\/]/i.test(trimmed)) return null;
  if (!trimmed.includes('://')) {
    // Gate round 1 fix (Low): the host capture excludes `@` so a userinfo segment that itself
    // contains one (`a@b@host:path`) can never leak part of itself into the reported host.
    const scpMatch = /^(?:[^/]*@)?([^:/@]+):/.exec(trimmed);
    // Gate round 2 fix (Low, all four reviewers): the round-1 IPv6 guard only covered the URL
    // branch below -- the scp form (`git@[::1]:repo`, `[fe80::1]:repo`) still matched this
    // pattern and reported a bare `[`/`[fe80` as the host. Display-only (no credential leak),
    // but still a false claim.
    if (scpMatch?.[1] && !scpMatch[1].includes('[')) return scpMatch[1].toLowerCase();
    return null;
  }
  try {
    const host = new URL(trimmed).hostname;
    // Gate round 1 fix (Low): an IPv6 literal (`[::1]`) would otherwise report the bare `[`
    // -- no clean host to show, so treated the same as unparseable.
    if (!host || host.includes('[')) return null;
    return host.toLowerCase();
  } catch {
    return null;
  }
}

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** `Repository.remote` (issue #528): read-only, no network call, and bounded so a hung or
 * missing `git` can never block the Session list for long. ONE git spawn per repository (gate
 * round 1 fix, Medium: the original two-call version could take up to two full timeouts in a
 * row) -- `git config --local --list` dumps every locally-configured key in one call, exit 0
 * whenever the repository's own config is readable at all (even an empty one, which `git init`
 * never actually produces -- `core.*` is always present), so success here means "the config was
 * read", never "a remote happened to exist"; `remote.<name>.url` lines are then parsed out of
 * that dump, `origin` preferred when more than one is configured, else the first one listed.
 *
 * Gate round 3 fix (High, verification): `git config --local --get-regexp <pattern>` (round 1/2)
 * exits 1 with EMPTY stdout whenever the pattern matches nothing -- the one case this function
 * needs to read as a confirmed `none` -- but `gitRaw` always fills `stderr` with its own
 * "Command failed: …" message on every non-zero exit (`git.ts`'s own `stderr: stderr ||
 * error.message`), so that "confirmed no match" case was never distinguishable from a missing
 * `git`, a spawn failure, or this call's own abort (all ALSO exit 1 with a `stderr` message) --
 * `none` could then never actually be returned, and every repository with no remote reported
 * `unknown` instead. Switching to `--list` (success is `exit 0`, not "some specific exit 1 that
 * happens to carry no stderr") removes that whole ambiguity: a real failure is a NON-zero exit,
 * full stop, and reports `unknown`; a real "no remote" is `exit 0` with no `remote.*.url` line in
 * the dump, and reports `none`.
 *
 * `deadline` (optional): an outer signal `repositories.ts`'s own pool aborts once its shared
 * response deadline passes, combined with this function's own per-call timeout (gate round 2
 * fix, Medium) -- a repository the pool gave up waiting on stops its own in-flight `git` call
 * too, instead of continuing to spawn processes whose result nothing reads any more.
 *
 * Never throws: an unreadable repository (a moved or deleted folder, or one that is no longer a
 * git repository at all), a missing `git` executable, or a timed-out/aborted call all report
 * `unknown` -- it makes no claim either way, distinct from a confirmed `none`. A folder whose own
 * `.git` entry is gone (for example absorbed into an unrelated outer repository after a move) is
 * caught by the `fs.stat` check below -- cheaper than, and in place of, a second git call that
 * would otherwise silently walk up to that outer repository's own remotes, the exact same hazard
 * `github.ts`'s own `parseOwnerRepo` has today (gate round 1 fix, Medium). */
export async function repositoryRemote(repoPath: string, deadline?: AbortSignal): Promise<RepositoryRemote> {
  if (deadline?.aborted) return { kind: 'unknown' };
  const gitDirExists = await stat(path.join(repoPath, '.git')).then(
    () => true,
    () => false
  );
  if (!gitDirExists) return { kind: 'unknown' };
  if (deadline?.aborted) return { kind: 'unknown' };
  const { signal: timeoutSignal, clear } = withTimeout();
  // Gate round 3 fix (Low, code-reviewer + security-auditor): Electron 44's bundled Node has
  // `AbortSignal.any` (confirmed by both reviewers), so this no longer hand-rolls a combine
  // helper that had to remember to remove its own listeners -- `AbortSignal.any` composes and
  // tears down its internal listeners on its own once either input fires or is garbage
  // collected, with no accumulation across repeated calls across many repositories.
  const signal = deadline ? AbortSignal.any([timeoutSignal, deadline]) : timeoutSignal;
  const result = await gitRaw(repoPath, ['config', '--local', '--list'], { signal });
  const aborted = signal.aborted;
  clear();
  if (aborted) return { kind: 'unknown' };
  if (result.code !== 0) return { kind: 'unknown' };
  const entries = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eqIndex = line.indexOf('=');
      const key = eqIndex === -1 ? line : line.slice(0, eqIndex);
      const url = eqIndex === -1 ? '' : line.slice(eqIndex + 1);
      const match = /^remote\.(.+)\.url$/.exec(key);
      return { name: match?.[1] ?? '', url };
    })
    .filter((entry): entry is { name: string; url: string } => entry.name.length > 0 && entry.url.length > 0);
  if (entries.length === 0) return { kind: 'none' };
  const preferred = entries.find((entry) => entry.name === 'origin') ?? entries[0]!;
  const host = hostFromRemoteUrl(preferred.url);
  return host ? { kind: 'has', host } : { kind: 'unknown' };
}
