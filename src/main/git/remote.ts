// Generic (not GitHub-specific) remote detection for the Session list's group-header icons
// (issue #528): whether a repository has ANY configured remote, and that remote's host when it
// does -- used only to pick an icon and its tooltip text, never to open a link or reach the
// network. Deliberately separate from `github.ts`'s own `parseOwnerRepo`, which throws away
// anything that is not a github.com URL; a GitLab, Azure DevOps or self-hosted remote must still
// read as "has a remote", not silently fall back to "local only".

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
  if (!trimmed.includes('://')) {
    const scpMatch = /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed);
    if (scpMatch?.[1]) return scpMatch[1].toLowerCase();
  }
  try {
    const host = new URL(trimmed).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** `Repository.remote` (issue #528): read-only, no network call (`git remote` and `git remote
 * get-url` only read the repository's own local config) and bounded so a hung or missing `git`
 * can never block the Session list. Never throws: an unreadable repository (a moved or deleted
 * folder, or one that is no longer a git repository at all) reports `unknown`, distinct from a
 * confirmed `none`. When more than one remote is configured, `origin` is preferred; otherwise
 * the first one `git remote` lists. */
export async function repositoryRemote(repoPath: string): Promise<RepositoryRemote> {
  const list = withTimeout();
  const listResult = await gitRaw(repoPath, ['remote'], { signal: list.signal });
  list.clear();
  if (listResult.code !== 0) return { kind: 'unknown' };
  const names = listResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length === 0) return { kind: 'none' };
  const preferred = names.includes('origin') ? 'origin' : names[0]!;
  const url = withTimeout();
  const urlResult = await gitRaw(repoPath, ['remote', 'get-url', preferred], { signal: url.signal });
  url.clear();
  if (urlResult.code !== 0) return { kind: 'unknown' };
  const host = hostFromRemoteUrl(urlResult.stdout);
  return host ? { kind: 'has', host } : { kind: 'unknown' };
}
