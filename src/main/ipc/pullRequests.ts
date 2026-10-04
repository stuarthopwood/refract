// IPC handlers for `pullRequests.*` (specs/003-pull-request-management/contracts/ipc.md). The
// renderer never touches `gh`, the file system, or git directly (constitution V); every GitHub
// read/write here goes through `../github/gh.ts`. Maintains an in-memory staleness cache
// (data-model.md "Staleness (FR-021)") keyed by `(repositoryId, number)`: every mutating request
// re-fetches just `updatedAt`/`headSha` first and refuses with `'stale'` if either has moved
// since the last successful `detail()` call for that same pull request.

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { MergeInput, PullRequestListResult, SubmitReviewInput } from '../../shared/ipc';
import type {
  ChangedFile,
  CheckState,
  FilterTab,
  PullRequestActor,
  PullRequestDetail,
  PullRequestState,
  PullRequestSummary,
  Review,
  ReviewComment,
  ReviewThread,
  ReviewVerdict,
  TimelineEntry
} from '../../shared/github';
import type { Session } from '../../shared/model';
import * as gh from '../github/gh';
import { GhError } from '../github/gh';
import { addWorktreeFromPullRequestBranch } from '../git/worktrees';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, mapStoreThrown, notFound } from './util';

// ---------------------------------------------------------------------------
// Mapping: gh wire shapes -> src/shared/github.ts entity types
// ---------------------------------------------------------------------------

function mapPullRequestState(state: string, isDraft: boolean): PullRequestState {
  if (isDraft) return 'draft';
  const upper = state.toUpperCase();
  if (upper === 'MERGED') return 'merged';
  if (upper === 'CLOSED') return 'closed';
  return 'open';
}

function mapActor(actor: gh.GhActor | null | undefined): PullRequestActor {
  return { login: actor?.login ?? 'unknown', name: actor?.name ?? null };
}

/** A commit's GraphQL author is `{ name: string } | null` -- no `login` at all, since a commit
 * can be authored with an email that isn't linked to a GitHub account. `name` doubles as the
 * fallback `login` so the UI always has something stable to key/display on. */
function mapCommitAuthor(author: { name: string } | null | undefined): PullRequestActor {
  const name = author?.name ?? null;
  return { login: name ?? 'unknown', name };
}

const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);

function mapCheckState(runs: gh.GhCheckRun[] | null): CheckState | 'none' {
  if (!runs || runs.length === 0) return 'none';
  const isPending = runs.some((run) => {
    const status = (run.status ?? '').toUpperCase();
    const state = (run.state ?? '').toUpperCase();
    return PENDING_STATUSES.has(status) || state === 'PENDING';
  });
  if (isPending) return 'pending';
  const isFailed = runs.some((run) => {
    const conclusion = (run.conclusion ?? '').toUpperCase();
    const state = (run.state ?? '').toUpperCase();
    return FAILED_CONCLUSIONS.has(conclusion) || state === 'FAILURE' || state === 'ERROR';
  });
  if (isFailed) return 'failed';
  return 'passed';
}

const BLOCKED_MERGE_STATE_STATUSES = new Set(['BLOCKED', 'DIRTY', 'UNSTABLE']);

/** `PullRequestDetail.disabledReason` (FR-019, FR-020): the single source of truth the renderer
 * displays verbatim -- it never re-derives this from `state`/`mergeable` itself. */
function computeDisabledReason(state: PullRequestState, mergeable: string, mergeStateStatus: string): string | null {
  if (state === 'draft') return 'This pull request is a draft.';
  if (state === 'closed') return 'This pull request is closed.';
  if (state === 'merged') return 'This pull request is already merged.';
  if (mergeable.toUpperCase() === 'CONFLICTING') return 'This pull request has merge conflicts.';
  if (BLOCKED_MERGE_STATE_STATUSES.has(mergeStateStatus.toUpperCase())) return 'Required checks are failing.';
  return null;
}

function mapReviewVerdict(state: string | undefined): ReviewVerdict | null {
  const upper = (state ?? '').toUpperCase();
  if (upper === 'APPROVED') return 'approve';
  if (upper === 'CHANGES_REQUESTED') return 'request-changes';
  if (upper === 'COMMENTED') return 'comment';
  return null; // PENDING/DISMISSED: not a submitted verdict (data-model.md "State transitions")
}

/** Merges `reviewThreads` + the three relevant `timelineItems` kinds into one chronologically
 * sorted array (FR-008). `AutomatedFinding`s are always `[]` here: no dedicated GraphQL field and
 * no live Copilot-review sample exists to confirm a body convention (research.md decision 4). */
function buildTimeline(data: gh.GhThreadsAndTimeline): TimelineEntry[] {
  const withTimestamps: Array<{ entry: TimelineEntry; ts: string }> = [];

  for (const node of data.timelineItems.nodes) {
    if (node.__typename === 'PullRequestCommit' && node.commit) {
      withTimestamps.push({
        entry: {
          kind: 'commit',
          sha: node.commit.oid,
          message: node.commit.message,
          author: mapCommitAuthor(node.commit.author),
          committedAt: node.commit.committedDate
        },
        ts: node.commit.committedDate
      });
    } else if (node.__typename === 'IssueComment' && node.id) {
      const createdAt = node.createdAt ?? '';
      withTimestamps.push({
        entry: { kind: 'comment', id: node.id, author: mapActor(node.author), body: node.body ?? '', createdAt },
        ts: createdAt
      });
    } else if (node.__typename === 'PullRequestReview' && node.id) {
      const verdict = mapReviewVerdict(node.state);
      if (verdict) {
        const submittedAt = node.submittedAt ?? '';
        const review: Review = { id: node.id, author: mapActor(node.author), verdict, body: node.body ?? '', submittedAt, findings: [] };
        withTimestamps.push({ entry: { kind: 'review', review }, ts: submittedAt });
      }
    }
  }

  for (const threadNode of data.reviewThreads.nodes) {
    const comments: ReviewComment[] = threadNode.comments.nodes.map((c) => ({
      id: c.id,
      author: mapActor(c.author),
      body: c.body,
      createdAt: c.createdAt
    }));
    const thread: ReviewThread = {
      id: threadNode.id,
      path: threadNode.path,
      line: threadNode.line,
      diffSide: threadNode.diffSide.toUpperCase() === 'LEFT' ? 'left' : 'right',
      resolved: threadNode.isResolved,
      comments
    };
    const ts = comments[0]?.createdAt ?? '1970-01-01T00:00:00Z';
    withTimestamps.push({ entry: { kind: 'review-thread', thread }, ts });
  }

  withTimestamps.sort((a, b) => a.ts.localeCompare(b.ts));
  return withTimestamps.map((item) => item.entry);
}

// ---------------------------------------------------------------------------
// List (FR-001 to FR-006)
// ---------------------------------------------------------------------------

const SEARCH_QUALIFIERS: Record<Exclude<FilterTab, 'open'>, string> = {
  authored: 'author:@me',
  assigned: 'assignee:@me',
  involves: 'involves:@me',
  'review-requested': 'review-requested:@me'
};

async function listPullRequests(repoPath: string, repoLabel: string, tab: FilterTab, query?: string): Promise<PullRequestSummary[]> {
  if (tab === 'open') {
    const entries = await gh.listOpenPullRequests(repoPath);
    const needle = query?.toLowerCase();
    const items: PullRequestSummary[] = [];
    for (const entry of entries) {
      if (entry.state.toUpperCase() !== 'OPEN') continue;
      if (needle && !entry.title.toLowerCase().includes(needle) && !entry.labels.some((label) => label.name.toLowerCase().includes(needle))) continue;
      items.push({
        number: entry.number,
        title: entry.title,
        state: mapPullRequestState(entry.state, entry.isDraft),
        checkState: mapCheckState(entry.statusCheckRollup),
        repository: repoLabel,
        updatedAt: entry.updatedAt,
        author: mapActor(entry.author)
      });
    }
    return items;
  }

  const qualifier = SEARCH_QUALIFIERS[tab];
  const fullQualifier = query ? `${qualifier} ${query}` : qualifier;
  const entries = await gh.searchPullRequests(repoPath, fullQualifier);
  const items: PullRequestSummary[] = [];
  for (const entry of entries) {
    // The search surface has no `statusCheckRollup` (docs/spike/FINDINGS.md row 37); fetched
    // per-row for these smaller, non-Open tab result counts. A failed per-row fetch degrades to
    // 'none' rather than failing the whole tab.
    const checkRuns = await gh.viewCheckState(repoPath, entry.number).catch(() => null);
    items.push({
      number: entry.number,
      title: entry.title,
      // The search surface has no `isDraft`/mergedAt distinction (row 37): a merged pull request
      // may show here as 'closed' rather than 'merged' -- a documented, known simplification.
      state: mapPullRequestState(entry.state, false),
      checkState: mapCheckState(checkRuns),
      repository: repoLabel,
      updatedAt: entry.updatedAt,
      author: mapActor(entry.author)
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Detail (FR-007 to FR-011) and the staleness cache (FR-021)
// ---------------------------------------------------------------------------

interface StalenessEntry {
  updatedAt: string;
  headSha: string;
}

const staleCache = new Map<string, StalenessEntry>();

function cacheKey(repositoryId: string, number: number): string {
  return `${repositoryId}:${number}`;
}

async function buildDetail(repoPath: string, number: number): Promise<PullRequestDetail> {
  const [view, filesWithPatch, threadsAndTimeline, allowedMergeMethods] = await Promise.all([
    gh.viewPullRequestDetail(repoPath, number),
    gh.getChangedFilesWithPatch(repoPath, number),
    gh.getReviewThreadsAndTimeline(repoPath, number),
    gh.getAllowedMergeMethods(repoPath)
  ]);

  const state = mapPullRequestState(view.state, view.isDraft);
  const mergeable = view.mergeable.toUpperCase() === 'MERGEABLE';
  const disabledReason = computeDisabledReason(state, view.mergeable, view.mergeStateStatus);
  const timeline = buildTimeline(threadsAndTimeline);

  return {
    number: view.number,
    title: view.title,
    state,
    baseBranch: view.baseRefName,
    headBranch: view.headRefName,
    author: mapActor(view.author),
    reviewers: view.reviewRequests.map(mapActor),
    assignees: view.assignees.map(mapActor),
    labels: view.labels.map((label) => label.name),
    description: view.body,
    timeline,
    checkState: mapCheckState(view.statusCheckRollup),
    mergeable,
    disabledReason,
    allowedMergeMethods,
    additions: view.additions,
    deletions: view.deletions,
    changedFilesCount: view.changedFiles,
    updatedAt: view.updatedAt,
    headSha: view.headRefOid
  };
}

/** The Changes tab's data (FR-009, FR-011), built separately from `buildDetail` because it needs
 * its own REST call (`getChangedFilesWithPatch`) plus the porcelain fallback. */
async function buildChangedFiles(repoPath: string, number: number): Promise<ChangedFile[]> {
  const restFiles = await gh.getChangedFilesWithPatch(repoPath, number);
  if (restFiles) {
    return restFiles.map((file) => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null
    }));
  }
  // REST call failed entirely: fall back to the porcelain `files` field (never carries `patch`),
  // so every file reads as truncated (FR-011's banner), rather than losing the file list too.
  const view = await gh.viewPullRequestDetail(repoPath, number);
  return view.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, patch: null }));
}

/** FR-021: re-fetches only `updatedAt`/`headSha`, compares against the cache entry left by the
 * last successful `detail()`/mutating call for this pull request. No cache entry yet (never
 * detailed before this action) is treated as "not stale" -- there is nothing to have gone stale
 * against, and `detail()` is always called by the renderer before any action is offered. */
async function checkNotStale(repositoryId: string, repoPath: string, number: number): Promise<{ stale: boolean; fresh: gh.GhStalenessCheck }> {
  const fresh = await gh.viewStalenessCheck(repoPath, number);
  const cached = staleCache.get(cacheKey(repositoryId, number));
  const stale = cached !== undefined && (cached.updatedAt !== fresh.updatedAt || cached.headSha !== fresh.headSha);
  return { stale, fresh };
}

function rememberFresh(repositoryId: string, number: number, updatedAt: string, headSha: string): void {
  staleCache.set(cacheKey(repositoryId, number), { updatedAt, headSha });
}

// ---------------------------------------------------------------------------
// registerPullRequests
// ---------------------------------------------------------------------------

export function registerPullRequests(manager: SessionManager): void {
  function repoPathFor(repositoryId: string): { ok: true; path: string; label: string } | { ok: false; error: ReturnType<typeof notFound> } {
    const repository = manager.registry.getRepository(repositoryId);
    if (!repository) return { ok: false, error: notFound(`Repository not found: ${repositoryId}`) };
    return { ok: true, path: repository.path, label: repository.name };
  }

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_LIST, async (_event, repositoryId: unknown, tab: unknown, query: unknown) => {
    if (typeof repositoryId !== 'string' || typeof tab !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_LIST} expects (repositoryId, tab, query?)`);
    }
    if (query !== undefined && typeof query !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_LIST} expects query to be a string when provided`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const items = await listPullRequests(resolved.path, resolved.label, tab as FilterTab, query);
      const result: PullRequestListResult = { items, fetchedAt: new Date().toISOString() };
      return { ok: true, value: result };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_DETAIL, async (_event, repositoryId: unknown, number: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_DETAIL} expects (repositoryId, number)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const detail = await buildDetail(resolved.path, number);
      rememberFresh(repositoryId, number, detail.updatedAt, detail.headSha);
      return { ok: true, value: detail };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_COMMENT, async (_event, repositoryId: unknown, number: unknown, body: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof body !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_COMMENT} expects (repositoryId, number, body)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      await gh.commentOnPullRequest(resolved.path, number, body);
      rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
      return { ok: true, value: { id: randomUUID() } };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(
    IPC_REQUESTS.PULL_REQUESTS_REPLY_TO_THREAD,
    async (_event, repositoryId: unknown, number: unknown, threadId: unknown, body: unknown) => {
      if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof threadId !== 'string' || typeof body !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_REPLY_TO_THREAD} expects (repositoryId, number, threadId, body)`);
      }
      const resolved = repoPathFor(repositoryId);
      if (!resolved.ok) return resolved.error;
      try {
        const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
        if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
        const threadsAndTimeline = await gh.getReviewThreadsAndTimeline(resolved.path, number);
        const thread = threadsAndTimeline.reviewThreads.nodes.find((node) => node.id === threadId);
        if (!thread || thread.comments.nodes.length === 0) return notFound(`Review thread not found: ${threadId}`);
        const openingCommentId = thread.comments.nodes[0]!.id;
        const reply = await gh.replyToThreadMutation(resolved.path, threadsAndTimeline.id, openingCommentId, body);
        rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
        return { ok: true, value: reply };
      } catch (err) {
        return mapStoreThrown(err);
      }
    }
  );

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_RESOLVE_THREAD, async (_event, repositoryId: unknown, number: unknown, threadId: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof threadId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_RESOLVE_THREAD} expects (repositoryId, number, threadId)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      await gh.resolveReviewThreadMutation(resolved.path, threadId);
      rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_UNRESOLVE_THREAD, async (_event, repositoryId: unknown, number: unknown, threadId: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof threadId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_UNRESOLVE_THREAD} expects (repositoryId, number, threadId)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      await gh.unresolveReviewThreadMutation(resolved.path, threadId);
      rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW, async (_event, repositoryId: unknown, number: unknown, input: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof input !== 'object' || input === null) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects (repositoryId, number, { verdict, body? })`);
    }
    const { verdict, body } = input as Partial<SubmitReviewInput>;
    if (verdict !== 'comment' && verdict !== 'approve' && verdict !== 'request-changes') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects verdict to be 'comment' | 'approve' | 'request-changes'`);
    }
    if (body !== undefined && typeof body !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects body to be a string when provided`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      const state = mapPullRequestState(fresh.state, fresh.isDraft);
      const disabledReason = computeDisabledReason(state, fresh.mergeable, fresh.mergeStateStatus);
      if (disabledReason) return { ok: false, error: { code: 'disabled', message: disabledReason } };
      await gh.submitReview(resolved.path, number, verdict, body);
      rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
      return { ok: true, value: { id: randomUUID() } };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_MERGE, async (_event, repositoryId: unknown, number: unknown, input: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number' || typeof input !== 'object' || input === null) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_MERGE} expects (repositoryId, number, { method })`);
    }
    const { method } = input as Partial<MergeInput>;
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_MERGE} expects method to be 'merge' | 'squash' | 'rebase'`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      const state = mapPullRequestState(fresh.state, fresh.isDraft);
      const disabledReason = computeDisabledReason(state, fresh.mergeable, fresh.mergeStateStatus);
      if (disabledReason) return { ok: false, error: { code: 'disabled', message: disabledReason } };
      if (fresh.mergeable.toUpperCase() !== 'MERGEABLE') {
        return { ok: false, error: { code: 'not-mergeable', message: 'This pull request has merge conflicts or a failing required check.' } };
      }
      await gh.mergePullRequest(resolved.path, number, method);
      rememberFresh(repositoryId, number, fresh.updatedAt, fresh.headSha);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST, async (_event, repositoryId: unknown, number: unknown) => {
    if (typeof repositoryId !== 'string' || typeof number !== 'number') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST} expects (repositoryId, number)`);
    }
    const repository = manager.registry.getRepository(repositoryId);
    if (!repository) return notFound(`Repository not found: ${repositoryId}`);
    try {
      const localBranchName = `pr-${number}`;
      const { worktreePath, branch } = await addWorktreeFromPullRequestBranch(repository.path, number, localBranchName);
      const view = await gh.viewPullRequestDetail(repository.path, number).catch(() => null);
      const now = new Date().toISOString();
      const session: Session = {
        id: randomUUID(),
        repositoryId,
        name: `pr-${number}`,
        branch,
        baseBranch: view?.baseRefName ?? branch,
        worktreePath,
        sessionDir: null,
        currentConversation: null,
        lastMessageCount: null,
        createdAt: now,
        lastActivityAt: now,
        archivedAt: null
      };
      await manager.registry.addSession(session);
      manager.notifyListChanged();
      return { ok: true, value: session };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });
}
