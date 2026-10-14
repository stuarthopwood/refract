#!/usr/bin/env node
// Fails unless `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (package
// `refract-tauri`) and `src-tauri/Cargo.lock` (the `refract-tauri` package entry) all name the
// exact same version. These four must always move together -- `scripts/release.mjs` is the only
// thing allowed to bump them, and this check is what proves it did so correctly. Wired into
// `.github/workflows/ci.yml` right after "Check file size", and run as part of `pnpm ci:local`
// and `pnpm release` (both the real run and `--dry-run`).
//
// Usage: node scripts/check-versions.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_LABELS, checkVersionsEqual, readAllVersions } from './release-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function main() {
  const { versions } = readAllVersions(repoRoot);
  const { ok, entries } = checkVersionsEqual(versions);

  for (const [key, value] of entries) {
    console.log(`  ${MANIFEST_LABELS[key]}: ${value}`);
  }

  if (!ok) {
    console.error('\ncheck:versions: version mismatch across the four manifests above.');
    process.exit(1);
  }

  console.log(`\ncheck:versions: all four manifests agree on ${entries[0][1]}.`);
}

try {
  main();
} catch (err) {
  console.error(`check:versions: ${err.message}`);
  process.exit(1);
}
