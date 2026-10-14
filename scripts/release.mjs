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
  bumpVersion,
  checkVersionsEqual,
  readAllVersions,
  writeManifestVersions,
} from './release-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const REPO_SLUG = 'stuarthopwood/refract';
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');

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

// `{ subject, body }` for every commit in `tag..HEAD`, oldest first.
function commitsSince(tag) {
  const SEP = '\x1f';
  const REC = '\x1e';
  const raw = execFileSync('git', ['log', `${tag}..HEAD`, `--format=%s${SEP}%b${REC}`], {
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

// `type!:` or a `BREAKING CHANGE` footer => major; `feat` => minor; `fix`/`perf` => patch; every
// other conventional type and every non-conventional (legacy) subject doesn't bump. Returns the
// highest level any commit in the range triggers, or null if none did.
function inferLevel(commits) {
  let level = null;
  for (const c of commits) {
    const parsed = parseConventionalSubject(c.subject);
    const breakingFooter = /(^|\n)BREAKING CHANGE:/.test(c.body);
    let thisLevel = null;
    if (parsed?.breaking || breakingFooter) thisLevel = 'major';
    else if (parsed?.type === 'feat') thisLevel = 'minor';
    else if (parsed?.type === 'fix' || parsed?.type === 'perf') thisLevel = 'patch';
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
  const result = spawnSync('pnpm', ['ci:local'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (result.status !== 0) fail('pnpm ci:local failed');
}

// Writes the three text-editable manifests, then lets cargo itself sync Cargo.lock's own-crate
// version entry -- `cargo update -p refract-tauri --offline` touches ONLY that one package's
// version line (verified: unlike `cargo update -w`/`cargo generate-lockfile`, it never
// re-resolves or bumps any other dependency in the graph).
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

function main() {
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
    console.log(`\nrelease --dry-run: v${nextVersion} -- ci:local passed on the current tree; nothing written, committed, or published.`);
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

  try {
    writeManifestsAndLock(paths, raw, nextVersion);

    const { versions: after } = readAllVersions(repoRoot);
    const afterCheck = checkVersionsEqual(after);
    if (!afterCheck.ok) {
      fail(`version update left manifests disagreeing: ${afterCheck.entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    writeFileSync(CHANGELOG_PATH, prependChangelogSection(changelogOriginal, section));

    runCiLocal();
  } catch (err) {
    restoreOriginals(originals);
    console.error(
      'release: failed before committing -- restored package.json, src-tauri/tauri.conf.json, ' +
        'src-tauri/Cargo.toml and src-tauri/Cargo.lock' +
        (changelogExistedBefore ? ', and CHANGELOG.md,' : ', and removed the CHANGELOG.md this run created,') +
        ' to their original state.',
    );
    fail(err.message);
  }

  gitInherit(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'CHANGELOG.md']);
  gitInherit(['commit', '-m', `chore: release v${nextVersion}`]);
  gitInherit(['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
  gitInherit(['push', 'origin', 'main']);
  gitInherit(['push', 'origin', `v${nextVersion}`]);

  console.log(`release: committed, tagged, and pushed v${nextVersion}.`);

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

try {
  main();
} catch (err) {
  console.error(`release: ${err.message}`);
  process.exit(1);
}
