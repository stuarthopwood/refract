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
// 6. Re-signs the loose `refract-tauri.exe` copy directly (Tauri's own bundler restores the
//    build-tree binary to its unsigned, unpatched state once bundling finishes, by design, so it
//    can run bundling again for a second package type without the first's patches): `signtool`,
//    located at a fixed Windows SDK install root (never `PATH`, chosen by the highest PARSED SDK
//    version actually present), using
//    `/sha1 <thumbprint> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256`.
// 7. Verifies the loose exe and the installer with `Get-AuthenticodeSignature`, requiring
//    `Status -eq 'Valid'`, the signer certificate's own SHA-256 to equal the pin (computed from
//    the committed `certs/refract-codesign.cer`, not a second hardcoded copy), and a trusted
//    timestamp to be present.
// 8. Writes a `<asset>.sha256` checksum sidecar for the installer.
// 9. Unless `--dry-run`, publishes the installer (and its checksum) to a new GitHub release via
//    `gh release create v<version> --verify-tag` (requires the tag to already exist on the
//    remote -- push the tagged commit before running this without `--dry-run`).
// 10. Deletes the fresh per-release temp directory by its own literal path, whether or not the
//     run published.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAURI_CONF_PATH = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const CERT_PATH = path.join(REPO_ROOT, 'src-tauri', 'certs', 'refract-codesign.cer');

// `certs/refract-codesign.cer`'s SHA-1 thumbprint, used to select the signing certificate in
// `Cert:\CurrentUser\My` and with `signtool /sha1`. The expected SHA-256 PIN the updater checks
// against (`src-tauri/src/updates/signature.rs`'s `SIGNING_CERT_SHA256_PINS`) is computed from
// `CERT_PATH` directly below, rather than hardcoded a second time here.
const CERT_THUMBPRINT = '31B95999D331BD33210126432FAB3FF18ECA5DBD';
const TIMESTAMP_URL = 'http://timestamp.digicert.com';
const DRY_RUN = process.argv.includes('--dry-run');

// Absolute, never `PATH`-resolved (gate finding, PR #837 round 1, Low): Node's `spawnSync` also
// searches the current working directory first on Windows, so even a bare command name is not
// fully PATH-only -- these are the fixed, always-present per-machine locations for each tool.
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CERTUTIL_EXE = path.join(SYSTEM_ROOT, 'System32', 'certutil.exe');
const CMD_EXE = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');

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

function fail(message) {
  console.error(`release-local: ${message}`);
  process.exit(1);
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

function locateMainExe(cargoTargetDir) {
  const exe = path.join(cargoTargetDir, 'release', 'refract-tauri.exe');
  if (!existsSync(exe)) fail(`built exe not found at ${exe}`);
  return exe;
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

function signAsset(signtool, assetPath) {
  const args = [
    'sign',
    '/sha1',
    CERT_THUMBPRINT,
    '/fd',
    'SHA256',
    '/tr',
    TIMESTAMP_URL,
    '/td',
    'SHA256',
    assetPath,
  ];
  const result = run(signtool, args);
  if (result.status !== 0) {
    fail(`signtool sign failed for ${assetPath} (exit ${result.status}):\n${result.stdout}${result.stderr}`);
  }
  console.log(result.stdout.trim());
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

// `--verify-tag` (gate finding, PR #837 round 1, Medium): aborts instead of creating the tag at
// the remote default branch's tip if `tag` was never pushed -- the release must point at the
// EXACT commit this script built and signed, never a different one `gh` created on its own.
function publishRelease(tag, assets) {
  const result = run('gh', ['release', 'create', tag, ...assets, '--verify-tag', '--generate-notes'], {
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
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  try {
    const signtool = locateSigntool();
    const cargoTargetDir = buildRelease(releaseDir, signtool, conf);

    const mainExe = locateMainExe(cargoTargetDir);
    const nsisSetup = locateNsisSetup(cargoTargetDir, conf.productName, conf.version);

    // Tauri's own bundler already signed `nsisSetup` (and the main binary copy it embedded)
    // through the `signCommand` overlay above; it restores the loose `mainExe` on disk back to
    // its unsigned, unpatched state once bundling finishes (by design, so a second package type
    // in the same run never sees the first's patches) -- re-signed here directly so the
    // standalone exe this script also reports on is a real, independently-usable signed asset.
    signAsset(signtool, mainExe);

    const expectedPin = expectedSignerPin();
    verifySignature(mainExe, expectedPin);
    verifySignature(nsisSetup, expectedPin);

    const nsisChecksum = writeChecksum(nsisSetup);

    if (DRY_RUN) {
      console.log('release-local: --dry-run, built and signed but not publishing.');
      return;
    }

    // Only the installer (and its checksum) are published: it is the only asset the updater ever
    // downloads (`src-tauri/src/updates/installer.rs`) or verifies
    // (`src-tauri/src/updates/signature.rs`) -- `refract-tauri.exe` is signed so the copy NSIS
    // installs onto disk carries a valid signature too, but it is never its own release asset.
    publishRelease(tag, [nsisSetup, nsisChecksum]);
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
}

main();
