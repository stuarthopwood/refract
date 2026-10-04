// Pull request lookup for the Session's own branch (spec 004 FR-006, contracts/ipc.md): read-only,
// `gh` CLI, no shell, argument arrays only (same `execFile` discipline as git.ts). Any failure --
// `gh` not installed, not signed in, offline, rate limited -- is `'unavailable'`, never an error
// (FR-006, SC-007); a clean lookup that genuinely finds no open pull request is `'none'`, distinct
// from `'unavailable'` so `assembleReadout` (T007) can retain the last reading only for the
// latter (data-model.md's retention rule), never for a PR that was actually closed or merged. No
// GitHub token is stored by Refract; `gh`'s own sign-in state is the only credential source
// (research.md item 3).

import { execFile } from 'node:child_process';
import { gitRaw } from './git';
import { resolveExecutable } from '../process/executables';

const TIMEOUT_MS = 5000;

/** `owner/repo`, inferred from the repository's `origin` remote URL. Handles both the HTTPS
 * (`https://github.com/<owner>/<repo>.git`) and SSH (`git@github.com:<owner>/<repo>.git`) forms;
 * `.git` suffix and any trailing slash are stripped. `null` when there is no `origin` remote, or
 * it does not point at github.com (a self-hosted GitHub Enterprise remote is out of scope here). */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshMatch && sshMatch[1] && sshMatch[2]) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

interface GhPrListEntry {
  number: number;
  url: string;
  state: string;
}

function runGh(ghPath: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  // Executor form: Promise.withResolvers() needs lib "ES2024"; tsconfig.node.json is pinned to
  // "ES2023" (see OmpProcess.ts's start() for the same documented exception).
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    execFile(ghPath, args, { cwd, windowsHide: true, signal: controller.signal }, (error: Error | null, stdout: string) => {
      clearTimeout(timer);
      resolve({ stdout, code: error === null ? 0 : 1 });
    });
  });
}

export type PullRequestLookup =
  | { status: 'found'; pr: { number: number; url: string } }
  | { status: 'none' } // a clean lookup that genuinely found no open pull request for this branch
  | { status: 'unavailable' }; // gh missing/not signed in/offline/rate limited/no recognisable remote

/** The Session's open pull request for `branch` (spec 004 FR-006). Never throws. */
export async function pullRequestForBranch(repoPath: string, branch: string): Promise<PullRequestLookup> {
  try {
    const remoteResult = await gitRaw(repoPath, ['remote', 'get-url', 'origin']);
    if (remoteResult.code !== 0) return { status: 'unavailable' };
    const ownerRepo = parseOwnerRepo(remoteResult.stdout);
    if (!ownerRepo) return { status: 'unavailable' };

    const ghPath = await resolveExecutable('gh');
    const { stdout, code } = await runGh(
      ghPath,
      ['pr', 'list', '--head', branch, '--json', 'number,url,state', '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      repoPath
    );
    if (code !== 0) return { status: 'unavailable' };

    let entries: GhPrListEntry[];
    try {
      entries = JSON.parse(stdout) as GhPrListEntry[];
    } catch {
      return { status: 'unavailable' };
    }
    if (!Array.isArray(entries)) return { status: 'unavailable' };
    const open = entries.find((entry) => entry.state === 'OPEN');
    if (!open) return { status: 'none' };
    return { status: 'found', pr: { number: open.number, url: open.url } };
  } catch {
    return { status: 'unavailable' };
  }
}
