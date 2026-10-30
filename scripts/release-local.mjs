#!/usr/bin/env node
// Local release script: signs Refract's installer with a self-signed cert whose private key lives only in the
// maintainer's `Cert:\CurrentUser\My` store, so it can never run in CI. Always deletes its temp release dir; no `--keep`.

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

const CERT_THUMBPRINT = '31B95999D331BD33210126432FAB3FF18ECA5DBD';
const TIMESTAMP_URL = 'http://timestamp.digicert.com';
const DRY_RUN = process.argv.includes('--dry-run');
const NOTES_FROM_CHANGELOG = process.argv.includes('--notes-from-changelog');

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CERTUTIL_EXE = path.join(SYSTEM_ROOT, 'System32', 'certutil.exe');
const CMD_EXE = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
// Fixed path, never `PATH`-resolved; only the best-effort embedded-copy check uses it.
const SEVEN_ZIP_EXE = 'C:\\Program Files\\7-Zip\\7z.exe';

// A PowerShell 7 `Modules` dir in `PSModulePath` makes powershell.exe 5.1 fail to load
// `Microsoft.PowerShell.Security` (duplicate type data), breaking `Get-AuthenticodeSignature`.
const RESTRICTED_PSMODULEPATH = [
  path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'),
  path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
].join(';');

// Throws instead of `process.exit` so `main`'s `finally` cleanup of the release dir still runs.
function fail(message) {
  throw new Error(message);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// A spread `process.env` keeps the inherited key's case (e.g. `PSMODULEPATH`), so drop every case variant first.
function runPowershell(script) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
  );
  env.PSModulePath = RESTRICTED_PSMODULEPATH;
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

// Uses `certutil` rather than the `Cert:` drive, which is not reliably autoloaded in non-interactive shells.
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

// A tag/version mismatch would make `install_on_quit.rs`'s version check report every future install as failed.
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

// Never `PATH`-resolved, so a stale signtool can't sign a release. Picks the numerically highest SDK version
// across both roots (a lexical sort could prefer a lower version under the other root).
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

// Fresh per-release dir: the shared dev target dir keeps old bundles and a concurrent build could overwrite the exe mid-release.
function freshReleaseDir(version) {
  return path.join(tmpdir(), `refract-release-${version}`);
}

// Delete guard: only a direct child of `tmpdir()` named `refract-release-<version>`, never the repo or its
// ancestors, and never through a symlink/junction (a redirected `%TEMP%` must not redirect the delete).
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
  // Merged via `--config` for this build only, never written to `tauri.conf.json`, so CI and dev builds never sign.
  // Cloned from the committed `bundle` so every other bundle setting survives whether `--config` merges or replaces.
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

// Exact name, not a glob: a leftover installer from an older version must never be picked.
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

// Best-effort: proves the exe NSIS packed into the installer is signed too. Skipped (logged) without 7-Zip.
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

// Pin comes from the committed certificate file, so it can't drift from a second hardcoded copy.
function expectedSignerPin() {
  return createHash('sha256').update(readFileSync(CERT_PATH)).digest('hex');
}

// Also requires a trusted timestamp: `Status` alone doesn't confirm `/tr` took effect.
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
    fail(`${assetPath}: Authenticode status is "${fields.Status}", expected "Valid".\n${result.stderr}`);
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

// `--verify-tag` only checks the tag exists on `origin`; compare it to HEAD too, since a local re-tag or moved
// remote tag would slip through. For an annotated tag the peeled `^{}` line names the commit.
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

// Notes come from GitHub's `--generate-notes` by default, or the CHANGELOG.md section for this version.
function resolveReleaseNotesArgs(version, releaseDir) {
  if (!NOTES_FROM_CHANGELOG) return ['--generate-notes'];
  if (!existsSync(CHANGELOG_PATH)) fail(`--notes-from-changelog: ${CHANGELOG_PATH} does not exist.`);
  const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
  const section = extractChangelogSection(changelog, version);
  if (!section) fail(`--notes-from-changelog: CHANGELOG.md has no "## v${version}" section.`);
  // `gh release create` already shows the tag as the title, so drop the heading.
  const body = section.replace(/^## .+\n+/, '');
  const notesPath = path.join(releaseDir, 'release-notes.md');
  writeFileSync(notesPath, body);
  return ['--notes-file', notesPath];
}

// `--verify-tag` aborts rather than letting `gh` create the tag at the default branch tip.
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

    // The loose build-tree exe is restored to unsigned by Tauri after bundling and never ships, so it is not verified.
    const expectedPin = expectedSignerPin();
    verifySignature(nsisSetup, expectedPin);
    verifyEmbeddedMainExeSignature(nsisSetup, releaseDir, expectedPin);

    const nsisChecksum = writeChecksum(nsisSetup);

    // Resolved before the dry-run return so `--dry-run --notes-from-changelog` still exercises the extraction.
    const notesArgs = resolveReleaseNotesArgs(conf.version, releaseDir);

    if (DRY_RUN) {
      console.log('release-local: --dry-run, built and signed but not publishing.');
      if (NOTES_FROM_CHANGELOG) {
        console.log(`release-local: --dry-run with --notes-from-changelog -- would publish with: ${notesArgs.join(' ')}`);
      }
      return;
    }

    verifyRemoteTagMatchesHead(tag);

    // Only the installer and its checksum are published; the updater downloads nothing else.
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
