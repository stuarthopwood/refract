// Version-field helpers for `check-versions.mjs` and `release.mjs`. The release version must agree in
// package.json, tauri.conf.json, Cargo.toml and Cargo.lock. Edits are minimal text replacements, never
// a JSON/TOML round-trip, so other bytes stay untouched. Cargo.lock is read only; it is synced by
// `cargo update -p refract-tauri --offline` (see release.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CARGO_PACKAGE_NAME = 'refract-tauri';
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Plain x.y.z only; fails loudly before a malformed value reaches a regex, tag name, or git call.
export function assertValidSemver(version, label) {
  if (!SEMVER_RE.test(version)) {
    versionFail(`${label}: "${version}" is not a valid x.y.z semver version`);
  }
}

export function manifestPaths(repoRoot) {
  return {
    packageJson: path.join(repoRoot, 'package.json'),
    tauriConf: path.join(repoRoot, 'src-tauri', 'tauri.conf.json'),
    cargoToml: path.join(repoRoot, 'src-tauri', 'Cargo.toml'),
    cargoLock: path.join(repoRoot, 'src-tauri', 'Cargo.lock'),
  };
}

export const MANIFEST_LABELS = {
  packageJson: 'package.json',
  tauriConf: 'src-tauri/tauri.conf.json',
  cargoToml: 'src-tauri/Cargo.toml ([package] refract-tauri)',
  cargoLock: 'src-tauri/Cargo.lock (refract-tauri entry)',
};

function versionFail(message) {
  throw new Error(message);
}

// package.json and tauri.conf.json each have exactly one top-level "version" key.
function extractJsonVersion(raw, label) {
  const m = raw.match(/"version"\s*:\s*"([^"]*)"/);
  if (!m) versionFail(`${label}: no "version" field found`);
  return m[1];
}

function replaceJsonVersion(raw, newVersion, label) {
  const re = /"version"\s*:\s*"([^"]*)"/;
  if (!re.test(raw)) versionFail(`${label}: no "version" field found`);
  return raw.replace(re, `"version": "${newVersion}"`);
}

// Bounded to the `[package]` table so a future `[dependencies.foo]` with a bare `version = ` line can't match.
function packageTableSlice(raw, label) {
  const start = raw.indexOf('[package]');
  if (start === -1) versionFail(`${label}: no [package] table found`);
  const nextHeader = raw.indexOf('\n[', start + 1);
  const end = nextHeader === -1 ? raw.length : nextHeader;
  return { start, end };
}

function extractCargoTomlVersion(raw, label) {
  const { start, end } = packageTableSlice(raw, label);
  const m = raw.slice(start, end).match(/^version = "([^"]*)"/m);
  if (!m) versionFail(`${label}: no version field in [package] table`);
  return m[1];
}

function replaceCargoTomlVersion(raw, newVersion, label) {
  const { start, end } = packageTableSlice(raw, label);
  const slice = raw.slice(start, end);
  const re = /^version = "[^"]*"/m;
  if (!re.test(slice)) versionFail(`${label}: no version field in [package] table`);
  return raw.slice(0, start) + slice.replace(re, `version = "${newVersion}"`) + raw.slice(end);
}

// Bounded to the block whose `name` matches so another dependency can't collide.
function extractCargoLockVersion(raw, label) {
  const nameRe = new RegExp(`name = "${CARGO_PACKAGE_NAME}"`, 'g');
  const matches = [...raw.matchAll(nameRe)];
  if (matches.length === 0) versionFail(`${label}: no "${CARGO_PACKAGE_NAME}" package entry found`);
  if (matches.length > 1) {
    versionFail(`${label}: multiple "${CARGO_PACKAGE_NAME}" package entries found`);
  }
  const nameIdx = matches[0].index;
  const blockEndRaw = raw.indexOf('\n\n', nameIdx);
  const blockEnd = blockEndRaw === -1 ? raw.length : blockEndRaw;
  const m = raw.slice(nameIdx, blockEnd).match(/^version = "([^"]*)"/m);
  if (!m) versionFail(`${label}: no version field in its own package entry`);
  return m[1];
}

// Returns raw text too, for release.mjs's restore-on-failure path.
export function readAllVersions(repoRoot) {
  const paths = manifestPaths(repoRoot);
  const raw = {
    packageJson: readFileSync(paths.packageJson, 'utf8'),
    tauriConf: readFileSync(paths.tauriConf, 'utf8'),
    cargoToml: readFileSync(paths.cargoToml, 'utf8'),
    cargoLock: readFileSync(paths.cargoLock, 'utf8'),
  };
  const versions = {
    packageJson: extractJsonVersion(raw.packageJson, MANIFEST_LABELS.packageJson),
    tauriConf: extractJsonVersion(raw.tauriConf, MANIFEST_LABELS.tauriConf),
    cargoToml: extractCargoTomlVersion(raw.cargoToml, MANIFEST_LABELS.cargoToml),
    cargoLock: extractCargoLockVersion(raw.cargoLock, MANIFEST_LABELS.cargoLock),
  };
  for (const [key, version] of Object.entries(versions)) {
    assertValidSemver(version, MANIFEST_LABELS[key]);
  }
  return { paths, raw, versions };
}

export function checkVersionsEqual(versions) {
  const entries = Object.entries(versions);
  const values = new Set(entries.map(([, v]) => v));
  return { ok: values.size === 1, entries };
}

// Cargo.lock is excluded: `cargo update -p refract-tauri --offline` syncs it (see release.mjs).
export function writeManifestVersions(raw, newVersion) {
  return {
    packageJson: replaceJsonVersion(raw.packageJson, newVersion, MANIFEST_LABELS.packageJson),
    tauriConf: replaceJsonVersion(raw.tauriConf, newVersion, MANIFEST_LABELS.tauriConf),
    cargoToml: replaceCargoTomlVersion(raw.cargoToml, newVersion, MANIFEST_LABELS.cargoToml),
  };
}

export function bumpVersion(version, level) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a semver version: ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else if (level === 'patch') {
    patch += 1;
  } else {
    throw new Error(`unknown bump level: ${level}`);
  }
  return `${major}.${minor}.${patch}`;
}

// Asserts cargo touched only the refract-tauri `version = "..."` line. Both sides are LF-normalised
// because cargo writes LF while a CRLF checkout would otherwise flag every line as changed.
export function assertCargoLockOnlyVersionChanged(before, after, label) {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');
  if (beforeLines.length !== afterLines.length) {
    versionFail(
      `${label}: cargo update changed the line count (${beforeLines.length} -> ${afterLines.length}); ` +
        'expected only the refract-tauri version line to change',
    );
  }
  const diffLines = [];
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) diffLines.push(i);
  }
  if (diffLines.length === 0) {
    versionFail(`${label}: cargo update did not change anything (expected the version line to change)`);
  }
  if (diffLines.length > 1) {
    versionFail(
      `${label}: cargo update changed ${diffLines.length} lines, not just the version line ` +
        `(1-based line numbers: ${diffLines.map((i) => i + 1).join(', ')})`,
    );
  }
  const VERSION_LINE_RE = /^version = "[^"]*"$/;
  const lineNo = diffLines[0];
  if (!VERSION_LINE_RE.test(beforeLines[lineNo]) || !VERSION_LINE_RE.test(afterLines[lineNo])) {
    versionFail(`${label}: the one changed line (${lineNo + 1}) is not a plain "version = ..." line`);
  }
}
