#!/usr/bin/env node
// `pnpm release [patch|minor|major] [--dry-run]`: the one-command release. Stops at the first
// failure with a clear message, and -- for any failure before the commit -- restores
// `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`
// to the exact bytes they had before this run touched them (never via `git`).
//
// Steps, in order:
//   a. Preconditions: on `main`, a fully clean tree (no tracked changes, no untracked files),
//      `git fetch origin`, and `HEAD` == `origin/main`.
//   b. Work out the next version. The last tag is the highest semver `v*` tag reachable from
//      HEAD. An explicit level bumps from the current manifest version (asserted to equal the
//      last tag's version, or there is no tag yet). With no level: no tag yet means ship the
//      current manifest version as-is; otherwise infer a level from every commit subject (and
//      `BREAKING CHANGE` footer) since the last tag -- `type!:`/footer => major, `feat` =>
//      minor, `fix`/`perf` => patch, anything else (including legacy, non-conventional subjects)
//      doesn't bump. Nothing bumps => stop, naming the last tag and listing every subject.
//   c. Update the version in all four manifests together (Cargo.lock via `cargo update -p
//      refract-tauri --offline`, never a text replace), then re-read and assert all four agree.
//   d. Prepend a `## vX.Y.Z (YYYY-MM-DD)` section to CHANGELOG.md, built from GitHub's own
//      generated release notes for this version, grouped by each entry's conventional type.
//   e. Run `pnpm ci:local` on the edited tree.
//   f. Commit exactly the four version files plus CHANGELOG.md as `chore: release vX.Y.Z`, tag
//      `vX.Y.Z` (annotated), push `main` then the tag.
//   g. Run `node scripts/release-local.mjs --notes-from-changelog` to build, sign, verify and
//      publish. If this fails, the commit/tag/push already happened -- print the exact resume
//      command instead of trying to undo any of it.
//
// `--dry-run`: runs step a, step b, a PRINTED (never written) changelog preview, and step e on
// the CURRENT, unmodified tree. Writes nothing, commits nothing, tags nothing, pushes nothing,
// publishes nothing.
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

// Exactly the files `release.mjs` ever stages or commits -- also what gets unstaged on a
// failed `git add`/`git commit` (see the restore `try` in `main`).
const TRACKED_RELEASE_FILES = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
];

// Set by the SIGINT/SIGTERM handler installed right before the first write. Registering a
// handler at all overrides Node's own default disposition (immediate termination) -- without
// one, Ctrl+C during a long child process (`cargo update`, `pnpm ci:local`) would kill this
// script outright, as everyone pressing Ctrl+C in a console sends the break to the whole
// process group (parent AND child), leaving the manifests and CHANGELOG.md mid-edit with no
// restore ever running. With a handler installed, the child still dies from the same signal,
// `spawnSync` returns a non-zero/killed status, and the existing catch block below restores the
// files exactly as it would for any other failure. Because `main()` is otherwise fully
// synchronous, this flag alone is not enough to reliably flip the exit code/message to the
// interrupt-specific one at the exact moment a catch block runs (see `checkInterrupted` below) --
// every catch site that needs to tell "the user asked to stop" apart from an ordinary failure
// also awaits one more event-loop tick itself before reading this flag.
let interrupted = false;

function installInterruptHandlers() {
  const onSignal = (signal) => {
    interrupted = true;
    console.error(`\nrelease: received ${signal}, stopping...`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Thrown by `checkInterrupted` so every catch site can tell "the user asked to stop" apart from
// an ordinary failure, without re-reading the `interrupted` flag a second time.
class InterruptedError extends Error {}

// `main()` is otherwise fully synchronous, so the signal handler registered above can only ever
// run on an actual event-loop tick -- a synchronous catch block running immediately after a
// failed `spawnSync` can read `interrupted` as still `false` even when a real SIGINT already
// arrived (confirmed empirically: a genuine `GenerateConsoleCtrlEvent` mid `cargo test` still
// reported the generic ci:local failure, not the interrupt one, because nothing yielded between
// the failure and the check). Awaiting a `setImmediate` here gives the queued handler callback
// one real tick to run before this checks the flag -- called immediately before every
// irreversible step (`git add`, `commit`, `tag`, `push`, the `release-local.mjs` publish step).
async function checkInterrupted() {
  await new Promise((resolve) => setImmediate(resolve));
  if (interrupted) {
    throw new InterruptedError('interrupted');
  }
}

// Unstages the five tracked release files -- best-effort and never throws, since this only ever
// runs from inside an already-failing path (a reset failure here must never mask or replace the
// real error being reported). A no-op if `git add` never ran yet.
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

// `{ subject, body }` for every commit in `tag..HEAD`, oldest first. `--first-parent` follows
// only `main`'s own mainline: this repo squash-merges every PR into one commit on `main`, so a
// feature branch's own in-progress commits (`feat: wip`, etc.) must never be walked individually
// and a PR merged with a merge commit must still contribute exactly the one mainline commit's
// subject/body, matching what the CHANGELOG (built from PR titles, not raw commits) also sees.
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

// `type!:` or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer => major; `feat` => minor;
// `fix`/`perf` => patch; every other conventional type and every non-conventional (legacy)
// subject doesn't bump. The type is matched case-insensitively (`Feat:`, `FEAT:`, `feat:` all
// count) -- Conventional Commits itself is case-insensitive on the type, only the literal
// `BREAKING CHANGE`/`BREAKING-CHANGE` footer keyword stays uppercase per spec. Returns the
// highest level any commit in the range triggers, or null if none did.
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

// `targetCommitish` is the literal branch name `main`, never a raw commit SHA: GitHub's
// generate-notes endpoint was observed (release pipeline build, 2026-10-14) to reject a SHA
// that was only just pushed on a non-default branch with "Invalid target_commitish parameter"
// even though the same SHA resolves fine via plain git, while the branch name always worked --
// `checkPreconditions` already guarantees HEAD equals `origin/main`, so `main` names the exact
// same commit.
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

// Writes the three text-editable manifests, then lets cargo itself sync Cargo.lock's own-crate
// version entry -- `cargo update -p refract-tauri --offline` is EXPECTED to touch only that one
// package's version line (verified by hand against `cargo update -w`/`cargo generate-lockfile`,
// both of which also bumped unrelated transitive dependencies), but `assertCargoLockOnlyVersionChanged`
// re-checks that expectation on every real run, not just by memory of a one-off manual test --
// any other Cargo.lock change, however small, fails the release rather than riding along into
// the release commit silently.
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
    // HIGH gate fix: the very first release (no tag yet, no explicit level) ships the CURRENT
    // manifest version as-is -- `nextVersion === manifestVersion`, so there is nothing for the
    // four manifests or `cargo update` to change. Running them anyway left `Cargo.lock`
    // completely unchanged, which `assertCargoLockOnlyVersionChanged` then correctly treated as
    // a failure ("expected the version line to change"), aborting every first release. Only
    // touch the manifests/lock -- and only re-check they still agree -- when a real bump is
    // happening; CHANGELOG.md, ci:local, and the commit/tag/push below all still run either way.
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

    // `git add`/`git commit` stay inside this same restore `try`: a hook, missing identity, or a
    // lock file failing either of them is still a failure BEFORE the commit exists, so it must
    // unstage and restore exactly like every earlier failure in this block, never leave the five
    // files edited-and-staged with nothing to show for it.
    await checkInterrupted();
    gitInherit(['add', ...TRACKED_RELEASE_FILES]);
    await checkInterrupted();
    gitInherit(['commit', '-m', `chore: release v${nextVersion}`]);
  } catch (err) {
    // One more event-loop tick before reading `interrupted`: a signal that killed `cargo`/`git`
    // directly (rather than being caught by `checkInterrupted()` before that step even started)
    // surfaces here as a generic ci:local/git failure, not `InterruptedError` -- this gives the
    // queued SIGINT/SIGTERM handler a chance to run and set the flag before the check below.
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

  // The commit above now exists: restoring file bytes from here on would contradict real
  // history, so a tag or push failure is handled differently -- never restore, never `git
  // reset`/`git tag -d` automatically, only print the exact commands for Stuart to run himself.
  // Tag creation and the push are two SEPARATE try blocks (not one): the recovery text must
  // match which one actually failed -- if the tag itself was never created (for example a
  // leftover local tag from an earlier aborted attempt), telling Stuart to push or delete a tag
  // that doesn't exist would be actively wrong.
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
    // One more tick: `git tag -a` itself could have been killed mid-run by a signal that never
    // reached `checkInterrupted()` above (which only guards the moment BEFORE the command
    // starts) -- same resume path applies either way, since a killed `git tag -a` leaves no tag.
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
