#!/usr/bin/env node
// `pnpm release [patch|minor|major] [--dry-run]`: the one-command release. Any failure before the
// commit restores the four manifests (package.json, tauri.conf.json, Cargo.toml, Cargo.lock) byte-for-byte, never via `git`.
// With no level, the bump is inferred from conventional-commit subjects since the last tag.
// `--dry-run` runs the preconditions, version choice, a printed changelog preview and `ci:local`, writing nothing.
//
// Usage: node scripts/release.mjs [patch|minor|major] [--dry-run]  (or `pnpm release ...`)

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

const LEVELS = ['patch', 'minor', 'major'];
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LEVEL = argv.find((a) => LEVELS.includes(a)) ?? null;
const unknownArgs = argv.filter((a) => a !== '--dry-run' && a !== LEVEL);

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

function checkPreconditions() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`must be run on branch main (current: ${branch})`);

  const status = git(['status', '--porcelain']);
  if (status) fail(`working tree is not clean -- commit, stash, or remove these first:\n${status}`);

  const fetchResult = spawnSync('git', ['fetch', 'origin'], { cwd: repoRoot, stdio: 'inherit' });
  if (fetchResult.status !== 0) fail('git fetch origin failed');

  const head = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', 'origin/main']);
  if (head !== originMain) {
    fail(`HEAD (${head}) does not equal origin/main (${originMain}); pull or rebase first`);
  }
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
// non-default branch ("Invalid target_commitish parameter"); `checkPreconditions` ensures HEAD == origin/main.
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

function determineNextVersion({ manifestVersion, tag, commits }) {
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

async function main() {
  if (unknownArgs.length > 0) fail(`unknown argument(s): ${unknownArgs.join(', ')}`);

  checkPreconditions();

  const { paths, raw, versions } = readAllVersions(repoRoot);
  const { ok, entries } = checkVersionsEqual(versions);
  if (!ok) {
    fail(`manifests already disagree on version before any release work: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const manifestVersion = versions.packageJson;

  const tag = lastTag();
  const commits = tag ? commitsSince(tag.tag) : [];

  const nextVersion = determineNextVersion({ manifestVersion, tag, commits });
  const section = buildChangelogPreview(nextVersion, tag);

  if (DRY_RUN) {
    console.log(`release --dry-run: next version v${nextVersion}\n`);
    console.log(section);
    runCiLocal();
    console.log(
      `\nrelease --dry-run: v${nextVersion} -- ci:local passed on the current tree. Only "git fetch origin" ` +
        '(step a) and ci:local\'s own installs/builds touched anything; none of the tracked release files, ' +
        'the git index, or any ref were written, committed, tagged, pushed, or published.',
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

  try {
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
    gitInherit(['commit', '-m', `chore: release v${nextVersion}`]);
  } catch (err) {
    // One more tick before reading `interrupted`: a signal that killed `cargo`/`git` directly surfaces
    // as a generic failure unless the queued handler gets to set the flag first.
    await new Promise((resolve) => setImmediate(resolve));
    unstageTrackedFiles();
    restoreOriginals(originals);
    console.error(
      'release: failed before committing -- unstaged and restored package.json, ' +
        'src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock' +
        (changelogExistedBefore ? ', and CHANGELOG.md,' : ', and removed the CHANGELOG.md this run created,') +
        ' to their original state. Nothing was committed.',
    );
    if (err instanceof InterruptedError || interrupted) {
      console.error('release: stopped by SIGINT/SIGTERM, exiting 130.');
      process.exit(130);
    }
    fail(err.message);
  }

  // The commit exists, so restoring file bytes would contradict history: never restore or reset
  // automatically, only print the commands to run. Tag and push are separate `try` blocks so the
  // recovery text matches which one failed (don't tell the user to push/delete a tag never created).
  try {
    await checkInterrupted();
    gitInherit(['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
  } catch (err) {
    if (err instanceof InterruptedError) {
      console.error(
        `release: stopped by SIGINT/SIGTERM before tagging v${nextVersion} -- "chore: release v${nextVersion}" ` +
          'is committed locally but not tagged or pushed. A plain re-run of pnpm release will NOT work here ' +
          '(HEAD no longer equals origin/main, and the manifests are already at the new version) -- resume ' +
          `yourself: git tag -a v${nextVersion} -m v${nextVersion} && git push --atomic origin main v${nextVersion} ` +
          '&& pnpm release:local -- --notes-from-changelog. To abandon this release commit entirely instead: ' +
          'git reset --keep HEAD~1',
      );
      process.exit(130);
    }
    // One more tick: a signal can kill `git tag -a` after `checkInterrupted()` passed; a killed run leaves no tag.
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted) {
      console.error(
        `release: stopped by SIGINT/SIGTERM while tagging v${nextVersion} -- "chore: release v${nextVersion}" ` +
          'is committed locally but not tagged or pushed. A plain re-run of pnpm release will NOT work here ' +
          '(HEAD no longer equals origin/main, and the manifests are already at the new version) -- resume ' +
          `yourself: git tag -a v${nextVersion} -m v${nextVersion} && git push --atomic origin main v${nextVersion} ` +
          '&& pnpm release:local -- --notes-from-changelog. To abandon this release commit entirely instead: ' +
          'git reset --keep HEAD~1',
      );
      process.exit(130);
    }
    console.error(
      `release: "chore: release v${nextVersion}" was committed locally, but creating the tag v${nextVersion} failed: ${err.message}`,
    );
    console.error(
      'release: this script will NOT retry or reset automatically. A plain re-run of pnpm release will NOT ' +
        'work here (HEAD no longer equals origin/main, and the manifests are already at the new version). If ' +
        `a stale local tag is the cause (check: git tag -l v${nextVersion}), remove it first: ` +
        `git tag -d v${nextVersion}. Then resume: git tag -a v${nextVersion} -m v${nextVersion} && ` +
        `git push --atomic origin main v${nextVersion} && pnpm release:local -- --notes-from-changelog. ` +
        'To abandon this release commit entirely instead: git reset --keep HEAD~1',
    );
    process.exit(1);
  }

  try {
    await checkInterrupted();
    gitInherit(['push', '--atomic', 'origin', 'main', `v${nextVersion}`]);
  } catch (err) {
    if (err instanceof InterruptedError) {
      console.error(
        `release: stopped by SIGINT/SIGTERM before pushing -- "chore: release v${nextVersion}" is committed ` +
          'and tagged locally but not pushed. Since this was before the push started, nothing was sent: ' +
          `retry: git push --atomic origin main v${nextVersion}  (then)  pnpm release:local -- --notes-from-changelog. ` +
          `Abandon: git tag -d v${nextVersion}  (then)  git reset --keep HEAD~1`,
      );
      process.exit(130);
    }
    console.error(
      `release: "chore: release v${nextVersion}" was committed and tagged locally, but the atomic push failed: ${err.message}`,
    );
    console.error(
      'release: this script will NOT retry or reset automatically. If this was a Ctrl+C during the push ' +
        'itself, the atomic push may have already landed on the remote despite the error -- check first: ' +
        `git ls-remote origin refs/tags/v${nextVersion}. If it is NOT there, retry: ` +
        `git push --atomic origin main v${nextVersion}  (then)  pnpm release:local -- --notes-from-changelog. ` +
        `If it IS there, just run: pnpm release:local -- --notes-from-changelog. To abandon this release ` +
        `entirely instead (only if the tag is confirmed NOT on the remote): git tag -d v${nextVersion}  (then)  ` +
        'git reset --keep HEAD~1',
    );
    process.exit(1);
  }

  console.log(`release: committed, tagged, and pushed v${nextVersion}.`);

  try {
    await checkInterrupted();
  } catch {
    console.error(
      `release: v${nextVersion} was committed, tagged, and pushed, but stopped by SIGINT/SIGTERM before publishing. ` +
        'Resume with: pnpm release:local -- --notes-from-changelog',
    );
    process.exit(130);
  }

  const publish = spawnSync('node', ['scripts/release-local.mjs', '--notes-from-changelog'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (publish.status !== 0) {
    console.error(
      'release: v' + nextVersion + ' was committed, tagged, and pushed, but the publish step failed. ' +
        'Resume with: pnpm release:local -- --notes-from-changelog',
    );
    process.exit(publish.status ?? 1);
  }

  console.log(`release: v${nextVersion} published.`);
}

main().catch((err) => {
  console.error(`release: ${err.message}`);
  process.exit(1);
});
