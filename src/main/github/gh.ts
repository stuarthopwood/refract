// GitHub CLI (`gh`) access for pull request management (specs/003-pull-request-management).
// Mirrors `src/main/git/git.ts`'s execFile discipline: no shell, argument arrays only, an
// absolute resolved path (`resolveExecutable`, security: never a bare name on PATH, which Windows
// would otherwise search `cwd` for first). Every command shape and field name below is cited to
// research.md / docs/spike/FINDINGS.md rows 37 to 41 (live-probed 2026-10-04 against gh 2.102.0),
// except where noted as a reasonable, documented-gh-CLI addition beyond the literal probe set
// (isDraft/body/updatedAt/headRefOid on `gh pr view --json`: standard, documented fields, same
// family already used by `gh pr list --json` in the same probe).
//
// Distinct from the existing `src/main/git/github.ts` (spec 004's `pullRequestForBranch`, a
// narrower never-throwing lookup for the readout chip) -- that module is unmodified by this one.

import { execFile } from 'node:child_process';
import { resolveExecutable } from '../process/executables';
import { gitRaw } from '../git/git';
import type { MergeMethod, ReviewVerdict } from '../../shared/github';

export type GhErrorCode = 'no-github-remote' | 'gh-unavailable' | 'rate-limited' | 'github-failed' | 'not-mergeable';

export class GhError extends Error {
  readonly code: GhErrorCode;
  constructor(code: GhErrorCode, message: string) {
    super(message);
    this.name = 'GhError';
    this.code = code;
  }
}

const TIMEOUT_MS = 15_000;

export interface GhRawResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs `gh <args>` with no shell in `cwd`. Never throws for a nonzero exit; callers branch on
  * `.code`. Throws `GhError('gh-unavailable', ...)` only when `gh` itself cannot be found on PATH.
  * Executor form: `Promise.withResolvers()` needs lib "ES2024"; tsconfig.node.json is pinned to
  * "ES2023" (same documented exception as `OmpProcess.ts`'s `start()` and the existing
  * `src/main/git/github.ts`'s `runGh()`). */
export async function ghRaw(cwd: string, args: string[]): Promise<GhRawResult> {
  let ghPath: string;
  try {
    ghPath = await resolveExecutable('gh');
  } catch {
    throw new GhError('gh-unavailable', 'The GitHub CLI (gh) is not installed or not on PATH.');
  }
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    execFile(
      ghPath,
      args,
      { cwd, windowsHide: true, signal: controller.signal },
      (error: Error | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        let code = 0;
        if (error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'number') {
          code = (error as { code: number }).code;
        } else if (error !== null) {
          code = 1;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      }
    );
  });
}

/** Research.md "Polling interval and rate-limit headroom": the rate-limited signal is `gh`'s own
  * `HTTPError.Error()` format ("HTTP 403/429: <GitHub message> (<url>)") sourced from cli/go-gh's
  * published error formatting, not reproduced live (forbidden -- real shared-account quota risk,
  * docs/spike/FINDINGS.md row 40). `gh-unavailable` covers not-signed-in and offline per FR-026. */
function mapGhFailure(stderr: string, stdout: string): GhError {
  const text = `${stderr}\n${stdout}`;
  if (/rate limit/i.test(text)) {
    return new GhError('rate-limited', stderr.trim() || stdout.trim() || 'GitHub rate limit exceeded.');
  }
  if (/gh auth login|not logged into|authentication required|could not resolve|enotfound|getaddrinfo|network is unreachable/i.test(text)) {
    return new GhError('gh-unavailable', stderr.trim() || stdout.trim() || 'GitHub CLI is not signed in or GitHub is unreachable.');
  }
  return new GhError('github-failed', stderr.trim() || stdout.trim() || 'gh command failed.');
}

export async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
  const { stdout, stderr, code } = await ghRaw(cwd, args);
  if (code !== 0) throw mapGhFailure(stderr, stdout);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhError('github-failed', `gh returned invalid JSON for: gh ${args.join(' ')}`);
  }
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** `gh api graphql -f query=<query> [-f k=v | -F k=v]...` (docs/spike/gh-pr-graphql-probe.mjs's
  * own `graphql()` helper, confirmed live). Variables are passed as `-f`/`-F` fields, never
  * interpolated into the query string, so no caller-supplied text (a comment body, a thread id)
  * can ever need hand-escaping or risk breaking/injecting into the query. */
export async function ghGraphql<T>(cwd: string, query: string, variables?: Record<string, string | number>): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    }
  }
  const { stdout, stderr, code } = await ghRaw(cwd, args);
  if (code !== 0) throw mapGhFailure(stderr, stdout);
  let parsed: GraphqlResponse<T>;
  try {
    parsed = JSON.parse(stdout) as GraphqlResponse<T>;
  } catch {
    throw new GhError('github-failed', 'gh api graphql returned invalid JSON.');
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new GhError('github-failed', parsed.errors.map((e) => e.message).join('; '));
  }
  if (!parsed.data) throw new GhError('github-failed', 'gh api graphql returned no data.');
  return parsed.data;
}

/** `owner/repo`, inferred from the repository's `origin` remote URL (duplicated from the
  * existing `src/main/git/github.ts`'s private `parseOwnerRepo`, which is not exported -- kept as
  * its own small copy here rather than changing that spec-004 module's exports). */
export async function ownerRepoFor(repoPath: string): Promise<{ owner: string; repo: string }> {
  const remote = await gitRaw(repoPath, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0) throw new GhError('no-github-remote', 'This repository has no "origin" remote.');
  const trimmed = remote.stdout.trim();
  const httpsMatch = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshMatch && sshMatch[1] && sshMatch[2]) return { owner: sshMatch[1], repo: sshMatch[2] };
  throw new GhError('no-github-remote', "This repository's origin remote is not a github.com remote.");
}

// ---------------------------------------------------------------------------
// Wire shapes gh/GitHub return (mapped to src/shared/github.ts types by pullRequests.ts)
// ---------------------------------------------------------------------------

export interface GhActor {
  login: string;
  name?: string | null;
}

export interface GhLabel {
  name: string;
}

export interface GhCheckRun {
  status?: string; // e.g. 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED'
  conclusion?: string; // e.g. 'SUCCESS' | 'FAILURE' | 'CANCELLED' | ...
  state?: string; // legacy commit-status shape: 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ERROR'
}

/** `gh pr list --json <LIST_FIELDS>` (docs/spike/FINDINGS.md row 37, T001): every field name
  * round-trips unchanged against a real repository. */
export interface GhPrListEntry {
  number: number;
  title: string;
  state: string; // 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean;
  author: GhActor;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  statusCheckRollup: GhCheckRun[] | null;
  labels: GhLabel[];
  reviewRequests: GhActor[];
  assignees: GhActor[];
}

const LIST_FIELDS =
  'number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,statusCheckRollup,labels,reviewRequests,assignees';

/** High remediation (code-reviewer): `--state open` directly, not `--state all --limit 50`
  * filtered client-side to OPEN afterward -- the old form missed any open pull request older than
  * the 50 most-recently-updated pull requests of ANY state. `--state open` scopes the whole
  * 50-row limit to open pull requests only. */
export async function listOpenPullRequests(repoPath: string): Promise<GhPrListEntry[]> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  return ghJson<GhPrListEntry[]>(repoPath, ['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '50', '--json', LIST_FIELDS]);
}

/** `gh search prs --repo <repo> "<qualifier>" --json <SEARCH_FIELDS>` (row 37, T001): a narrower,
  * documented field set than `gh pr list --json` -- no `statusCheckRollup`/`headRefName`/
  * `baseRefName`/`isDraft`/`assignees`-equivalent on this surface beyond what's listed here. */
export interface GhSearchEntry {
  number: number;
  title: string;
  state: string; // 'open' | 'closed' on the search surface
  author: GhActor;
  url: string;
  updatedAt: string;
  labels: GhLabel[];
}

const SEARCH_FIELDS = 'number,title,state,author,url,updatedAt,labels';

/** One of the 4 built-in narrowing qualifiers this feature offers (data-model.md's own list):
  * `--author @me` / `--assignee @me` / `--involves @me` / `--review-requested @me`, never the
  * bare `author:@me` qualifier string -- `gh search prs` has its own named flag per qualifier. */
export type SearchQualifierFlag = '--author' | '--assignee' | '--involves' | '--review-requested';

/** High remediation (code-reviewer Critical-adjacent): the qualifier and the user's free-text
  * narrowing query used to be joined into one argv entry (`"author:@me foo"`), which `gh search
  * prs` genuinely misparses -- confirmed live: it quotes the ENTIRE string as the `author:` value
  * (`author:"@me foo"`), rejecting it outright as an unknown user. Passing the qualifier via its
  * own named flag and the free text as a separate positional argv entry is what `gh search prs
  * --author @me foo` does at a real shell, and is the form gh's parser actually expects.
  *
  * Medium remediation (new regression, this round): the free-text query was pushed as a bare
  * positional with no `--` separator, so GitHub's own exclusion syntax (`-label:bug`) was parsed
  * as an unknown `gh` shorthand flag and errored, while a query like `--repo=other/repo` was
  * silently ACCEPTED as a real flag and changed which repository was searched. `gh search --help`
  * documents `--` as the literal separator between flags and the search query; pushing it ahead
  * of `query` makes `-label:` text safe and makes `--repo=`-style text an inert search term. */
export async function searchPullRequests(repoPath: string, qualifierFlag: SearchQualifierFlag, query?: string): Promise<GhSearchEntry[]> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const args = ['search', 'prs', '--repo', `${owner}/${repo}`, qualifierFlag, '@me'];
  if (query) args.push('--', query);
  args.push('--json', SEARCH_FIELDS);
  return ghJson<GhSearchEntry[]>(repoPath, args);
}

/** The search surface has no `statusCheckRollup` (row 37); fetched per-row via a second
  * `gh pr view --json statusCheckRollup` call for the non-Open tabs only (small result counts).
  * High remediation (code-reviewer): takes an already-resolved `owner/repo` rather than a
  * `repoPath`, so the caller resolves it ONCE per request (`ownerRepoFor` itself runs a real `git
  * remote get-url` process) instead of once per row -- up to ~30 redundant git spawns per tab
  * switch, on top of the ~30 `gh pr view` spawns this function already makes. */
export async function viewCheckState(repoPath: string, ownerRepo: string, number: number): Promise<GhCheckRun[] | null> {
  const result = await ghJson<{ statusCheckRollup: GhCheckRun[] | null }>(repoPath, [
    'pr',
    'view',
    String(number),
    '--repo',
    ownerRepo,
    '--json',
    'statusCheckRollup'
  ]);
  return result.statusCheckRollup;
}

/** `gh pr view --json <VIEW_FIELDS>` (row 38, T002): `mergeable`/`mergeStateStatus` confirmed
  * live as `"MERGEABLE"`/`"CLEAN"` string enums on a clean PR; `files` never carries `patch`.
  * `isDraft`/`body`/`updatedAt`/`headRefOid` are standard documented `gh pr view --json` fields
  * (same family as `gh pr list --json`'s own fields) added for the Overview/staleness needs this
  * spec has beyond the literal T002 probe's own field list. */
export interface GhPrViewDetail {
  title: string;
  number: number;
  state: string;
  author: GhActor;
  baseRefName: string;
  headRefName: string;
  reviews: Array<{ id: string; author: GhActor; state: string; body: string; submittedAt: string }>;
  reviewRequests: GhActor[];
  assignees: GhActor[];
  labels: GhLabel[];
  commits: Array<{ oid: string; messageHeadline?: string }>;
  mergeStateStatus: string;
  mergeable: string; // 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
  isDraft: boolean;
  statusCheckRollup: GhCheckRun[] | null;
  updatedAt: string;
  headRefOid: string;
  body: string;
  // Security remediation (Medium-but-must-fix): `isCrossRepository` is `gh`'s own documented
  // "head and base are in different repositories" flag -- true for a fork pull request, whose
  // code a "New session" would check out and run an agent against untrusted.
  isCrossRepository: boolean;
  headRepositoryOwner: GhActor | null;
}

const VIEW_FIELDS =
  'title,number,state,author,baseRefName,headRefName,reviews,reviewRequests,assignees,labels,commits,' +
  'mergeStateStatus,mergeable,additions,deletions,changedFiles,files,isDraft,statusCheckRollup,' +
  'updatedAt,headRefOid,body,isCrossRepository,headRepositoryOwner';

export async function viewPullRequestDetail(repoPath: string, number: number): Promise<GhPrViewDetail> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  return ghJson<GhPrViewDetail>(repoPath, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', VIEW_FIELDS]);
}

/** Cheap staleness re-fetch (FR-021): only the fields a mutating action compares against the
  * cache or needs to re-derive `reviewDisabledReason`/`mergeDisabledReason`, never the full
  * detail. `id` (the GraphQL node id) is included so `submitReview`'s approve path can pin its
  * mutation to the exact reviewed commit via `commitOID` (security remediation, Medium-but-must-
  * fix: approve/merge must never act on a head that moved since the renderer last saw it). */
export interface GhStalenessCheck {
  id: string;
  updatedAt: string;
  headSha: string;
  mergeable: string;
  mergeStateStatus: string;
  isDraft: boolean;
  state: string;
}

export async function viewStalenessCheck(repoPath: string, number: number): Promise<GhStalenessCheck> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const result = await ghJson<{
    id: string;
    updatedAt: string;
    headRefOid: string;
    mergeable: string;
    mergeStateStatus: string;
    isDraft: boolean;
    state: string;
  }>(repoPath, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'id,updatedAt,headRefOid,mergeable,mergeStateStatus,isDraft,state']);
  return {
    id: result.id,
    updatedAt: result.updatedAt,
    headSha: result.headRefOid,
    mergeable: result.mergeable,
    mergeStateStatus: result.mergeStateStatus,
    isDraft: result.isDraft,
    state: result.state
  };
}

/** REST `repos/<owner>/<repo>/pulls/<number>/files` (row 38, T002): the only surface that carries
  * `patch`; absent (never `null`) once a file exceeds GitHub's per-file size threshold. Returns
  * `null` (never throws) on any failure so the caller can fall back to the porcelain `files` field
  * (every `patch` null) plus the FR-011 truncation banner. */
export interface GhRestFile {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
  status: string;
}

/** High remediation (code-reviewer): `--paginate` (gh's own documented way to follow every
  * `Link: rel="next"` page) so a pull request with more than GitHub's default 30-per-page REST
  * limit no longer silently drops files past the first page -- `gh api --paginate` concatenates
  * every page's JSON array into one before this ever sees it.
  *
  * CRITICAL regression fix (this round): the previous version additionally passed `-f
  * per_page=100`. `gh api`'s own documented behavior is that ANY `-f`/`-F`/`--input` body
  * parameter forces the request method to POST unless `--method` is given explicitly -- this is
  * true even for a GET-only endpoint like `.../pulls/<number>/files`, and GitHub's REST API
  * rejects a POST to that path with a 404 (not a 405), which looks exactly like "this PR has no
  * files" rather than a method error. `--paginate` already appends its own `per_page=100` to the
  * request URL with no body parameter and no method change, so the explicit `-f` was always
  * redundant even before it was discovered to silently break every single PR's Changes tab. */
export async function getChangedFilesWithPatch(repoPath: string, number: number): Promise<GhRestFile[] | null> {
  try {
    const { owner, repo } = await ownerRepoFor(repoPath);
    return await ghJson<GhRestFile[]>(repoPath, ['api', `repos/${owner}/${repo}/pulls/${number}/files`, '--paginate']);
  } catch {
    return null;
  }
}

/** `reviewThreads`/`timelineItems` (row 39, T003): connection shapes confirmed live via
  * introspection + a live query. `itemTypes` filters the timeline to the three kinds this feature
  * renders (commits, general comments, submitted reviews) -- review threads come from the
  * separate `reviewThreads` connection on the same query, not from `timelineItems`. */
export interface GhReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  diffSide: string; // 'LEFT' | 'RIGHT'
  comments: { nodes: Array<{ id: string; author: GhActor | null; body: string; createdAt: string }> };
}

export interface GhTimelineNode {
  __typename: string;
  // PullRequestCommit
  commit?: { oid: string; message: string; committedDate: string; author?: { name: string } | null };
  // IssueComment
  id?: string;
  author?: GhActor | null;
  body?: string;
  createdAt?: string;
  // PullRequestReview
  state?: string;
  submittedAt?: string;
}

export interface GhThreadsAndTimeline {
  id: string; // the pull request's own GraphQL node id, needed by addPullRequestReviewComment
  reviewThreads: { nodes: GhReviewThreadNode[] };
  timelineItems: { nodes: GhTimelineNode[] };
}

const THREADS_AND_TIMELINE_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { ' +
  'pullRequest(number: $number) { id ' +
  'reviewThreads(first: 50) { nodes { id isResolved isOutdated path line diffSide ' +
  'comments(first: 50) { nodes { id author { login ... on User { name } } body createdAt } } } } ' +
  'timelineItems(first: 100, itemTypes: [PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW]) { nodes { __typename ' +
  '... on PullRequestCommit { commit { oid message committedDate author { name } } } ' +
  '... on IssueComment { id author { login ... on User { name } } body createdAt } ' +
  '... on PullRequestReview { id author { login ... on User { name } } state body submittedAt } } } } } }';

export async function getReviewThreadsAndTimeline(repoPath: string, number: number): Promise<GhThreadsAndTimeline> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const data = await ghGraphql<{ repository: { pullRequest: GhThreadsAndTimeline } }>(repoPath, THREADS_AND_TIMELINE_QUERY, {
    owner,
    name: repo,
    number
  });
  return data.repository.pullRequest;
}

/** `resolveReviewThread`/`unresolveReviewThread` (row 39, T003): input shapes confirmed via
  * introspection only; never executed live in this session. Variables, never string
  * interpolation, so a thread id never needs hand-escaping. */
export async function resolveReviewThreadMutation(repoPath: string, threadId: string): Promise<void> {
  const query = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
  await ghGraphql(repoPath, query, { id: threadId });
}

export async function unresolveReviewThreadMutation(repoPath: string, threadId: string): Promise<void> {
  const query = 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
  await ghGraphql(repoPath, query, { id: threadId });
}

/** `addPullRequestReviewComment(input: { inReplyTo: ... })` (row 39, T003): `inReplyTo` confirmed
  * as a real, current input field. Links the reply to the thread's opening comment, never a new
  * unrelated top-level comment. */
export async function replyToThreadMutation(
  repoPath: string,
  pullRequestId: string,
  inReplyToCommentId: string,
  body: string
): Promise<{ id: string }> {
  const query =
    'mutation($pr: ID!, $reply: ID!, $body: String!) { addPullRequestReviewComment(input: { pullRequestId: $pr, inReplyTo: $reply, body: $body }) { comment { id } } }';
  const data = await ghGraphql<{ addPullRequestReviewComment: { comment: { id: string } } }>(repoPath, query, {
    pr: pullRequestId,
    reply: inReplyToCommentId,
    body
  });
  return data.addPullRequestReviewComment.comment;
}

/** A top-level pull request comment (FR-012), distinct from a thread reply: the documented
  * porcelain `gh pr comment` command already covers it (research.md decision 3's own preference
  * for porcelain wherever it suffices), no GraphQL mutation needed. */
export async function commentOnPullRequest(repoPath: string, number: number, body: string): Promise<void> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const { code, stderr, stdout } = await ghRaw(repoPath, ['pr', 'comment', String(number), '--repo', `${owner}/${repo}`, '--body', body]);
  if (code !== 0) throw mapGhFailure(stderr, stdout);
}

const ADD_REVIEW_MUTATION =
  'mutation($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!, $body: String) { ' +
  'addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event, body: $body }) { clientMutationId } }';

/** `gh pr review` (FR-015): documented porcelain command for comment/request-changes (not
  * independently live-probed this session; a mutating action, never executed here). Approve is
  * pinned to the exact reviewed commit (security remediation, Medium-but-must-fix) via the
  * `addPullRequestReview` GraphQL mutation's `commitOID`.
  *
  * CORRECTED (round 3): the prior comment here claimed GitHub "refuses" this mutation if the head
  * moved since `pullRequestId`/`commitOID` were read -- that was never true and is now proven
  * false by GitHub's own documented behavior: `commitOID` on `addPullRequestReview` only RECORDS
  * which commit the review is attached to display-side (shown as "reviewed <sha>" in the UI); it
  * is not a precondition GitHub validates against the current head, and the mutation succeeds
  * even if the head has since moved. `gh pr merge --match-head-commit` (below) is the only one of
  * these two mutations with a real server-side head-match guarantee; approve's own staleness
  * protection comes entirely from the IPC handler's `expectedHeadSha` check run immediately
  * before this call (pullRequests.ts), not from anything GitHub itself enforces here. */
export async function submitReview(
  repoPath: string,
  number: number,
  verdict: ReviewVerdict,
  body: string | undefined,
  pinned?: { pullRequestId: string; headSha: string }
): Promise<void> {
  if (verdict === 'approve' && pinned) {
    const variables: Record<string, string> = {
      pullRequestId: pinned.pullRequestId,
      commitOID: pinned.headSha,
      event: 'APPROVE'
    };
    if (body) variables.body = body;
    await ghGraphql(repoPath, ADD_REVIEW_MUTATION, variables);
    return;
  }
  const { owner, repo } = await ownerRepoFor(repoPath);
  const flag = verdict === 'approve' ? '--approve' : verdict === 'request-changes' ? '--request-changes' : '--comment';
  const args = ['pr', 'review', String(number), '--repo', `${owner}/${repo}`, flag];
  if (body) args.push('--body', body);
  const { code, stderr, stdout } = await ghRaw(repoPath, args);
  if (code !== 0) throw mapGhFailure(stderr, stdout);
}

/** `gh pr merge` (FR-016): documented porcelain command, not independently live-probed this
  * session (a mutating action; never executed here). Maps a "not mergeable" refusal (conflicts or
  * a failing required check) to `GhErrorCode 'not-mergeable'`, distinct from a generic failure. */
/** Repository-level merge-method settings (`gh repo view --json`, a standard documented field
  * set -- not independently live-probed this session, no mutation involved). Maps to the
  * `MergeMethod[]` a pull request's `allowedMergeMethods` offers. */
export async function getAllowedMergeMethods(repoPath: string): Promise<MergeMethod[]> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const result = await ghJson<{ mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean }>(
    repoPath,
    ['repo', 'view', `${owner}/${repo}`, '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed']
  );
  const methods: MergeMethod[] = [];
  if (result.mergeCommitAllowed) methods.push('merge');
  if (result.squashMergeAllowed) methods.push('squash');
  if (result.rebaseMergeAllowed) methods.push('rebase');
  return methods;
}

/** `headSha` is always passed (security remediation, Medium-but-must-fix): `--match-head-commit`
  * makes GitHub itself refuse the merge if the pull request's head has moved since the renderer
  * last saw it, independent of (and a stronger guarantee than) the in-process staleness cache. */
export async function mergePullRequest(repoPath: string, number: number, method: MergeMethod, headSha: string): Promise<void> {
  const { owner, repo } = await ownerRepoFor(repoPath);
  const flag = method === 'merge' ? '--merge' : method === 'squash' ? '--squash' : '--rebase';
  const { code, stderr, stdout } = await ghRaw(repoPath, [
    'pr',
    'merge',
    String(number),
    '--repo',
    `${owner}/${repo}`,
    flag,
    '--match-head-commit',
    headSha
  ]);
  if (code !== 0) {
    const text = `${stderr}\n${stdout}`;
    if (/not mergeable|conflict|required status check|review.*required|changes.*requested|match-head-commit|head commit/i.test(text)) {
      throw new GhError('not-mergeable', stderr.trim() || stdout.trim() || 'This pull request cannot be merged.');
    }
    throw mapGhFailure(stderr, stdout);
  }
}
