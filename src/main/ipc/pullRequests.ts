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
  MergeableState,
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
import { addWorktreeFromPullRequestBranch, removeWorktree, uniquePullRequestBranchName } from '../git/worktrees';
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

/** `PullRequestDetail.reviewDisabledReason` (FR-019): review actions (Review/Approve/Request
 * changes, and `submitReview`) are only ever disabled by the pull request's own state -- draft,
 * closed, or merged. Remediation (code-reviewer Critical): this used to be folded together with
 * merge-only concerns (BLOCKED/DIRTY/UNSTABLE via `mergeStateStatus`), which meant a repository
 * with branch-protection requiring reviews disabled the Review button by the very BLOCKED state
 * that approving would clear -- confirmed live against a real protected repository's PR. */
function computeReviewDisabledReason(state: PullRequestState): string | null {
  if (state === 'draft') return 'This pull request is a draft.';
  if (state === 'closed') return 'This pull request is closed.';
  if (state === 'merged') return 'This pull request is already merged.';
  return null;
}

/** `PullRequestDetail.mergeDisabledReason` (FR-019, FR-020): merge-only concerns layered on top of
 * the same state gate -- conflicts and a blocked merge state. `UNSTABLE` (only non-required checks
 * failing) is deliberately never folded in here: GitHub itself still allows merging in that case.
 * `BLOCKED` gets its own wording, distinct from "required checks are failing", because it is very
 * often a missing-approval state (exactly what the Review button, gated separately above, is the
 * way to clear) rather than a failing check. */
function computeMergeDisabledReason(state: PullRequestState, mergeable: string, mergeStateStatus: string): string | null {
  const reviewReason = computeReviewDisabledReason(state);
  if (reviewReason) return reviewReason;
  if (mergeable.toUpperCase() === 'CONFLICTING') return 'This pull request has merge conflicts.';
  const upperStatus = mergeStateStatus.toUpperCase();
  if (upperStatus === 'DIRTY') return 'This pull request has merge conflicts.';
  if (upperStatus === 'BLOCKED') return 'This pull request is blocked: required reviews or required checks have not been satisfied yet.';
  return null;
}

/** "Also fix" remediation: `view.mergeable` is a 3-value string enum (`'MERGEABLE' |
 * 'CONFLICTING' | 'UNKNOWN'`), not a boolean -- `'UNKNOWN'` (GitHub still computing
 * mergeability in the background) used to collapse into "not mergeable" alongside real
 * conflicts. It gets its own state here so the renderer can show "still checking" rather than a
 * false conflict message. */
function mapMergeableState(mergeable: string): MergeableState {
  const upper = mergeable.toUpperCase();
  if (upper === 'MERGEABLE') return 'mergeable';
  if (upper === 'CONFLICTING') return 'conflicting';
  return 'unknown';
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

const SEARCH_QUALIFIER_FLAGS: Record<Exclude<FilterTab, 'open'>, gh.SearchQualifierFlag> = {
  authored: '--author',
  assigned: '--assignee',
  involves: '--involves',
  'review-requested': '--review-requested'
};

/** High remediation (code-reviewer): a non-Open tab used to spawn one `gh pr view` process per
 * row sequentially (up to ~30 per tab switch, each a real process spawn) just to backfill the
 * check-state the search surface doesn't carry. A bounded `Promise.all` runs these concurrently
 * instead -- still one process per row (no GraphQL field exists on the search surface to avoid
 * that entirely), but no longer serialised, and capped so a large result page can never fan out
 * unbounded concurrent `gh` processes at once. */
const CHECK_STATE_CONCURRENCY = 8;

async function withBoundedConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runNext(): Promise<void> {
    const index = next++;
    if (index >= items.length) return;
    const item = items[index];
    if (item === undefined) return;
    results[index] = await worker(item);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

async function listPullRequests(repoPath: string, repoLabel: string, tab: FilterTab, query?: string): Promise<PullRequestSummary[]> {
  if (tab === 'open') {
    const entries = await gh.listOpenPullRequests(repoPath);
    const needle = query?.toLowerCase();
    const items: PullRequestSummary[] = [];
    for (const entry of entries) {
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

  const entries = await gh.searchPullRequests(repoPath, SEARCH_QUALIFIER_FLAGS[tab], query);
  // The search surface has no `statusCheckRollup` (docs/spike/FINDINGS.md row 37); fetched
  // per-row for these smaller, non-Open tab result counts. A failed per-row fetch degrades to
  // 'none' rather than failing the whole tab. `ownerRepo` is resolved ONCE here (High
  // remediation, code-reviewer), not inside `viewCheckState` per row -- `ownerRepoFor` runs a
  // real `git remote get-url` process every call.
  const { owner, repo } = await gh.ownerRepoFor(repoPath);
  const ownerRepo = `${owner}/${repo}`;
  const checkStates = await withBoundedConcurrency(entries, CHECK_STATE_CONCURRENCY, (entry) =>
    gh.viewCheckState(repoPath, ownerRepo, entry.number).catch(() => null)
  );
  return entries.map((entry, index) => ({
    number: entry.number,
    title: entry.title,
    // The search surface has no `isDraft`/mergedAt distinction (row 37): a merged pull request
    // may show here as 'closed' rather than 'merged' -- a documented, known simplification.
    state: mapPullRequestState(entry.state, false),
    checkState: mapCheckState(checkStates[index] ?? null),
    repository: repoLabel,
    updatedAt: entry.updatedAt,
    author: mapActor(entry.author)
  }));
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

/** "Also fix" remediation (security-auditor AND code-reviewer, corroborated): `number` was only
 * ever validated via `typeof number === 'number'`, which lets `NaN`, `Infinity`, negative, and
 * non-integer values straight through to `gh` argv construction. Used at every `number` call
 * site below instead of the bare `typeof` check. */
function isValidPullRequestNumber(number: unknown): number is number {
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0;
}

const VALID_FILTER_TABS = new Set<FilterTab>(['open', 'authored', 'assigned', 'involves', 'review-requested']);

/** "Also fix" remediation (same corroboration): `tab` used to be cast straight to `FilterTab`
 * with no runtime check against the 5 allowed values. */
function isValidFilterTab(tab: unknown): tab is FilterTab {
  return typeof tab === 'string' && VALID_FILTER_TABS.has(tab as FilterTab);
}

function mapChangedFiles(view: gh.GhPrViewDetail, restFiles: gh.GhRestFile[] | null): ChangedFile[] {
  if (restFiles) {
    return restFiles.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, patch: file.patch ?? null }));
  }
  // REST call failed entirely: fall back to the porcelain `files` field (never carries `patch`),
  // so every file reads as truncated (FR-011's banner) rather than losing the file list too.
  return view.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, patch: null }));
}

async function buildDetail(repoPath: string, number: number): Promise<PullRequestDetail> {
  const [view, filesWithPatch, threadsAndTimeline, allowedMergeMethods, ownerRepo] = await Promise.all([
    gh.viewPullRequestDetail(repoPath, number),
    gh.getChangedFilesWithPatch(repoPath, number),
    gh.getReviewThreadsAndTimeline(repoPath, number),
    gh.getAllowedMergeMethods(repoPath),
    gh.ownerRepoFor(repoPath)
  ]);

  const state = mapPullRequestState(view.state, view.isDraft);
  const mergeableState = mapMergeableState(view.mergeable);
  const reviewDisabledReason = computeReviewDisabledReason(state);
  const mergeDisabledReason = computeMergeDisabledReason(state, view.mergeable, view.mergeStateStatus);
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
    mergeableState,
    reviewDisabledReason,
    mergeDisabledReason,
    allowedMergeMethods,
    additions: view.additions,
    deletions: view.deletions,
    changedFilesCount: view.changedFiles,
    files: mapChangedFiles(view, filesWithPatch),
    url: `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/pull/${number}`,
    updatedAt: view.updatedAt,
    headSha: view.headRefOid,
    isFork: view.isCrossRepository,
    headRepositoryOwner: view.headRepositoryOwner?.login ?? null
  };
}

/** FR-021: re-fetches only `updatedAt`/`headSha`, compares against the cache entry left by the
 * last successful `detail()`/mutating call for this pull request. No cache entry yet (never
 * detailed before this action) is treated as "not stale" by default -- there is nothing to have
 * gone stale against, and `detail()` is always called by the renderer before any action is
 * offered. `requireCacheEntry` (security remediation, Medium-but-must-fix) flips that for
 * approve/merge specifically: those two mutations are now pinned to a cached commit (`headSha`/
 * `id`), so a missing cache entry means there is nothing to pin against, and silently proceeding
 * would be the renderer-trust gap this flag exists to close -- treated as stale instead. */
async function checkNotStale(
  repositoryId: string,
  repoPath: string,
  number: number,
  requireCacheEntry = false
): Promise<{ stale: boolean; fresh: gh.GhStalenessCheck }> {
  const fresh = await gh.viewStalenessCheck(repoPath, number);
  const cached = staleCache.get(cacheKey(repositoryId, number));
  if (cached === undefined) return { stale: requireCacheEntry, fresh };
  const stale = cached.updatedAt !== fresh.updatedAt || cached.headSha !== fresh.headSha;
  return { stale, fresh };
}

function rememberFresh(repositoryId: string, number: number, updatedAt: string, headSha: string): void {
  staleCache.set(cacheKey(repositoryId, number), { updatedAt, headSha });
}

/** "Also fix" remediation: the cache used to be re-seeded with the PRE-mutation `fresh` values
 * right after a successful mutating call -- stale the instant that same action succeeded.
 * Deleting the entry instead forces the next `checkNotStale` to see "no cache entry" (lenient
 * for comment/reply/resolve/unresolve, strict-stale for approve/merge above); every mutating
 * handler's renderer caller already re-calls `detail()` immediately after success (`onSubmitted`/
 * `onMerged`/`onChanged` -> `void load()`), which repopulates the cache with POST-mutation data. */
function forgetCache(repositoryId: string, number: number): void {
  staleCache.delete(cacheKey(repositoryId, number));
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
    if (typeof repositoryId !== 'string' || !isValidFilterTab(tab)) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_LIST} expects (repositoryId, tab, query?)`);
    }
    if (query !== undefined && typeof query !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_LIST} expects query to be a string when provided`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const items = await listPullRequests(resolved.path, resolved.label, tab, query);
      const result: PullRequestListResult = { items, fetchedAt: new Date().toISOString() };
      return { ok: true, value: result };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_DETAIL, async (_event, repositoryId: unknown, number: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number)) {
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
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof body !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_COMMENT} expects (repositoryId, number, body)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      await gh.commentOnPullRequest(resolved.path, number, body);
      forgetCache(repositoryId, number);
      return { ok: true, value: { id: randomUUID() } };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(
    IPC_REQUESTS.PULL_REQUESTS_REPLY_TO_THREAD,
    async (_event, repositoryId: unknown, number: unknown, threadId: unknown, body: unknown) => {
      if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof threadId !== 'string' || typeof body !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_REPLY_TO_THREAD} expects (repositoryId, number, threadId, body)`);
      }
      const resolved = repoPathFor(repositoryId);
      if (!resolved.ok) return resolved.error;
      try {
        const { stale } = await checkNotStale(repositoryId, resolved.path, number);
        if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
        const threadsAndTimeline = await gh.getReviewThreadsAndTimeline(resolved.path, number);
        const thread = threadsAndTimeline.reviewThreads.nodes.find((node) => node.id === threadId);
        if (!thread || thread.comments.nodes.length === 0) return notFound(`Review thread not found: ${threadId}`);
        const openingCommentId = thread.comments.nodes[0]!.id;
        const reply = await gh.replyToThreadMutation(resolved.path, threadsAndTimeline.id, openingCommentId, body);
        forgetCache(repositoryId, number);
        return { ok: true, value: reply };
      } catch (err) {
        return mapStoreThrown(err);
      }
    }
  );

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_RESOLVE_THREAD, async (_event, repositoryId: unknown, number: unknown, threadId: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof threadId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_RESOLVE_THREAD} expects (repositoryId, number, threadId)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      // Security remediation (Constitution Principle V, Medium-but-must-fix): `threadId` used to
      // be handed straight to the mutation with no check that it actually belongs to THIS pull
      // request -- `replyToThread` above already verifies this correctly; this copies that exact
      // pattern rather than trusting a renderer-supplied id across pull requests.
      const threadsAndTimeline = await gh.getReviewThreadsAndTimeline(resolved.path, number);
      const thread = threadsAndTimeline.reviewThreads.nodes.find((node) => node.id === threadId);
      if (!thread) return notFound(`Review thread not found: ${threadId}`);
      await gh.resolveReviewThreadMutation(resolved.path, threadId);
      forgetCache(repositoryId, number);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_UNRESOLVE_THREAD, async (_event, repositoryId: unknown, number: unknown, threadId: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof threadId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_UNRESOLVE_THREAD} expects (repositoryId, number, threadId)`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      const { stale } = await checkNotStale(repositoryId, resolved.path, number);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; refresh before trying again.' } };
      // Same ownership check as resolveThread above, same Constitution Principle V reasoning.
      const threadsAndTimeline = await gh.getReviewThreadsAndTimeline(resolved.path, number);
      const thread = threadsAndTimeline.reviewThreads.nodes.find((node) => node.id === threadId);
      if (!thread) return notFound(`Review thread not found: ${threadId}`);
      await gh.unresolveReviewThreadMutation(resolved.path, threadId);
      forgetCache(repositoryId, number);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW, async (_event, repositoryId: unknown, number: unknown, input: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof input !== 'object' || input === null) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects (repositoryId, number, { verdict, body?, expectedHeadSha })`);
    }
    const { verdict, body, expectedHeadSha } = input as Partial<SubmitReviewInput>;
    if (verdict !== 'comment' && verdict !== 'approve' && verdict !== 'request-changes') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects verdict to be 'comment' | 'approve' | 'request-changes'`);
    }
    if (body !== undefined && typeof body !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects body to be a string when provided`);
    }
    if (typeof expectedHeadSha !== 'string' || expectedHeadSha.length === 0) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW} expects expectedHeadSha to be a non-empty string`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      // Security remediation (Medium-but-must-fix): requires a cache entry (`detail()` must have
      // been called for this exact pull request before any review is submitted) so approve has a
      // known `headSha`/`id` to pin its commitOID to -- a missing entry is now `stale`, not
      // silently "not stale".
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number, true);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; close this dialog, refresh, and try again.' } };
      // High remediation (round 3, security-auditor): the staleness cache above is silently
      // overwritten by `PullRequestDetail`'s own 15s background poll, which keeps running while
      // this dialog is open -- so a push that lands between dialog-open and confirm can get
      // re-cached as the new "known good" value, making the cache-vs-cache check above pass even
      // though the user never saw this commit. `expectedHeadSha` is the renderer's own snapshot
      // of `headSha` from the moment the dialog opened; comparing it to a FRESH re-fetch right
      // here is the actual guarantee -- the cache check above only proves a cache entry exists.
      if (fresh.headSha !== expectedHeadSha) {
        return {
          ok: false,
          error: { code: 'stale', message: 'This pull request has changed on GitHub since you opened this dialog; close this dialog, refresh, and try again.' }
        };
      }
      const state = mapPullRequestState(fresh.state, fresh.isDraft);
      const reviewDisabledReason = computeReviewDisabledReason(state);
      if (reviewDisabledReason) return { ok: false, error: { code: 'disabled', message: reviewDisabledReason } };
      const pinned = verdict === 'approve' ? { pullRequestId: fresh.id, headSha: expectedHeadSha } : undefined;
      await gh.submitReview(resolved.path, number, verdict, body, pinned);
      forgetCache(repositoryId, number);
      return { ok: true, value: { id: randomUUID() } };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_MERGE, async (_event, repositoryId: unknown, number: unknown, input: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number) || typeof input !== 'object' || input === null) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_MERGE} expects (repositoryId, number, { method, expectedHeadSha })`);
    }
    const { method, expectedHeadSha } = input as Partial<MergeInput>;
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_MERGE} expects method to be 'merge' | 'squash' | 'rebase'`);
    }
    if (typeof expectedHeadSha !== 'string' || expectedHeadSha.length === 0) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_MERGE} expects expectedHeadSha to be a non-empty string`);
    }
    const resolved = repoPathFor(repositoryId);
    if (!resolved.ok) return resolved.error;
    try {
      // Security remediation (Medium-but-must-fix): a missing cache entry means there is no
      // known `headSha` to pin `--match-head-commit` to -- treated as stale, same reasoning as
      // submitReview's approve path above.
      const { stale, fresh } = await checkNotStale(repositoryId, resolved.path, number, true);
      if (stale) return { ok: false, error: { code: 'stale', message: 'This pull request has changed on GitHub; close this dialog, refresh, and try again.' } };
      // High remediation (round 3, security-auditor): see submitReview's identical comment --
      // the cache-vs-cache staleness check above does not detect a push that landed, then got
      // re-cached as "fresh" by the 15s background poll, between this dialog opening and the
      // user confirming. Comparing the renderer's own dialog-open-time snapshot against a fresh
      // re-fetch right here is the real guarantee.
      if (fresh.headSha !== expectedHeadSha) {
        return {
          ok: false,
          error: { code: 'stale', message: 'This pull request has changed on GitHub since you opened this dialog; close this dialog, refresh, and try again.' }
        };
      }
      const state = mapPullRequestState(fresh.state, fresh.isDraft);
      const mergeableState = mapMergeableState(fresh.mergeable);
      const mergeDisabledReason = computeMergeDisabledReason(state, fresh.mergeable, fresh.mergeStateStatus);
      if (mergeDisabledReason) {
        // Medium remediation (code-reviewer): this reason covers two genuinely different IPC
        // error codes per contracts/ipc.md -- merge conflicts (`not-mergeable`, FR-020, since
        // GitHub itself refuses the merge) versus a review-state/BLOCKED gate (`disabled`,
        // same family as `reviewDisabledReason`). The separate `mergeableState === 'conflicting'`
        // check a round 2 regression added below this was unreachable dead code: conflicts
        // always hit this branch first (via `mergeable.toUpperCase() === 'CONFLICTING'` above),
        // always returning the wrong code (`disabled`) for a real conflict. Folded the
        // distinction in here instead of leaving a second, never-executed check further down.
        const isConflict = mergeableState === 'conflicting' || fresh.mergeStateStatus.toUpperCase() === 'DIRTY';
        return { ok: false, error: { code: isConflict ? 'not-mergeable' : 'disabled', message: mergeDisabledReason } };
      }
      if (mergeableState === 'unknown') {
        return { ok: false, error: { code: 'not-mergeable', message: 'GitHub is still checking whether this pull request can merge; close this dialog, refresh, and try again shortly.' } };
      }
      // Pinned to the renderer's own dialog-open-time snapshot (just verified identical to
      // `fresh.headSha` above), not `fresh.headSha` alone, per the security remediation above.
      await gh.mergePullRequest(resolved.path, number, method, expectedHeadSha);
      forgetCache(repositoryId, number);
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST, async (_event, repositoryId: unknown, number: unknown) => {
    if (typeof repositoryId !== 'string' || !isValidPullRequestNumber(number)) {
      return invalidArgument(`${IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST} expects (repositoryId, number)`);
    }
    const repository = manager.registry.getRepository(repositoryId);
    if (!repository) return notFound(`Repository not found: ${repositoryId}`);
    try {
      // High remediation (corroborated by 3 of 4 reviewers): resolves a collision-free name
      // FIRST (pr-<n>, pr-<n>-2, ...) instead of assuming the fixed `pr-<n>` is always free --
      // see `uniquePullRequestBranchName`'s own doc comment for the exact data-loss scenario.
      const localBranchName = await uniquePullRequestBranchName(repository.path, number);
      const { worktreePath, branch } = await addWorktreeFromPullRequestBranch(repository.path, number, localBranchName);
      const view = await gh.viewPullRequestDetail(repository.path, number).catch(() => null);
      const now = new Date().toISOString();
      const session: Session = {
        id: randomUUID(),
        repositoryId,
        name: branch,
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
      try {
        await manager.registry.addSession(session);
      } catch (err) {
        // Security remediation (Medium): mirrors sessions.ts's SESSIONS_CREATE fix -- `addSession`
        // can fail with `not-found` when the Repository was removed while
        // `uniquePullRequestBranchName`/`addWorktreeFromPullRequestBranch` above were still in
        // flight, which would otherwise strand the worktree/branch just created. Reuses the same
        // `git worktree remove --force` helper `removeSessionWorktree` falls back to for a
        // registered worktree (this one always is, having just been created), rather than a
        // second cleanup path.
        await removeWorktree(repository.path, worktreePath, branch, { deleteBranch: true }).catch(() => undefined);
        return mapStoreThrown(err);
      }
      manager.notifyListChanged();
      return { ok: true, value: session };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });
}
