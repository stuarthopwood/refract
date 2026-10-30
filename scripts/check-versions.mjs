#!/usr/bin/env node
// Fails unless `package.json`, `tauri.conf.json`, `Cargo.toml` and the `refract-tauri` entry in `Cargo.lock` name the same version;
// only `scripts/release.mjs` may bump them, and this proves it did so correctly.
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
