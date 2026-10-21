// Deterministic fake `gh` CLI for `scripts/verify-1121-pr-polish.mjs` (issues #1120, #1121,
// #1131, #1132): a real `gh.exe` (compiled at run time, see `verify-1121-fake-gh-launcher.rs`'s
// own header comment for why a `.cmd`/`.bat` shim does not work) that answers every `gh`
// invocation `src-tauri/src/github/gh.rs`/`gh_pull_requests.rs`/`gh_mutations.rs` makes for the
// "All" tab's `list`/`detail` surface, from a fixed, offline fixture set -- every check state
// (failed, pending/running, passed, none) and every pull request state this lane's issues care
// about (open, draft, closed, merged, open-with-conflicts, open-blocked, open-still-checking),
// never real GitHub. Owner/repo resolution (`owner_repo_for`) is plain local `git remote
// get-url origin`, so the scratch repository this module also builds never needs network
// access either.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_OWNER = 'fake-owner';
export const FAKE_REPO = 'fake-repo-1121';
export const FAKE_REMOTE_URL = `https://github.com/${FAKE_OWNER}/${FAKE_REPO}.git`;

const AUTHOR = { login: 'octocat', name: 'The Octocat' };
const NOW = '2026-10-21T12:00:00.000Z';

// One row per state this lane's four issues need distinguished: #1121's four check colours
// (passed/failed/pending/none), #1131's three disable shapes (state-only -- draft/closed/merged
// -- versus conflict/blocked/still-checking), #1120 and #1132 are unaffected by PR *data* (a
// select's own rendered height and a header button never depend on which row is selected), so
// they are exercised against whichever row the test happens to pick.
export const PR_FIXTURES = [
  { number: 1, title: 'Add passing feature', state: 'OPEN', isDraft: false, checks: 'passed', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { number: 2, title: 'Add failing feature', state: 'OPEN', isDraft: false, checks: 'failed', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { number: 3, title: 'Checks still running', state: 'OPEN', isDraft: false, checks: 'pending', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { number: 4, title: 'No checks configured', state: 'OPEN', isDraft: false, checks: 'none', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { number: 5, title: 'Draft polish work', state: 'OPEN', isDraft: true, checks: 'none', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { number: 6, title: 'Closed without merging', state: 'CLOSED', isDraft: false, checks: 'passed', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
  { number: 7, title: 'Already merged', state: 'MERGED', isDraft: false, checks: 'passed', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
  { number: 8, title: 'Open with merge conflicts', state: 'OPEN', isDraft: false, checks: 'passed', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  { number: 9, title: 'Open but blocked', state: 'OPEN', isDraft: false, checks: 'passed', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
  { number: 10, title: 'GitHub still checking', state: 'OPEN', isDraft: false, checks: 'passed', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
];

// `mapping.rs`'s own exact reason strings (`compute_review_disabled_reason`/
// `compute_merge_disabled_reason`) -- duplicated here deliberately (this script has no access to
// the Rust source at run time) so an assertion failure names the real string it expected.
export const REASON = {
  draft: 'This pull request is a draft.',
  closed: 'This pull request is closed.',
  merged: 'This pull request is already merged.',
  conflict: 'This pull request has merge conflicts.',
  blocked: 'This pull request is blocked: required reviews or required checks have not been satisfied yet.',
  stillChecking: 'GitHub is still checking whether this pull request can merge.'
};

function checksToRollup(checks) {
  if (checks === 'passed') return [{ status: 'COMPLETED', conclusion: 'SUCCESS', state: null }];
  if (checks === 'failed') return [{ status: 'COMPLETED', conclusion: 'FAILURE', state: null }];
  if (checks === 'pending') return [{ status: 'IN_PROGRESS', conclusion: null, state: null }];
  return null;
}

function toListEntry(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    author: AUTHOR,
    headRefName: `feature-${pr.number}`,
    baseRefName: 'main',
    updatedAt: NOW,
    statusCheckRollup: checksToRollup(pr.checks),
    labels: [],
    reviewRequests: [],
    assignees: []
  };
}

function toViewDetail(pr) {
  return {
    ...toListEntry(pr),
    commits: [{ oid: `sha-${pr.number}`, messageHeadline: `Commit for #${pr.number}` }],
    mergeStateStatus: pr.mergeStateStatus,
    mergeable: pr.mergeable,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    files: [{ path: 'file.txt', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
    headRefOid: `head-${pr.number}`,
    body: `Description for pull request #${pr.number}.`,
    isCrossRepository: false,
    headRepositoryOwner: null
  };
}

/** The fake `gh` dispatcher, written fresh into `destDir/fake-gh-logic.cjs` every run (never a
 * checked-in copy with stale fixture data): handles exactly the `gh` invocations this feature's
 * Rust code makes for the "All" tab's list and detail calls -- `pr list --state <s> --json ...`,
 * `pr view <n> --json ...`, `api graphql` (the Overview timeline/review-threads query, answered
 * with an empty but well-shaped timeline -- this lane does not test the Overview tab), `api
 * repos/.../pulls/<n>/files --paginate` (answered `[]`, falls back to the porcelain `files`
 * field) and `repo view ... --json mergeCommitAllowed,...` (the allowed-merge-methods probe).
 * Any other invocation is a hard failure (never a silent empty success), so a code path this
 * fixture set does not yet cover fails loudly instead of returning a misleadingly empty list. */
function fakeGhLogicSource() {
  const fixturesJson = JSON.stringify(PR_FIXTURES);
  return `#!/usr/bin/env node
'use strict';
const PR_FIXTURES = ${fixturesJson};
const AUTHOR = ${JSON.stringify(AUTHOR)};
const NOW = ${JSON.stringify(NOW)};

${checksToRollup.toString()}
${toListEntry.toString()}
${toViewDetail.toString()}

const args = process.argv.slice(2);

function emit(value) {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
function fail(message) {
  process.stderr.write(message + '\\n');
  process.exit(1);
}

if (args[0] === 'pr' && args[1] === 'list') {
  const stateIdx = args.indexOf('--state');
  const state = stateIdx >= 0 ? args[stateIdx + 1] : 'open';
  let rows = PR_FIXTURES;
  if (state === 'open') rows = PR_FIXTURES.filter((p) => p.state === 'OPEN');
  else if (state === 'closed') rows = PR_FIXTURES.filter((p) => p.state === 'CLOSED' || p.state === 'MERGED');
  emit(rows.map(toListEntry));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const number = Number(args[2]);
  const pr = PR_FIXTURES.find((p) => p.number === number);
  if (!pr) fail('fake gh: no fixture pull request #' + number);
  emit(toViewDetail(pr));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const fIdx = args.indexOf('-F');
  const numberArg = fIdx >= 0 ? args[fIdx + 1] : null;
  const number = numberArg && numberArg.startsWith('number=') ? Number(numberArg.slice('number='.length)) : null;
  emit({
    data: {
      repository: {
        pullRequest: {
          id: 'PR_fixture_' + (number ?? 0),
          reviewThreads: { nodes: [] },
          timelineItems: { nodes: [] }
        }
      }
    }
  });
} else if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/') && args[1].includes('/files')) {
  emit([]);
} else if (args[0] === 'repo' && args[1] === 'view') {
  emit({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true });
} else {
  fail('fake gh: unhandled command: gh ' + args.join(' '));
}
`;
}

/** Compiles the native `gh.exe` shim (plain `rustc`, no `cargo`/shared `CARGO_TARGET_DIR` --
 * same standalone-compile precedent as `verify-tauri-scratch-helpers.mjs`'s own `buildLauncher`)
 * and writes this run's `fake-gh-logic.cjs` beside it. Returns `destDir`, meant to be prepended
 * to the launched app's own `PATH` so `resolve_gh`'s `which::which_global("gh")` finds this
 * fixture-backed shim before any real `gh` installed on the machine. */
export function buildFakeGh(destDir) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(path.join(destDir, 'fake-gh-logic.cjs'), fakeGhLogicSource());
  const src = path.join(__dirname, 'verify-1121-fake-gh-launcher.rs');
  const out = path.join(destDir, 'gh.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`buildFakeGh: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return destDir;
}

function spawnSync_(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** A scratch git repository whose `origin` remote resolves to the fake owner/repo above --
 * `owner_repo_for` only ever reads this locally (`git remote get-url origin`), never reaches
 * the network, so the remote need not be real or reachable. */
export function makeFakeGithubRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (gitArgs) => {
    const result = spawnSync_('git', ['-C', dir, ...gitArgs]);
    if (result.status !== 0) throw new Error(`makeFakeGithubRepo: git ${gitArgs.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-1121', '-c', 'user.email=verify-1121@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  run(['remote', 'add', 'origin', FAKE_REMOTE_URL]);
  return dir;
}
