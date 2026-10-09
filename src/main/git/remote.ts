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

/** Combines two abort signals into one that fires when either does, without relying on the
 * newer `AbortSignal.any` (avoids a pinned-`@types/node`/lib-target question for one tiny
 * helper). `b` is optional so every caller that has no outer deadline of its own can skip it. */
function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/** `Repository.remote` (issue #528): read-only, no network call, and bounded so a hung or
 * missing `git` can never block the Session list for long. ONE git spawn per repository (gate
 * round 1 fix, Medium: the original two-call version could take up to two full timeouts in a
 * row) -- `git config --local --get-regexp` lists every configured remote's URL in one call;
 * `origin` is preferred when more than one is configured, else the first one listed.
 *
 * `deadline` (optional): an outer signal `repositories.ts`'s own pool aborts once its shared
 * response deadline passes, combined with this function's own per-call timeout (gate round 2
 * fix, Medium) -- a repository the pool gave up waiting on stops its own in-flight `git` call
 * too, instead of continuing to spawn processes whose result nothing reads any more.
 *
 * Never throws: an unreadable repository (a moved or deleted folder, or one that is no longer a
 * git repository at all), a missing `git` executable, or a timed-out/aborted call all report
 * `unknown` -- it makes no claim either way, distinct from a confirmed `none`. Gate round 2 fix
 * (High, all four reviewers): a non-zero `gitRaw` exit with empty stdout is `none` ONLY when
 * `git config --get-regexp` genuinely found no match (which always leaves `stderr` empty too) --
 * a missing executable, a spawn failure, or this call's own abort ALL ALSO surface as `code: 1`
 * with empty stdout but a non-empty `stderr` (or, for an abort, `signal.aborted` itself), and
 * must report `unknown`, never the false claim that the repository has been confirmed local-only.
 * A folder whose own `.git` entry is gone (for example absorbed into an unrelated outer
 * repository after a move) is caught by the `fs.stat` check below -- cheaper than, and in place
 * of, a second git call that would otherwise silently walk up to that outer repository's own
 * remotes, the exact same hazard `github.ts`'s own `parseOwnerRepo` has today (gate round 1 fix,
 * Medium). */
export async function repositoryRemote(repoPath: string, deadline?: AbortSignal): Promise<RepositoryRemote> {
  if (deadline?.aborted) return { kind: 'unknown' };
  const gitDirExists = await stat(path.join(repoPath, '.git')).then(
    () => true,
    () => false
  );
  if (!gitDirExists) return { kind: 'unknown' };
  if (deadline?.aborted) return { kind: 'unknown' };
  const { signal: timeoutSignal, clear } = withTimeout();
  const signal = combineSignals(timeoutSignal, deadline);
  const result = await gitRaw(repoPath, ['config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { signal });
  const aborted = signal.aborted;
  clear();
  if (aborted) return { kind: 'unknown' };
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return { kind: 'none' };
  if (result.code !== 0) return { kind: 'unknown' };
  const entries = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceIndex = line.indexOf(' ');
      const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
      const url = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
      const match = /^remote\.(.+)\.url$/.exec(key);
      return { name: match?.[1] ?? '', url };
    })
    .filter((entry): entry is { name: string; url: string } => entry.name.length > 0 && entry.url.length > 0);
  if (entries.length === 0) return { kind: 'none' };
  const preferred = entries.find((entry) => entry.name === 'origin') ?? entries[0]!;
  const host = hostFromRemoteUrl(preferred.url);
  return host ? { kind: 'has', host } : { kind: 'unknown' };
}
