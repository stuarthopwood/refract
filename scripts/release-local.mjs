#!/usr/bin/env node
// Local release script (lane R11d, follow-up to #794): Stuart decided (2026-10-14) to sign
// Refract's own installer locally with a self-signed code-signing certificate rather than buy a
// CA-issued one; the certificate's private key lives only in his own `Cert:\CurrentUser\My`
// store (RSA 3072, not exportable), so signing can only ever happen on his own workstation --
// never in CI (`.github/workflows/release.yml` builds and verifies the bundle on every tag push,
// but never signs or publishes).
//
// What this script does, in order:
// 1. Fails unless the pinned certificate thumbprint is present in `Cert:\CurrentUser\My`.
// 2. Fails unless the current commit's exact git tag equals `v<version>` from
//    `src-tauri/tauri.conf.json` (the same check `release.yml` makes against a pushed tag ref;
//    here against the locally-checked-out HEAD instead).
// 3. Runs `pnpm tauri build` (a full NSIS bundle, unsigned at this point).
// 4. Signs BOTH `refract-tauri.exe` and the generated `*-setup.exe` with `signtool.exe`,
//    located at a fixed Windows SDK install root (never `PATH` -- a stale or shadowed
//    `signtool` on `PATH` must never silently sign with the wrong tool), using
//    `/sha1 <thumbprint> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256` -- the
//    certificate is referenced by thumbprint directly from the Windows certificate store, never
//    exported to a `.pfx` (its private key cannot be exported at all).
// 5. Verifies both signatures with `Get-AuthenticodeSignature` and writes a `<asset>.sha256`
//    checksum sidecar for each.
// 6. Unless `--dry-run`, publishes the installer (and its checksum) to a new GitHub release via
//    `gh release create v<version>`.
//
// Decision (lane R11d): signs AFTER the bundle (the task's own documented alternative to wiring
// `bundle.windows.signCommand` into `tauri.conf.json`) rather than through Tauri's own signing
// hook. `tauri.conf.json` is shared with every other build (CI, `pnpm dev`, `pnpm build`); this
// keeps it completely free of any release-signing configuration, so there is no opt-in flag for
// those builds to accidentally fail open or closed on -- this script, and only this script, ever
// touches the built artefacts with `signtool.exe`, run exactly once per asset.
//
// `--dry-run`: builds and signs exactly as a real release would, but skips the `gh release
// create`/upload step. Used for `scripts/release-local.mjs --dry-run`'s own live-check proof;
// delete the resulting `CARGO_TARGET_DIR/release` bundle output afterwards (it is not committed
// anywhere and holds a real, freshly-signed installer).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAURI_CONF_PATH = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');

// `certs/refract-codesign.cer`'s SHA-1 thumbprint -- see that file's own commit and
// `src-tauri/src/updates/signature.rs`'s `SIGNING_CERT_SHA256` for the matching SHA-256 pin the
// updater checks the signed installer against. Expires 2031-10-14; rotate both together.
const CERT_THUMBPRINT = '31B95999D331BD33210126432FAB3FF18ECA5DBD';
const TIMESTAMP_URL = 'http://timestamp.digicert.com';
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const DRY_RUN = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`release-local: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function readVersion() {
  const conf = JSON.parse(readFileSync(TAURI_CONF_PATH, 'utf8'));
  if (!conf.version) fail(`${TAURI_CONF_PATH} has no "version" field.`);
  return conf.version;
}

// Reads the certificate directly from the Windows certificate store via `certutil` (no
// PowerShell `Cert:` drive dependency, which is not reliably auto-loaded in every non-interactive
// shell) -- `-store My <thumbprint>` both looks the certificate up AND filters to it, so success
// here means Stuart's signing certificate is actually present and usable.
function verifyCertInStore(thumbprint) {
  const result = run('certutil', ['-user', '-store', 'My', thumbprint]);
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
        `Tag this commit v${version} before releasing.`,
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
// highest version present (lexical sort matches numeric order for the `10.0.XXXXX.0` naming
// every Windows 10/11 SDK uses).
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
      const candidate = path.join(root, entry.name, 'x64', 'signtool.exe');
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    fail(
      'signtool.exe not found under a Windows 10 SDK bin directory (checked ' +
        `${roots.join(', ')}). Install the Windows SDK, or update this script's fixed roots.`,
    );
  }
  candidates.sort();
  return candidates[candidates.length - 1];
}

function buildRelease() {
  const env = { ...process.env };
  if (CARGO_TARGET_DIR) {
    env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
    env.CARGO_INCREMENTAL = '0';
  }
  const result = run('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`pnpm tauri build failed (exit ${result.status}).`);
}

function buildOutputDir() {
  return CARGO_TARGET_DIR
    ? path.join(CARGO_TARGET_DIR, 'release')
    : path.join(REPO_ROOT, 'src-tauri', 'target', 'release');
}

function locateMainExe() {
  const exe = path.join(buildOutputDir(), 'refract-tauri.exe');
  if (!existsSync(exe)) fail(`built exe not found at ${exe}`);
  return exe;
}

function locateNsisSetup() {
  const dir = path.join(buildOutputDir(), 'bundle', 'nsis');
  if (!existsSync(dir)) fail(`NSIS bundle directory not found at ${dir}`);
  const match = readdirSync(dir).find((name) => name.endsWith('-setup.exe'));
  if (!match) fail(`no *-setup.exe found under ${dir}`);
  return path.join(dir, match);
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

// `-Command` script body, not a path: `assetPath` is this script's own build output, never
// caller/network input, so a single-quote-escaped interpolation is sufficient here (same
// convention as `src-tauri/src/updates/install_on_quit.rs`'s `escape_single_quoted`).
//
// Restricted `PSModulePath` (observed on Stuart's own workstation, 2026-10-14): when a user
// profile's `PSModulePath` also lists a PowerShell 7 install's `Modules` directory alongside
// Windows PowerShell 5.1's own, `powershell.exe` (5.1) fails to autoload
// `Microsoft.PowerShell.Security` (duplicate `ObjectSecurity` extended type-data between the two
// copies) -- `Get-AuthenticodeSignature` then errors "command was found... but the module could
// not be loaded" instead of ever reporting a signature status. Restricting `PSModulePath` to
// only the two built-in Windows PowerShell module directories for this one invocation sidesteps
// the collision without touching the caller's own environment or profile.
function verifySignature(assetPath) {
  const escaped = assetPath.replace(/'/g, "''");
  const script =
    `$sig = Get-AuthenticodeSignature -FilePath '${escaped}'; ` +
    `if ($sig.Status -ne 'Valid') { Write-Error ("status=" + $sig.Status + " statusMessage=" + $sig.StatusMessage); exit 1 }; ` +
    `Write-Host ("Valid: " + $sig.SignerCertificate.Subject + " (thumbprint " + $sig.SignerCertificate.Thumbprint + ")")`;
  const env = {
    ...process.env,
    PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
  };
  const result = run('powershell', ['-NoProfile', '-Command', script], { env });
  if (result.status !== 0) {
    fail(`Get-AuthenticodeSignature did not report Valid for ${assetPath}:\n${result.stdout}${result.stderr}`);
  }
  console.log(result.stdout.trim());
}

function writeChecksum(assetPath) {
  const digest = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  const checksumPath = `${assetPath}.sha256`;
  writeFileSync(checksumPath, `${digest}  ${path.basename(assetPath)}`, { encoding: 'ascii' });
  return checksumPath;
}

function publishRelease(tag, assets) {
  const result = run('gh', ['release', 'create', tag, ...assets, '--generate-notes'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`gh release create failed (exit ${result.status}).`);
}

function main() {
  verifyCertInStore(CERT_THUMBPRINT);
  const version = readVersion();
  const tag = verifyTagMatchesVersion(version);

  buildRelease();

  const signtool = locateSigntool();
  const mainExe = locateMainExe();
  const nsisSetup = locateNsisSetup();

  for (const asset of [mainExe, nsisSetup]) {
    signAsset(signtool, asset);
    verifySignature(asset);
  }

  const [, nsisChecksum] = [mainExe, nsisSetup].map(writeChecksum);

  if (DRY_RUN) {
    console.log('release-local: --dry-run, built and signed but not publishing.');
    return;
  }

  // Only the installer (and its checksum) are published: it is the only asset the updater ever
  // downloads (`src-tauri/src/updates/installer.rs`) or verifies
  // (`src-tauri/src/updates/signature.rs`) -- `refract-tauri.exe` is signed so the copy NSIS
  // installs onto disk carries a valid signature too, but it is never its own release asset.
  publishRelease(tag, [nsisSetup, nsisChecksum]);
}

main();
