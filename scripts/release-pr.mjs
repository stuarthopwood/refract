// Pure helpers for `release.mjs`'s release-PR route (#2128, spec 006 FR-036 to FR-040): argument
// parsing, the branch and PR preconditions, the step plans and every recovery message. No I/O,
// so each rule has a unit test in `release-pr.test.mjs`.

import { SEMVER_RE } from './release-versions.mjs';

export const LEVELS = ['patch', 'minor', 'major'];

const RELEASE_BRANCH_RE = /^release\/v(\d+\.\d+\.\d+)$/;

export function releaseBranchName(version) {
  return `release/v${version}`;
}

// A one-commit branch makes `gh stack submit --auto` title the PR with the commit subject.
export function releaseCommitSubject(version) {
  return `chore(release): v${version}`;
}

// `--finish` takes the tag name; both `v1.2.3` and `1.2.3` are accepted.
export function parseArgs(argv) {
  const args = { dryRun: false, level: null, finishVersion: null };
  const unknown = [];
  let finishSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--finish') {
      finishSeen = true;
      const value = (argv[(i += 1)] ?? '').replace(/^v/, '');
      if (!SEMVER_RE.test(value)) {
        throw new Error(`--finish needs the release tag, e.g. --finish v1.2.3 (got "${argv[i] ?? ''}")`);
      }
      args.finishVersion = value;
    } else if (LEVELS.includes(arg) && !args.level) args.level = arg;
    else unknown.push(arg);
  }
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(', ')}`);
  if (finishSeen && args.level) {
    throw new Error(`--finish tags an already-cut release and takes no bump level (got ${args.level})`);
  }
  return args;
}

// `pnpm release` runs only from `main` (it cuts the branch) or from a `release/*` branch (a re-run).
export function classifyBranch(branch) {
  if (branch === 'main') return { kind: 'main', version: null };
  if (branch.startsWith('release/')) {
    return { kind: 'release', version: RELEASE_BRANCH_RE.exec(branch)?.[1] ?? null };
  }
  throw new Error(`must be run on branch main or a release/* branch (current: ${branch})`);
}

export function assertCleanTree(status) {
  if (status) throw new Error(`working tree is not clean -- commit, stash, or remove these first:\n${status}`);
}

export function assertHeadAtOriginMain(head, originMain) {
  if (head !== originMain) {
    throw new Error(`HEAD (${head}) does not equal origin/main (${originMain}); pull or rebase first`);
  }
}

// The version is only known after inference, so a `release/*` start branch is checked against it late.
export function assertBranchMatchesVersion(info, branch, version) {
  if (info.kind === 'release' && branch !== releaseBranchName(version)) {
    throw new Error(
      `on ${branch} but this release is v${version}; switch to main (a new ${releaseBranchName(version)} is cut ` +
        `for you) or to ${releaseBranchName(version)}`,
    );
  }
}

export const PR_STEPS = ['push', 'stack-init', 'submit'];

const PR_STEP_LABELS = {
  push: 'push of the release branch',
  'stack-init': 'gh stack init',
  submit: 'gh stack submit',
};

// Flags only, never a prompt (docs/stacked-prs.md), and never `gh pr create`.
export function prStepCommands(version) {
  const branch = releaseBranchName(version);
  return {
    push: ['git', 'push', '--set-upstream', 'origin', branch],
    'stack-init': ['gh', 'stack', 'init', '--base', 'main', branch],
    submit: ['gh', 'stack', 'submit', '--auto', '--open', '--remote', 'origin'],
  };
}

const join = (argv) => argv.join(' ');

// The commands from `stepId` on, so a resume repeats nothing that already landed.
export function resumeFromStep(stepId, version) {
  const commands = prStepCommands(version);
  return PR_STEPS.slice(PR_STEPS.indexOf(stepId))
    .map((id) => join(commands[id]))
    .join(' && ');
}

export function prStepFailureMessage(stepId, version, { interrupted = false, detail = '' } = {}) {
  const branch = releaseBranchName(version);
  const cause = interrupted ? 'was stopped by SIGINT/SIGTERM' : `failed: ${detail}`;
  return (
    `release: "${releaseCommitSubject(version)}" is committed on ${branch}, but the ${PR_STEP_LABELS[stepId]} step ` +
    `${cause}. Nothing was pushed to main and no tag exists. A plain re-run of pnpm release will NOT work here ` +
    `(the manifests are already at v${version}). Resume from that step: ${resumeFromStep(stepId, version)}  ` +
    `(then, once the PR is merged)  pnpm release --finish v${version}. To abandon: git switch main && git branch -D ` +
    `${branch}, and git push origin --delete ${branch} if it was already pushed.`
  );
}

export function openedPrMessage(version, pr) {
  const where = pr ? `${pr.url} (#${pr.number})` : `release/v${version}`;
  const merge = pr ? `gh pr merge ${pr.number} --squash --delete-branch` : 'gh pr merge <pr> --squash --delete-branch';
  return [
    `release: opened ${where} titled "${releaseCommitSubject(version)}". Stopping here: nothing was pushed to main.`,
    `release: wait for its checks (CodeQL included), then squash-merge it: ${merge}`,
    `release: a one-PR stack cannot use gh stack merge (docs/stacked-prs.md). After the merge, resume with:`,
    `  pnpm release --finish v${version}`,
  ].join('\n');
}

// `gh pr list --head release/vX.Y.Z --state all --json number,state,url,baseRefName,mergeCommit`.
export function pickMergedReleasePr(prs, version) {
  const branch = releaseBranchName(version);
  const onMain = prs.filter((p) => p.baseRefName === 'main').sort((a, b) => b.number - a.number);
  if (onMain.length === 0) {
    throw new Error(`no pull request from ${branch} into main was found; run pnpm release first`);
  }
  const merged = onMain.find((p) => p.state === 'MERGED' && p.mergeCommit?.oid);
  if (merged) return { number: merged.number, url: merged.url, sha: merged.mergeCommit.oid };
  const open = onMain.find((p) => p.state === 'OPEN');
  if (open) {
    throw new Error(
      `${open.url} is still open; wait for its checks, then merge it (gh pr merge ${open.number} --squash ` +
        `--delete-branch) and re-run: pnpm release --finish v${version}`,
    );
  }
  throw new Error(`${onMain[0].url} was closed without merging; reopen and merge it, or re-cut the release`);
}

// release-local.mjs refuses a tag whose commit disagrees with tauri.conf.json, so catch it before tagging.
export function assertCommitVersions(version, found) {
  const wrong = Object.entries(found).filter(([, v]) => v !== version);
  if (wrong.length > 0) {
    throw new Error(
      `the merged commit does not carry v${version}: ${wrong.map(([k, v]) => `${k}=${v}`).join(', ')}; ` +
        'the PR merged something other than this release',
    );
  }
}

// `git ls-remote origin refs/tags/vX refs/tags/vX^{}`: an annotated tag's peeled line names the commit.
export function parseRemoteTagSha(output, tagName) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const peeled = lines.find((l) => l.endsWith(`refs/tags/${tagName}^{}`));
  const line = peeled ?? lines.find((l) => l.endsWith(`refs/tags/${tagName}`));
  return line ? line.split(/\s+/)[0] : null;
}

// Lets `--finish` resume after a half-done run, but never moves a tag that points somewhere else.
export function decideTag({ tagName, sha, localSha, remoteSha }) {
  if (localSha && localSha !== sha) {
    throw new Error(
      `local tag ${tagName} points at ${localSha}, not the merged commit ${sha}; if it is stale, ` +
        `git tag -d ${tagName} and re-run`,
    );
  }
  if (remoteSha && remoteSha !== sha) {
    throw new Error(`origin's tag ${tagName} points at ${remoteSha}, not the merged commit ${sha}; not moving it`);
  }
  return { createLocal: !localSha, push: !remoteSha };
}

export function finishFailureMessage(stepId, version, { interrupted = false, detail = '' } = {}) {
  const tagName = `v${version}`;
  const cause = interrupted ? 'was stopped by SIGINT/SIGTERM' : `failed: ${detail}`;
  const rerun = `pnpm release --finish ${tagName}`;
  const text = {
    'verify-pr': `the check that the release PR is merged ${cause}. Nothing was tagged. Fix that, then re-run: ${rerun}`,
    tag: `creating the annotated tag ${tagName} ${cause}. Nothing was pushed. Re-run: ${rerun} (a stale wrong tag: git tag -d ${tagName} first)`,
    'push-tag':
      `pushing the tag ${tagName} ${cause}. The tag exists locally. Check first: git ls-remote origin refs/tags/${tagName}. ` +
      `If it is missing, re-run: ${rerun} (or git push origin refs/tags/${tagName}); if present, go straight to the publish step`,
  };
  return `release: ${text[stepId]}`;
}

function quote(p) {
  return /\s/.test(p) ? JSON.stringify(p) : p;
}

// release-local.mjs needs a clean tree whose HEAD carries the exact tag, so publish from a detached worktree.
export function publishCommands(version, worktreeDir) {
  const dir = quote(worktreeDir.replace(/\\/g, '/'));
  return [
    `git worktree add --detach ${dir} v${version}`,
    `cd ${dir}`,
    'pnpm install --frozen-lockfile',
    'pnpm release:local -- --notes-from-changelog',
  ];
}

export function phaseOnePlan(version, startBranch) {
  const branch = releaseBranchName(version);
  const commands = prStepCommands(version);
  return [
    startBranch === 'main' ? `git switch -c ${branch}  (from origin/main)` : `stay on ${branch}`,
    'write the four manifests and CHANGELOG.md, run pnpm ci:local',
    `git commit -m "${releaseCommitSubject(version)}"`,
    ...PR_STEPS.map((id) => join(commands[id])),
    `stop and print: pnpm release --finish v${version}  (never pushes main)`,
  ];
}

export function phaseTwoPlan(version, sha, worktreeDir) {
  const tagName = `v${version}`;
  return [
    `verify the release PR from ${releaseBranchName(version)} is merged${sha ? ` (squash commit ${sha})` : ''}`,
    `git tag -a ${tagName} -m ${tagName} ${sha ?? '<squash commit>'}`,
    `git push origin refs/tags/${tagName}`,
    'print the publish commands (not run):',
    ...publishCommands(version, worktreeDir).map((c) => `  ${c}`),
  ];
}
