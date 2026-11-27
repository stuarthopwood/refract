#!/usr/bin/env node
// `pnpm release [patch|minor|major] [--dry-run]` cuts `release/vX.Y.Z` from origin/main, commits the version bump and
// CHANGELOG.md, pushes the branch and opens a one-PR stack with `gh stack`, then stops; it never pushes `main` (GH013).
// `pnpm release --finish vX.Y.Z [--dry-run]` runs after the squash merge: it tags that commit and prints the publish commands.
// A failure before the commit restores the four manifests byte-for-byte, never via `git`. With no level, the bump is
// inferred from conventional-commit subjects since the last tag. `--dry-run` covers both phases and writes nothing.
// Usage: node scripts/release.mjs [patch|minor|major] [--dry-run] | --finish vX.Y.Z [--dry-run]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildChangelogSection,
  fetchGeneratedNotes,
  parseConventionalSubject,
  parseWhatsChangedBullets,
  prependChangelogSection,
} from './release-changelog.mjs';
import {
  CARGO_PACKAGE_NAME,
  MANIFEST_LABELS,
  assertCargoLockOnlyVersionChanged,
  bumpVersion,
  checkVersionsEqual,
  readAllVersions,
  writeManifestVersions,
} from './release-versions.mjs';
import {
  PR_STEPS,
  assertBranchMatchesVersion,
  assertCleanTree,
  assertCommitVersions,
  assertHeadAtOriginMain,
  classifyBranch,
  decideTag,
  finishFailureMessage,
  openedPrMessage,
  parseArgs,
  parseRemoteTagSha,
  phaseOnePlan,
  phaseTwoPlan,
  pickMergedReleasePr,
  prStepCommands,
  prStepFailureMessage,
  publishCommands,
  releaseBranchName,
  releaseCommitSubject,
} from './release-pr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const REPO_SLUG = 'stuarthopwood/refract';
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');

// The release files this script stages or commits; also what gets unstaged on a failed `git add`/`git commit`.
const TRACKED_RELEASE_FILES = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
];

// Set by the SIGINT/SIGTERM handler installed before the first write. Without a handler Ctrl+C
// (sent to the whole process group) would kill this script mid-edit with no restore; with one, the
// child still dies, `spawnSync` returns non-zero and the catch block restores the files.
let interrupted = false;

function installInterruptHandlers() {
  const onSignal = (signal) => {
    interrupted = true;
    console.error(`\nrelease: received ${signal}, stopping...`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Thrown by `checkInterrupted` so catch sites can tell a user stop from an ordinary failure.
class InterruptedError extends Error {}

// `main()` is synchronous, so the signal handler only runs on a real event-loop tick: a catch block
// right after a failed `spawnSync` can still see `interrupted === false` after a real SIGINT. Awaiting
// `setImmediate` lets the queued handler run; called before every irreversible step.
async function checkInterrupted() {
  await new Promise((resolve) => setImmediate(resolve));
  if (interrupted) {
    throw new InterruptedError('interrupted');
  }
}

// Best-effort and never throws: it runs inside an already-failing path and must not mask the real error.
function unstageTrackedFiles() {
  spawnSync('git', ['reset', '--quiet', 'HEAD', '--', ...TRACKED_RELEASE_FILES], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

const argv = process.argv.slice(2);

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function gitInherit(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
}

// Returns the branch it started on: `main` (a release branch is cut) or an existing `release/*` branch.
function checkPreconditions() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  classifyBranch(branch);
  assertCleanTree(git(['status', '--porcelain']));

  const fetchResult = spawnSync('git', ['fetch', 'origin'], { cwd: repoRoot, stdio: 'inherit' });
  if (fetchResult.status !== 0) fail('git fetch origin failed');

  assertHeadAtOriginMain(git(['rev-parse', 'HEAD']), git(['rev-parse', 'origin/main']));
  return branch;
}

// The highest semver `v*` tag reachable from HEAD, or null if there is none yet.
function lastTag() {
  const raw = git(['tag', '--merged', 'HEAD', '--list', 'v*']);
  const parsed = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^v(\d+)\.(\d+)\.(\d+)$/);
      return m ? { tag: t, version: `${m[1]}.${m[2]}.${m[3]}`, major: +m[1], minor: +m[2], patch: +m[3] } : null;
    })
    .filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
  return parsed[0];
}

// `--first-parent` follows only `main`'s mainline: PRs are squash-merged, so a feature branch's WIP
// commits must never be walked, and a merge commit still counts once (matching the PR-title CHANGELOG).
function commitsSince(tag) {
  const SEP = '\x1f';
  const REC = '\x1e';
  const raw = execFileSync('git', ['log', '--first-parent', `${tag}..HEAD`, `--format=%s${SEP}%b${REC}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return raw
    .split(REC)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [subject, body = ''] = rec.split(SEP);
      return { subject, body };
    });
}

const LEVEL_RANK = { patch: 1, minor: 2, major: 3 };

// `type!:` or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer => major; `feat` => minor; `fix`/`perf` =>
// patch; anything else doesn't bump. The type is case-insensitive per Conventional Commits; the
// footer keyword stays uppercase. Returns the highest level triggered, or null.
function inferLevel(commits) {
  let level = null;
  for (const c of commits) {
    const parsed = parseConventionalSubject(c.subject);
    const type = parsed?.type?.toLowerCase();
    const breakingFooter = /(^|\n)BREAKING[ -]CHANGE:/.test(c.body);
    let thisLevel = null;
    if (parsed?.breaking || breakingFooter) thisLevel = 'major';
    else if (type === 'feat') thisLevel = 'minor';
    else if (type === 'fix' || type === 'perf') thisLevel = 'patch';
    if (thisLevel && (!level || LEVEL_RANK[thisLevel] > LEVEL_RANK[level])) level = thisLevel;
  }
  return level;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

// `targetCommitish` is the branch name `main`, not a SHA: generate-notes rejected a just-pushed SHA on a
// non-default branch ("Invalid target_commitish parameter"). The tag does not exist yet in phase 1, and
// `checkPreconditions` ensures HEAD == origin/main; `--finish` never calls generate-notes (it reads CHANGELOG.md).
function buildChangelogPreview(nextVersion, tag) {
  const notes = fetchGeneratedNotes({
    repo: REPO_SLUG,
    tagName: `v${nextVersion}`,
    targetCommitish: 'main',
    previousTagName: tag ? tag.tag : undefined,
  });
  const bullets = parseWhatsChangedBullets(notes.body);
  return buildChangelogSection(nextVersion, dateStamp(), bullets);
}

function runCiLocal() {
  const result = spawnSync('pnpm ci:local', { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (result.status !== 0) fail('pnpm ci:local failed');
}

// `cargo update -p refract-tauri --offline` should touch only that package's version line (`-w` and
// `generate-lockfile` bump unrelated deps); `assertCargoLockOnlyVersionChanged` re-checks every run so
// no other Cargo.lock change rides into the release commit.
function writeManifestsAndLock(paths, raw, nextVersion) {
  const updated = writeManifestVersions(raw, nextVersion);
  writeFileSync(paths.packageJson, updated.packageJson);
  writeFileSync(paths.tauriConf, updated.tauriConf);
  writeFileSync(paths.cargoToml, updated.cargoToml);

  const result = spawnSync(
    'cargo',
    ['update', '--offline', '--manifest-path', paths.cargoToml, '-p', CARGO_PACKAGE_NAME],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`cargo update -p ${CARGO_PACKAGE_NAME} --offline failed to sync Cargo.lock`);

  const cargoLockAfter = readFileSync(paths.cargoLock, 'utf8');
  assertCargoLockOnlyVersionChanged(raw.cargoLock, cargoLockAfter, MANIFEST_LABELS.cargoLock);
}

function restoreOriginals(originals) {
  for (const [filePath, content] of originals) {
    if (content === null) {
      if (existsSync(filePath)) rmSync(filePath);
    } else {
      writeFileSync(filePath, content);
    }
  }
}

function determineNextVersion({ manifestVersion, tag, commits, level: LEVEL }) {
  if (LEVEL) {
    if (tag && tag.version !== manifestVersion) {
      fail(
        `manifest version v${manifestVersion} doesn't match last tag v${tag.version}; ` +
          'fix the manifests before bumping',
      );
    }
    return bumpVersion(manifestVersion, LEVEL);
  }
  if (!tag) {
    return manifestVersion; // first release: ship the current manifest version as-is.
  }
  if (tag.version !== manifestVersion) {
    fail(`manifest version v${manifestVersion} doesn't match last tag v${tag.version}`);
  }
  const level = inferLevel(commits);
  if (!level) {
    const subjects = commits.map((c) => `  - ${c.subject}`).join('\n');
    fail(`nothing to release since v${tag.version}; pass patch|minor|major. Commits since v${tag.version}:\n${subjects}`);
  }
  return bumpVersion(manifestVersion, level);
}

// Both `pnpm release` and `pnpm release --finish` print the same plan under `--dry-run`, so the
// two phases can be reviewed before either writes anything.
function printPlan(title, lines) {
  console.log(`\n${title}`);
  lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
}

function worktreeDirFor(version) {
  return path.resolve(repoRoot, '..', `refract-release-v${version}`);
}

function runCommand(argvList) {
  const [cmd, ...rest] = argvList;
  const result = spawnSync(cmd, rest, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) fail(`${argvList.join(' ')} failed`);
}

function remoteRefExists(ref) {
  return git(['ls-remote', 'origin', ref]) !== '';
}

function localRefExists(ref) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repoRoot }).status === 0;
}

// A leftover branch or tag would make the PR route fail halfway, so refuse before any file is written.
function assertReleaseNotCutYet(version, startBranch) {
  const branch = releaseBranchName(version);
  const tagName = `v${version}`;
  if (localRefExists(`refs/tags/${tagName}`) || remoteRefExists(`refs/tags/${tagName}`)) {
    fail(`tag ${tagName} already exists; this release was already cut (git tag -d ${tagName} if it is only a stale local tag)`);
  }
  if (startBranch === 'main' && localRefExists(`refs/heads/${branch}`)) {
    fail(`branch ${branch} already exists locally; switch to it and re-run pnpm release, or delete it (git branch -D ${branch})`);
  }
  if (remoteRefExists(`refs/heads/${branch}`)) {
    fail(`branch ${branch} already exists on origin; if its PR is merged run pnpm release --finish ${tagName}, else delete it first`);
  }
}

function openedPr(version) {
  try {
    const raw = execFileSync('gh', ['pr', 'view', releaseBranchName(version), '--json', 'number,url'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Never pushes `main`: only the release branch goes to origin, and the squash merge happens in GitHub.
async function openReleasePr(version) {
  const commands = prStepCommands(version);
  for (const stepId of PR_STEPS) {
    try {
      await checkInterrupted();
      runCommand(commands[stepId]);
    } catch (err) {
      await new Promise((resolve) => setImmediate(resolve));
      const wasInterrupted = err instanceof InterruptedError || interrupted;
      console.error(prStepFailureMessage(stepId, version, { interrupted: wasInterrupted, detail: err.message }));
      process.exit(wasInterrupted ? 130 : 1);
    }
  }
  console.log(openedPrMessage(version, openedPr(version)));
}

async function cutRelease({ dryRun, level }) {
  const startBranch = checkPreconditions();
  const startInfo = classifyBranch(startBranch);

  const { paths, raw, versions } = readAllVersions(repoRoot);
  const { ok, entries } = checkVersionsEqual(versions);
  if (!ok) {
    fail(`manifests already disagree on version before any release work: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const manifestVersion = versions.packageJson;

  const tag = lastTag();
  const commits = tag ? commitsSince(tag.tag) : [];

  const nextVersion = determineNextVersion({ manifestVersion, tag, commits, level });
  assertBranchMatchesVersion(startInfo, startBranch, nextVersion);
  assertReleaseNotCutYet(nextVersion, startBranch);
  const releaseBranch = releaseBranchName(nextVersion);
  const section = buildChangelogPreview(nextVersion, tag);

  if (dryRun) {
    console.log(`release --dry-run: next version v${nextVersion}\n`);
    console.log(section);
    printPlan('release --dry-run: phase 1, pnpm release, would:', phaseOnePlan(nextVersion, startBranch));
    printPlan(
      `release --dry-run: phase 2, pnpm release --finish v${nextVersion}, would:`,
      phaseTwoPlan(nextVersion, null, worktreeDirFor(nextVersion)),
    );
    runCiLocal();
    console.log(
      `\nrelease --dry-run: v${nextVersion} -- ci:local passed on the current tree. Only "git fetch origin" ` +
        '(step a) and ci:local\'s own installs/builds touched anything; none of the tracked release files, ' +
        'the git index, any branch, or any ref were written, committed, tagged, pushed, or published.',
    );
    return;
  }

  const changelogExistedBefore = existsSync(CHANGELOG_PATH);
  const changelogOriginal = changelogExistedBefore ? readFileSync(CHANGELOG_PATH, 'utf8') : null;
  const originals = [
    [paths.packageJson, raw.packageJson],
    [paths.tauriConf, raw.tauriConf],
    [paths.cargoToml, raw.cargoToml],
    [paths.cargoLock, raw.cargoLock],
    [CHANGELOG_PATH, changelogOriginal],
  ];

  installInterruptHandlers();
  let createdBranch = false;

  try {
    if (startInfo.kind === 'main') {
      gitInherit(['switch', '-c', releaseBranch]);
      createdBranch = true;
    }

    // The first release (no tag, no level) ships the current version, so there is nothing for the
    // manifests or `cargo update` to change; running them left Cargo.lock unchanged, which
    // `assertCargoLockOnlyVersionChanged` rejected. Only touch them when a real bump happens.
    if (nextVersion !== manifestVersion) {
      writeManifestsAndLock(paths, raw, nextVersion);

      const { versions: after } = readAllVersions(repoRoot);
      const afterCheck = checkVersionsEqual(after);
      if (!afterCheck.ok) {
        fail(`version update left manifests disagreeing: ${afterCheck.entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    }

    writeFileSync(CHANGELOG_PATH, prependChangelogSection(changelogOriginal, section));

    runCiLocal();

    // `git add`/`git commit` stay in this restore `try`: a hook or missing identity still fails BEFORE
    // the commit exists, so it must unstage and restore rather than leave files edited and staged.
    await checkInterrupted();
    gitInherit(['add', ...TRACKED_RELEASE_FILES]);
    await checkInterrupted();
    gitInherit(['commit', '-m', releaseCommitSubject(nextVersion)]);
  } catch (err) {
    // One more tick before reading `interrupted`: a signal that killed `cargo`/`git` directly surfaces
    // as a generic failure unless the queued handler gets to set the flag first.
    await new Promise((resolve) => setImmediate(resolve));
    unstageTrackedFiles();
    restoreOriginals(originals);
    // Nothing is committed here, so the branch we cut is still at origin/main and `-d` is safe.
    const branchBack =
      createdBranch &&
      spawnSync('git', ['switch', startBranch], { cwd: repoRoot, stdio: 'inherit' }).status === 0 &&
      spawnSync('git', ['branch', '-d', releaseBranch], { cwd: repoRoot, stdio: 'inherit' }).status === 0;
    console.error(
      'release: failed before committing -- unstaged and restored package.json, ' +
        'src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock' +
        (changelogExistedBefore ? ', and CHANGELOG.md,' : ', and removed the CHANGELOG.md this run created,') +
        ' to their original state. Nothing was committed' +
        (branchBack ? `, and ${releaseBranch} was removed (back on ${startBranch}).` : '.') +
        (createdBranch && !branchBack ? ` Check your branch: ${releaseBranch} may still exist (git branch -d ${releaseBranch}).` : ''),
    );
    if (err instanceof InterruptedError || interrupted) {
      console.error('release: stopped by SIGINT/SIGTERM, exiting 130.');
      process.exit(130);
    }
    fail(err.message);
  }

  // The commit exists, so restoring file bytes would contradict history: never restore or reset
  // automatically, only print the resume command for the step that failed.
  console.log(`release: committed "${releaseCommitSubject(nextVersion)}" on ${releaseBranch}.`);
  await openReleasePr(nextVersion);
}

function readJsonAt(sha, file) {
  return JSON.parse(git(['show', `${sha}:${file}`]));
}

function localTagSha(tagName) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Finds the squash commit of the merged release PR on origin/main and proves it is this release.
function verifyMergedRelease(version) {
  const fetchResult = spawnSync('git', ['fetch', 'origin'], { cwd: repoRoot, stdio: 'inherit' });
  if (fetchResult.status !== 0) fail('git fetch origin failed');

  const listed = execFileSync(
    'gh',
    ['pr', 'list', '--repo', REPO_SLUG, '--head', releaseBranchName(version), '--state', 'all', '--limit', '20',
      '--json', 'number,state,url,baseRefName,mergeCommit'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const pr = pickMergedReleasePr(JSON.parse(listed), version);

  const onMain = spawnSync('git', ['merge-base', '--is-ancestor', pr.sha, 'origin/main'], { cwd: repoRoot });
  if (onMain.status !== 0) fail(`merge commit ${pr.sha} of ${pr.url} is not on origin/main`);

  assertCommitVersions(version, {
    'package.json': readJsonAt(pr.sha, 'package.json').version,
    'src-tauri/tauri.conf.json': readJsonAt(pr.sha, 'src-tauri/tauri.conf.json').version,
  });
  return pr;
}

// Runs one `--finish` step; `process.exit` keeps the failure text the only thing the user sees.
async function finishStep(stepId, version, action) {
  try {
    await checkInterrupted();
    return action();
  } catch (err) {
    await new Promise((resolve) => setImmediate(resolve));
    const wasInterrupted = err instanceof InterruptedError || interrupted;
    console.error(finishFailureMessage(stepId, version, { interrupted: wasInterrupted, detail: err.message }));
    process.exit(wasInterrupted ? 130 : 1);
  }
}

async function finishRelease({ dryRun, finishVersion: version }) {
  const tagName = `v${version}`;
  const dir = worktreeDirFor(version);
  installInterruptHandlers();

  const pr = await finishStep('verify-pr', version, () => verifyMergedRelease(version));
  const decision = await finishStep('verify-pr', version, () =>
    decideTag({
      tagName,
      sha: pr.sha,
      localSha: localTagSha(tagName),
      remoteSha: parseRemoteTagSha(git(['ls-remote', 'origin', `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]), tagName),
    }),
  );
  console.log(`release: ${pr.url} is merged as ${pr.sha}, and that commit carries v${version}.`);

  if (dryRun) {
    printPlan(`release --finish --dry-run: ${tagName} would:`, phaseTwoPlan(version, pr.sha, dir));
    console.log(
      `\nrelease --finish --dry-run: nothing was tagged or pushed (local tag ${decision.createLocal ? 'absent' : 'already present'}, ` +
        `origin tag ${decision.push ? 'absent' : 'already present'}). Only "git fetch origin" touched anything.`,
    );
    return;
  }

  if (decision.createLocal) {
    await finishStep('tag', version, () => runCommand(['git', 'tag', '-a', tagName, '-m', tagName, pr.sha]));
  }
  if (decision.push) {
    await finishStep('push-tag', version, () => runCommand(['git', 'push', 'origin', `refs/tags/${tagName}`]));
  }

  console.log(`release: ${tagName} is tagged on ${pr.sha} and pushed. The publish stays a separate step; run it from a detached worktree at the tag:`);
  for (const line of publishCommands(version, dir)) console.log(`  ${line}`);
  console.log(`  (afterwards: cd back, then git worktree remove ${dir.replace(/\\/g, '/')})`);
}

async function main() {
  const args = parseArgs(argv);
  if (args.finishVersion) return finishRelease(args);
  return cutRelease(args);
}

main().catch((err) => {
  console.error(`release: ${err.message}`);
  process.exit(1);
});
