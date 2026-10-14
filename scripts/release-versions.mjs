// Shared version-field helpers for `check-versions.mjs` and `release.mjs` (the release
// pipeline). The canonical release version lives in FOUR places that must always agree:
// `package.json`'s `"version"`, `src-tauri/tauri.conf.json`'s `"version"`, `src-tauri/Cargo.toml`'s
// `[package]` `version` (package `refract-tauri`), and `src-tauri/Cargo.lock`'s own
// `refract-tauri` package entry's `version`.
//
// This module only reads/writes those four specific fields with precise, minimal text edits --
// it never round-trips any file through `JSON.parse`/`JSON.stringify` or a TOML/lockfile writer,
// so every other byte of each file (formatting, key order, comments, unrelated dependency
// entries) is left untouched. `Cargo.lock` is READ here but never text-replaced: its own-crate
// version field is kept in sync by `cargo update -p refract-tauri --offline` (see
// `release.mjs`), which also verifies no OTHER package in the lockfile moved.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CARGO_PACKAGE_NAME = 'refract-tauri';
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

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

// `package.json` and `tauri.conf.json` share the same `"version": "x.y.z"` JSON shape, and each
// has exactly one such key at its top level -- a single whole-file match is safe for both.
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

// Cargo.toml's own package version lives only inside the `[package]` table. Every dependency
// version in this manifest is either an inline table (`{ version = "...", ... }`, never at the
// start of a line) or a bare semver string under a key other than `version`, so a whole-file
// match would likely still be safe today -- but bounding the search to the `[package]` table's
// own text keeps this correct even if a future `[dependencies.foo]` block ever added a bare
// start-of-line `version = "..."` of its own.
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

// Cargo.lock's own-crate entry is always `[[package]]` / `name = "refract-tauri"` /
// `version = "x.y.z"`, in that order (cargo's own lockfile writer never varies it). Bounded to
// the one block whose `name` matches -- not a whole-file match -- so an unrelated dependency
// could never collide even if one were ever literally named `refract-tauri` too.
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

// Reads all four files and their version fields. Returns the raw text too (every original byte,
// for `release.mjs`'s restore-on-failure path) alongside the extracted version strings.
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
  return { paths, raw, versions };
}

export function checkVersionsEqual(versions) {
  const entries = Object.entries(versions);
  const values = new Set(entries.map(([, v]) => v));
  return { ok: values.size === 1, entries };
}

// Updates package.json, tauri.conf.json and Cargo.toml's text in memory (Cargo.lock is
// deliberately excluded: its own-crate version is synced by `cargo update -p refract-tauri
// --offline` in `release.mjs`, never by a direct text replace here).
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
