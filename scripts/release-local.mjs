#!/usr/bin/env node
// Local release script (lane R11d, follow-up to #794): Stuart decided (2026-10-14) to sign
// Refract's own installer locally with a self-signed code-signing certificate rather than buy a
// CA-issued one; the certificate's private key lives only in his own `Cert:\CurrentUser\My`
// store (RSA 3072, not exportable), so signing can only ever happen on his own workstation --
// never in CI (`.github/workflows/release.yml` builds and verifies the bundle on every tag push,
// but never signs or publishes).
//
// What this script does, in order:
// 1. Fails unless the working tree is clean (`git status --porcelain`) -- gate finding, PR #837
//    round 1, Medium: a release must build exactly what is committed, nothing uncommitted or
//    untracked riding along.
// 2. Fails unless the pinned certificate thumbprint is present in `Cert:\CurrentUser\My`.
// 3. Fails unless the current commit's exact git tag equals `v<version>` from
//    `src-tauri/tauri.conf.json` (the same check `release.yml` makes against a pushed tag ref;
//    here against the locally-checked-out HEAD instead).
// 4. Builds into a FRESH, release-only `CARGO_TARGET_DIR` under `%TEMP%` (gate finding, round 1,
//    Medium/High: the shared dev `CARGO_TARGET_DIR` persists old bundles across lanes/worktrees
//    and a concurrent build could overwrite the exe mid-release) -- `pnpm tauri build`, with a
//    `--config` overlay (merged for this invocation only, never written to the committed
//    `tauri.conf.json`) that sets `bundle.windows.signCommand` to our own `signtool.exe`
//    invocation. Tauri's own bundler then signs the main binary BEFORE NSIS packs it, and signs
//    the generated installer again afterwards, in the one build (gate finding, round 1, High:
//    the previous version signed both files AFTER they were already built/packed, so the copy
//    NSIS had already embedded in the installer was never actually signed).
// 5. Requires the build to have produced exactly `<productName>_<version>_x64-setup.exe` -- any
//    other name (a stale bundle, an unexpected version string) is a hard failure, never silently
//    picked.
// 6. Verifies the installer with `Get-AuthenticodeSignature`, requiring `Status -eq 'Valid'`,
//    the signer certificate's own SHA-256 to equal the pin (computed from the committed
//    `certs/refract-codesign.cer`, not a second hardcoded copy), and a trusted timestamp to be
//    present. The loose build-tree `refract-tauri.exe` is NOT separately re-signed or verified
//    (gate finding, round 2, Medium): Tauri's own bundler restores it to unsigned once bundling
//    finishes (by design), and that copy never ships anywhere -- only the copy NSIS already
//    packed into the installer (signed, per step 4 above) matters.
// 7. Verifies that SAME embedded copy, not just the installer's own outer signature: if 7-Zip is
//    present at its fixed default install path, extracts `refract-tauri.exe` from the signed
//    installer and runs the same `Get-AuthenticodeSignature` check against it; otherwise this
//    step is skipped (logged, not a failure) and only the installer's own outer signature
//    (step 6) stands as evidence.
// 8. Writes a `<asset>.sha256` checksum sidecar for the installer.
// 9. Unless `--dry-run`, first confirms `origin`'s own `refs/tags/v<version>` points at this
//    exact `HEAD` commit (`git ls-remote`), then publishes the installer (and its checksum) to a
//    new GitHub release via `gh release create v<version> --verify-tag`.
// 10. Deletes the fresh per-release temp directory (which holds the build, the installer, and
//     any embedded-copy extraction from step 7) by its own literal, hard-guarded path
//     (`safeRemoveReleaseDir`) -- always, whether this run published, failed, or was
//     `--dry-run`. There is no `--keep` flag: inspect the installer's own
//     `Get-AuthenticodeSignature` output this script already prints, or re-run without
//     `--dry-run` once ready to publish.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractChangelogSection } from './release-changelog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAURI_CONF_PATH = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const CERT_PATH = path.join(REPO_ROOT, 'src-tauri', 'certs', 'refract-codesign.cer');

// `certs/refract-codesign.cer`'s SHA-1 thumbprint, used to select the signing certificate in
// `Cert:\CurrentUser\My` and with `signtool /sha1`. The expected SHA-256 PIN the updater checks
// against (`src-tauri/src/updates/signature.rs`'s `SIGNING_CERT_SHA256_PINS`) is computed from
// `CERT_PATH` directly below, rather than hardcoded a second time here.
const CERT_THUMBPRINT = '31B95999D331BD33210126432FAB3FF18ECA5DBD';
const TIMESTAMP_URL = 'http://timestamp.digicert.com';
const DRY_RUN = process.argv.includes('--dry-run');
// `pnpm release`'s own final step (lane: release pipeline): sources the GitHub release's notes
// from the `## vX.Y.Z` section `release.mjs` just committed to CHANGELOG.md, instead of `gh
// release create`'s own `--generate-notes` (which would re-summarise commits/PRs a second,
// differently-formatted way).
const NOTES_FROM_CHANGELOG = process.argv.includes('--notes-from-changelog');

// Absolute, never `PATH`-resolved (gate finding, PR #837 round 1, Low): Node's `spawnSync` also
// searches the current working directory first on Windows, so even a bare command name is not
// fully PATH-only -- these are the fixed, always-present per-machine locations for each tool.
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CERTUTIL_EXE = path.join(SYSTEM_ROOT, 'System32', 'certutil.exe');
const CMD_EXE = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
// Fixed default install path for 7-Zip (gate finding, PR #837 round 2, Medium): used ONLY for
// the best-effort embedded-copy check -- if it isn't present here, that one check is skipped
// (logged, not a failure), never resolved via `PATH`.
const SEVEN_ZIP_EXE = 'C:\\Program Files\\7-Zip\\7z.exe';

// Restricted `PSModulePath` (observed on Stuart's own workstation, 2026-10-14): when a user
// profile's `PSModulePath` also lists a PowerShell 7 install's `Modules` directory alongside
// Windows PowerShell 5.1's own, `powershell.exe` (5.1) fails to autoload
// `Microsoft.PowerShell.Security` (duplicate `ObjectSecurity` extended type-data between the two
// copies) -- `Get-AuthenticodeSignature` then errors "command was found... but the module could
// not be loaded" instead of ever reporting a signature status. Restricting `PSModulePath` to only
// the two built-in Windows PowerShell module directories for every `powershell.exe` invocation
// below sidesteps the collision without touching the caller's own environment or profile.
const RESTRICTED_PSMODULEPATH = [
  path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'),
  path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
].join(';');

// Throws rather than calling `process.exit` directly (gate finding, PR #837 round 2, Low): a
// `finally` block does not run after `process.exit`, so a bare exit here would skip `main`'s own
// release-dir cleanup on every failure path. `main()`'s own caller at the bottom of this file
// catches the throw, prints it with the same `release-local: ` prefix, and exits 1 -- by then
// every `finally` between here and there has already run.
function fail(message) {
  throw new Error(message);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function runPowershell(script) {
  const env = { ...process.env, PSModulePath: RESTRICTED_PSMODULEPATH };
  return run(POWERSHELL_EXE, ['-NoProfile', '-Command', script], { env });
}

function checkCleanWorktree() {
  const result = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
  if (result.status !== 0) {
    fail(`"git status --porcelain" failed (exit ${result.status}):\n${result.stderr}`);
  }
  if (result.stdout.trim() !== '') {
    fail(
      'the working tree has uncommitted or untracked changes -- a release must build exactly ' +
        `what is committed:\n${result.stdout}`,
    );
  }
}

function readTauriConf() {
  const conf = JSON.parse(readFileSync(TAURI_CONF_PATH, 'utf8'));
  if (!conf.version) fail(`${TAURI_CONF_PATH} has no "version" field.`);
  if (!conf.productName) fail(`${TAURI_CONF_PATH} has no "productName" field.`);
  return conf;
}

// Reads the certificate directly from the Windows certificate store via `certutil` (no
// PowerShell `Cert:` drive dependency, which is not reliably auto-loaded in every non-interactive
// shell) -- `-store My <thumbprint>` both looks the certificate up AND filters to it, so success
// here means Stuart's signing certificate is actually present and usable.
function verifyCertInStore(thumbprint) {
  const result = run(CERTUTIL_EXE, ['-user', '-store', 'My', thumbprint]);
  if (result.status !== 0 || !/completed successfully/i.test(result.stdout ?? '')) {
    fail(
      `signing certificate ${thumbprint} was not found in Cert:\\CurrentUser\\My ` +
        `(ran "certutil -user -store My ${thumbprint}"). Create it before releasing.\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

// Mirrors `release.yml`'s own tag-vs-version guard, but against the locally checked-out HEAD
// rather than a pushed tag ref: a release built from a commit whose tag doesn't match
// `tauri.conf.json`'s version would make `install_on_quit.rs`'s own version-match check report
// every future install as failed, forever.
function verifyTagMatchesVersion(version) {
  const result = run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: REPO_ROOT });
  if (result.status !== 0) {
    fail(
      `HEAD has no exact git tag (ran "git describe --tags --exact-match HEAD"). ` +
        `Tag this commit v${version} (and push the commit and tag) before releasing.`,
    );
  }
  const tag = result.stdout.trim();
  const expected = `v${version}`;
  if (tag !== expected) {
    fail(
      `HEAD is tagged ${tag}, but src-tauri/tauri.conf.json's version is ${version} ` +
        `(expected tag ${expected}). Update tauri.conf.json's version or re-tag before releasing.`,
    );
  }
  return tag;
}

// Deliberately NOT `PATH`-resolved: a stale or unrelated `signtool.exe` earlier on `PATH` must
// never silently sign a release with the wrong tool. Windows SDK installs live under one of
// these two Program Files roots, one version-numbered directory per installed SDK; picks the
// candidate whose directory name PARSES to the highest version (gate finding, PR #837 round 1,
// Low: a lexical sort of full paths put `Program Files (x86)` ahead of `Program Files` by string
// comparison alone, which can pick a lower-versioned SDK over a higher one installed under the
// other root).
function locateSigntool() {
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const versionParts = entry.name.split('.').map((part) => Number.parseInt(part, 10));
      if (versionParts.some((part) => Number.isNaN(part))) continue;
      const candidate = path.join(root, entry.name, 'x64', 'signtool.exe');
      if (existsSync(candidate)) candidates.push({ path: candidate, versionParts });
    }
  }
  if (candidates.length === 0) {
    fail(
      'signtool.exe not found under a Windows 10 SDK bin directory (checked ' +
        `${roots.join(', ')}). Install the Windows SDK, or update this script's fixed roots.`,
    );
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.versionParts.length, b.versionParts.length); i += 1) {
      const diff = (a.versionParts[i] ?? 0) - (b.versionParts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return candidates[candidates.length - 1].path;
}

// A fresh, release-only `CARGO_TARGET_DIR` under `%TEMP%` (gate finding, PR #837 round 1,
// Medium/High): the shared dev target dir persists old bundles across every lane and worktree
// (`readdir` over it is not even deterministic across runs), and a concurrent build from another
// lane could overwrite the exe between this script's own build and sign steps. This directory
// belongs to this one release only and is deleted by its own literal path when this script exits
// (`main`'s own `cleanup`), whether or not it published.
function freshReleaseDir(version) {
  return path.join(tmpdir(), `refract-release-${version}`);
}

// Hard guards before ANY delete of this script's own release dir (Main addendum, PR #837 gate
// round 1): resolves to an absolute path, requires it to be a DIRECT child of `os.tmpdir()`
// whose basename is exactly `refract-release-<this run's own version>` (matching
// `/^refract-release-\d+\.\d+\.\d+$/`), refuses an empty path, a root, a bare drive, or any
// path that is the repo or a repo ancestor/descendant, and refuses if the target or any
// directory between it and `tmpdir()` is a symlink/junction (a redirected `%TEMP%` or release
// dir must never turn this into a delete of something else). Prints the exact path before
// deleting; `rmSync` itself does not follow a symlink AT the target path either way (it unlinks
// the link, never descends through it), but every guard above still runs first regardless.
function safeRemoveReleaseDir(targetDir, version) {
  const resolved = path.resolve(targetDir);
  const root = path.parse(resolved).root;
  if (!resolved || resolved === root || resolved === '') {
    fail(`refusing to delete: "${resolved}" is empty or a drive root.`);
  }

  const base = path.resolve(tmpdir());
  if (path.dirname(resolved) !== base) {
    fail(`refusing to delete: "${resolved}" is not a direct child of ${base}.`);
  }

  const expectedBasename = `refract-release-${version}`;
  if (!/^refract-release-\d+\.\d+\.\d+$/.test(expectedBasename) || path.basename(resolved) !== expectedBasename) {
    fail(`refusing to delete: "${path.basename(resolved)}" is not "${expectedBasename}".`);
  }

  const repoResolved = path.resolve(REPO_ROOT);
  if (
    resolved === repoResolved ||
    repoResolved.startsWith(resolved + path.sep) ||
    resolved.startsWith(repoResolved + path.sep)
  ) {
    fail(`refusing to delete: "${resolved}" is the repo or shares an ancestor/descendant path with it.`);
  }

  let probe = resolved;
  // Walks from the target up to (and including) `tmpdir()` itself; stops once `dirname` stops
  // making progress (a filesystem root), which `base` is never equal to by construction above.
  while (true) {
    if (existsSync(probe) && lstatSync(probe).isSymbolicLink()) {
      fail(`refusing to delete: "${probe}" is a symlink/reparse point.`);
    }
    if (probe === base) break;
    const next = path.dirname(probe);
    if (next === probe) break;
    probe = next;
  }

  console.log(`release-local: removing temp release dir: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}

function buildRelease(releaseDir, signtoolPath, conf) {
  const configOverlayPath = path.join(releaseDir, 'sign-config-overlay.json');
  // `bundle.windows.signCommand` merged for THIS invocation only via `--config`, never written
  // to the committed `tauri.conf.json` -- CI (`pnpm tauri build`, no `--config`) and `pnpm dev`/
  // `pnpm build` never see this, so there is no signing config for them to pick up by accident.
  // Tauri's own bundler (`tauri-bundler/src/bundle.rs`, `.../windows/nsis/mod.rs`) calls this
  // command on the main binary BEFORE NSIS packs it, and again on the generated installer
  // afterwards, both within this one `tauri build`.
  //
  // Built from a deep clone of the COMMITTED `bundle` section (not a bare `{windows:
  // {signCommand}}` object) so the result is correct regardless of whether `--config` deep-
  // merges or replaces at the `bundle` key: either way, every other committed bundle setting
  // (`active`, `targets`, `icon`, `windows.nsis`, `windows.webviewInstallMode`) survives
  // unchanged, with only `windows.signCommand` added alongside them.
  const overlayBundle = structuredClone(conf.bundle ?? {});
  overlayBundle.windows = { ...(overlayBundle.windows ?? {}) };
  overlayBundle.windows.signCommand = {
    cmd: signtoolPath,
    args: [
      'sign',
      '/sha1',
      CERT_THUMBPRINT,
      '/fd',
      'SHA256',
      '/tr',
      TIMESTAMP_URL,
      '/td',
      'SHA256',
      '%1',
    ],
  };
  writeFileSync(configOverlayPath, JSON.stringify({ bundle: overlayBundle }, null, 2));

  const cargoTargetDir = path.join(releaseDir, 'cargo-target');
  const env = { ...process.env, CARGO_TARGET_DIR: cargoTargetDir };
  const result = run(
    CMD_EXE,
    ['/c', 'pnpm', 'exec', 'tauri', 'build', '--config', configOverlayPath],
    { cwd: REPO_ROOT, env, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`pnpm tauri build failed (exit ${result.status}).`);
  return cargoTargetDir;
}

// Requires the EXACT expected name (gate finding, PR #837 round 1, High: a glob/`.find()` over a
// shared, persistent bundle directory could previously pick a leftover installer from an older
// version) -- the release dir is fresh per `freshReleaseDir`, so only this build's own output can
// ever be present, but the exact-name check stays as a hard assertion rather than trusting that.
function locateNsisSetup(cargoTargetDir, productName, version) {
  const dir = path.join(cargoTargetDir, 'release', 'bundle', 'nsis');
  if (!existsSync(dir)) fail(`NSIS bundle directory not found at ${dir}`);
  const expectedName = `${productName}_${version}_x64-setup.exe`;
  const entries = readdirSync(dir);
  if (!entries.includes(expectedName)) {
    fail(
      `expected installer "${expectedName}" not found under ${dir}; found: ${entries.join(', ') || '(empty)'}`,
    );
  }
  return path.join(dir, expectedName);
}

// Best-effort proof that the copy of `refract-tauri.exe` NSIS actually packed inside the signed
// installer is itself signed (gate finding, PR #837 round 2, Medium) -- not just that the
// installer's own outer signature is valid. Needs 7-Zip (NSIS archives are a format 7-Zip knows
// how to list/extract); if it isn't present at its fixed path, this check is skipped (logged,
// not a failure) and the installer's own signature (checked by the caller just before this) is
// the only evidence. Extracts into a subdirectory of `extractParentDir` (this script's own
// per-run release dir), cleaned up by the caller's `safeRemoveReleaseDir` either way.
function verifyEmbeddedMainExeSignature(installerPath, extractParentDir, expectedPinHex) {
  if (!existsSync(SEVEN_ZIP_EXE)) {
    console.log(
      `release-local: 7-Zip not found at ${SEVEN_ZIP_EXE}; skipping the embedded-copy check ` +
        '(the installer itself is already verified above).',
    );
    return;
  }

  const extractDir = path.join(extractParentDir, 'embedded-check');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  const result = run(SEVEN_ZIP_EXE, ['x', installerPath, `-o${extractDir}`, '-y']);
  if (result.status !== 0) {
    console.log(
      `release-local: 7z could not extract the installer (exit ${result.status}); skipping the ` +
        `embedded-copy check.\n${result.stdout}${result.stderr}`,
    );
    return;
  }

  const embeddedExe = findFileRecursive(extractDir, 'refract-tauri.exe');
  if (!embeddedExe) {
    console.log(
      `release-local: no refract-tauri.exe found under the extracted installer at ${extractDir}; ` +
        'skipping the embedded-copy check.',
    );
    return;
  }

  console.log(`release-local: verifying the embedded copy at ${embeddedExe}`);
  verifySignature(embeddedExe, expectedPinHex);
}

function findFileRecursive(dir, name) {
  const lowerName = name.toLowerCase();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === lowerName) {
      return full;
    }
  }
  return null;
}

// Pin computed from the committed certificate file itself, not a second hardcoded copy, so this
// check can never silently drift from `certs/refract-codesign.cer`.
function expectedSignerPin() {
  return createHash('sha256').update(readFileSync(CERT_PATH)).digest('hex');
}

// Checks `Status -eq 'Valid'`, the signer certificate's own SHA-256 against the pin, AND that a
// trusted timestamp is present (gate finding, PR #837 round 1, Low: the previous version only
// checked `Status`, which does not by itself confirm THIS release's signature is the one that
// matters, or that `/tr` actually took effect).
function verifySignature(assetPath, expectedPinHex) {
  const escaped = assetPath.replace(/'/g, "''");
  const script = [
    `$sig = Get-AuthenticodeSignature -FilePath '${escaped}'`,
    `$signerSha256 = ''`,
    `if ($sig.SignerCertificate) { $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($sig.SignerCertificate.RawData); $signerSha256 = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLower() }`,
    `Write-Host ("Status=" + $sig.Status)`,
    `Write-Host ("SignerSha256=" + $signerSha256)`,
    `Write-Host ("HasTimestamp=" + [bool]$sig.TimeStamperCertificate)`,
    `Write-Host ("SignerSubject=" + $sig.SignerCertificate.Subject)`,
  ].join('; ');
  const result = runPowershell(script);
  if (result.status !== 0) {
    fail(`Get-AuthenticodeSignature failed for ${assetPath}:\n${result.stdout}${result.stderr}`);
  }
  const fields = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (fields.Status !== 'Valid') {
    fail(`${assetPath}: Authenticode status is "${fields.Status}", expected "Valid".`);
  }
  if (fields.SignerSha256 !== expectedPinHex) {
    fail(
      `${assetPath}: signer certificate SHA-256 ${fields.SignerSha256} does not match the ` +
        `pinned certificate ${expectedPinHex} (certs/refract-codesign.cer).`,
    );
  }
  if (fields.HasTimestamp !== 'True') {
    fail(`${assetPath}: signature has no trusted timestamp (expected "/tr ${TIMESTAMP_URL}" to apply).`);
  }
  console.log(`${assetPath}: Valid, signer=${fields.SignerSubject}, pin matched, timestamped`);
}

function writeChecksum(assetPath) {
  const digest = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  const checksumPath = `${assetPath}.sha256`;
  writeFileSync(checksumPath, `${digest}  ${path.basename(assetPath)}`, { encoding: 'ascii' });
  return checksumPath;
}

// Extra defense beyond `--verify-tag` below (gate finding, PR #837 round 2, Low): `--verify-tag`
// only confirms the tag EXISTS on `origin`, not that it points at the exact commit this script
// just built and signed -- a local re-tag of `HEAD` without re-pushing, or the remote tag having
// moved, would otherwise slip through. Compares `origin`'s own `refs/tags/<tag>` against local
// `HEAD` directly; for an ANNOTATED tag, `ls-remote` lists both the tag object's own sha and a
// peeled `^{}` line with the commit it points to -- the peeled line is what must match `HEAD`,
// a lightweight tag has only the one line, which already names the commit.
function verifyRemoteTagMatchesHead(tag) {
  const remote = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    cwd: REPO_ROOT,
  });
  if (remote.status !== 0) {
    fail(`"git ls-remote origin refs/tags/${tag}" failed (exit ${remote.status}):\n${remote.stderr}`);
  }
  const lines = remote.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    fail(`origin has no tag ${tag} -- push the tagged commit before publishing without --dry-run.`);
  }
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const remoteSha = (peeled ?? lines[0]).split(/\s+/)[0];

  const head = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  if (head.status !== 0) {
    fail(`"git rev-parse HEAD" failed (exit ${head.status}):\n${head.stderr}`);
  }
  const headSha = head.stdout.trim();

  if (remoteSha !== headSha) {
    fail(
      `origin's tag ${tag} points at ${remoteSha}, but HEAD is ${headSha} -- push the current ` +
        'commit (and re-tag/re-push) before publishing, so the published release matches what ' +
        'this script actually built and signed.',
    );
  }
}

// Resolves what `gh release create` should use for release notes: GitHub's own `--generate-notes`
// by default, or (with `--notes-from-changelog`) the `## vX.Y.Z` section `release.mjs` already
// wrote to CHANGELOG.md for this exact version, written out to a scratch file under this run's
// own `releaseDir` (already cleaned up by `safeRemoveReleaseDir` either way, so no extra cleanup
// is needed here).
function resolveReleaseNotesArgs(version, releaseDir) {
  if (!NOTES_FROM_CHANGELOG) return ['--generate-notes'];
  if (!existsSync(CHANGELOG_PATH)) fail(`--notes-from-changelog: ${CHANGELOG_PATH} does not exist.`);
  const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
  const section = extractChangelogSection(changelog, version);
  if (!section) fail(`--notes-from-changelog: CHANGELOG.md has no "## v${version}" section.`);
  // Strip the leading `## vX.Y.Z (date)` heading itself -- `gh release create` already shows the
  // tag/version as the release's own title; the notes file is just the body beneath it.
  const body = section.replace(/^## .+\n+/, '');
  const notesPath = path.join(releaseDir, 'release-notes.md');
  writeFileSync(notesPath, body);
  return ['--notes-file', notesPath];
}

// `--verify-tag` (gate finding, PR #837 round 1, Medium): aborts instead of creating the tag at
// the remote default branch's tip if `tag` was never pushed -- the release must point at the
// EXACT commit this script built and signed, never a different one `gh` created on its own.
function publishRelease(tag, assets, notesArgs) {
  const result = run('gh', ['release', 'create', tag, ...assets, '--verify-tag', ...notesArgs], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`gh release create failed (exit ${result.status}).`);
}

function main() {
  checkCleanWorktree();
  verifyCertInStore(CERT_THUMBPRINT);
  const conf = readTauriConf();
  const tag = verifyTagMatchesVersion(conf.version);

  const releaseDir = freshReleaseDir(conf.version);
  safeRemoveReleaseDir(releaseDir, conf.version);
  mkdirSync(releaseDir, { recursive: true });

  try {
    const signtool = locateSigntool();
    const cargoTargetDir = buildRelease(releaseDir, signtool, conf);
    const nsisSetup = locateNsisSetup(cargoTargetDir, conf.productName, conf.version);

    // Tauri's own bundler already signed `nsisSetup` (and the main binary copy it packed inside
    // it) through the `signCommand` overlay above. The loose build-tree `refract-tauri.exe` is
    // deliberately NOT separately re-signed or verified (gate finding, round 2, Medium): Tauri
    // restores it to unsigned once bundling finishes, by design, and that copy never ships --
    // only the installer (verified below) and the copy it actually embeds (verified by
    // `verifyEmbeddedMainExeSignature`) matter.
    const expectedPin = expectedSignerPin();
    verifySignature(nsisSetup, expectedPin);
    verifyEmbeddedMainExeSignature(nsisSetup, releaseDir, expectedPin);

    const nsisChecksum = writeChecksum(nsisSetup);

    // Resolved BEFORE the dry-run return (gate fix, round 2): `pnpm release:local -- --dry-run
    // --notes-from-changelog` must still exercise the CHANGELOG.md extraction/notes-file write,
    // not skip it until the one real, unrepeatable release run. Only `publishRelease` itself
    // (the actual `gh release create`) is gated on `DRY_RUN` below.
    const notesArgs = resolveReleaseNotesArgs(conf.version, releaseDir);

    if (DRY_RUN) {
      console.log('release-local: --dry-run, built and signed but not publishing.');
      if (NOTES_FROM_CHANGELOG) {
        console.log(`release-local: --dry-run with --notes-from-changelog -- would publish with: ${notesArgs.join(' ')}`);
      }
      return;
    }

    verifyRemoteTagMatchesHead(tag);

    // Only the installer (and its checksum) are published: it is the only asset the updater ever
    // downloads (`src-tauri/src/updates/installer.rs`) or verifies
    // (`src-tauri/src/updates/signature.rs`) -- `refract-tauri.exe` is signed so the copy NSIS
    // installs onto disk carries a valid signature too, but it is never its own release asset.
    publishRelease(tag, [nsisSetup, nsisChecksum], notesArgs);
  } finally {
    safeRemoveReleaseDir(releaseDir, conf.version);
  }
}

try {
  main();
} catch (err) {
  console.error(`release-local: ${err.message}`);
  process.exit(1);
}
