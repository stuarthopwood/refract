// Changelog generation shared by `release.mjs` (writes the `## vX.Y.Z` section to CHANGELOG.md
// on a real release, and previews the same section under `--dry-run` without writing anything)
// and `release-local.mjs`'s `--notes-from-changelog` flag (re-reads the section this module
// already wrote, to use as the GitHub release's own notes).
//
// Source of the PR list: `gh api repos/<repo>/releases/generate-notes`, the exact same data
// GitHub's own "Generate release notes" button would produce -- never a second hand-rolled
// git-log walk. Its `body` is GitHub's own Markdown: a `## What's Changed` section of
// `* <PR title> by @<user> in <PR url>` bullets, optionally a `## New Contributors` section, and
// a trailing `**Full Changelog**: <compare url>` line. Only the `What's Changed` bullets are
// used here; the rest is GitHub's own UI sugar, not this project's changelog shape.

import { execFileSync } from 'node:child_process';
import { assertValidSemver } from './release-versions.mjs';

const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;
const BULLET_RE = /^\* (.+) by (@\S+) in (https:\/\/\S+)\s*$/;

const SECTION_ORDER = [
  ['breaking', 'Breaking changes'],
  ['feature', 'Features'],
  ['fix', 'Fixes'],
  ['other', 'Other'],
];

export function fetchGeneratedNotes({ repo, tagName, targetCommitish, previousTagName }) {
  const args = [
    'api',
    `repos/${repo}/releases/generate-notes`,
    '-f',
    `tag_name=${tagName}`,
    '-f',
    `target_commitish=${targetCommitish}`,
  ];
  if (previousTagName) {
    args.push('-f', `previous_tag_name=${previousTagName}`);
  }
  const raw = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(raw);
}

// Extracts just the `## What's Changed` bullets -- stops at the next `## ` heading (or the end
// of the body if there is none), so `## New Contributors` and the trailing `**Full Changelog**`
// link never leak into the changelog section this writes.
export function parseWhatsChangedBullets(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === "## What's Changed");
  if (start === -1) return [];
  const bullets = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    const m = line.match(BULLET_RE);
    if (m) bullets.push({ title: m[1], author: m[2], url: m[3] });
  }
  return bullets;
}

// Conventional-commit shape parsed from a subject/title: `type(scope)!: description`. Returns
// null for a non-conventional (legacy) subject.
export function parseConventionalSubject(subject) {
  const m = subject.match(CONVENTIONAL_RE);
  if (!m) return null;
  return { type: m[1], scope: m[2] ? m[2].slice(1, -1) : null, breaking: Boolean(m[3]), description: m[4] };
}

// `!` after the type (with or without a scope) means breaking regardless of which type it's
// attached to; `feat` bumps/categorises as a feature; `fix`/`perf` as a fix; every other
// conventional type, and every non-conventional (legacy) title, is "other". The type is matched
// case-insensitively, matching `release.mjs`'s own `inferLevel` (Conventional Commits' type is
// case-insensitive; only the `BREAKING CHANGE` footer keyword itself stays uppercase).
export function classifyTitle(title) {
  const parsed = parseConventionalSubject(title);
  if (!parsed) return 'other';
  if (parsed.breaking) return 'breaking';
  const type = parsed.type.toLowerCase();
  if (type === 'feat') return 'feature';
  if (type === 'fix' || type === 'perf') return 'fix';
  return 'other';
}

// Builds the `## vX.Y.Z (YYYY-MM-DD)` section body (heading included) from the bullets GitHub's
// generate-notes returned, grouped by `classifyTitle`. A legacy, non-conventional title (for
// example an old `R3: ...` PR title) lands in Other, verbatim -- never forced into a type it
// never claimed.
export function buildChangelogSection(version, date, bullets) {
  const groups = { breaking: [], feature: [], fix: [], other: [] };
  for (const bullet of bullets) {
    groups[classifyTitle(bullet.title)].push(bullet);
  }
  const lines = [`## v${version} (${date})`, ''];
  for (const [key, heading] of SECTION_ORDER) {
    const items = groups[key];
    if (items.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const b of items) {
      lines.push(`- ${b.title} (${b.url})`);
    }
    lines.push('');
  }
  if (bullets.length === 0) {
    lines.push('_No merged pull requests in this range._', '');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// Prepends a newly-built section to CHANGELOG.md's existing text (or creates the file with a
// short header if it doesn't exist yet). Newest release stays on top.
export function prependChangelogSection(existingText, section) {
  const HEADER = '# Changelog\n';
  if (existingText == null || existingText.trim().length === 0) {
    return `${HEADER}\n${section}`;
  }
  // Normalised to LF first: a fresh git checkout on Windows (`core.autocrlf=true`, the default
  // here -- confirmed by git's own "LF will be replaced by CRLF" warnings on this repo) rewrites
  // a committed LF `CHANGELOG.md` to CRLF in the working tree, which would otherwise fail the
  // `startsWith(HEADER)` check below and silently prepend a SECOND `# Changelog` header on every
  // release after the first fresh checkout.
  const normalised = existingText.replace(/\r\n/g, '\n');
  const body = normalised.startsWith(HEADER) ? normalised.slice(HEADER.length).replace(/^\n+/, '') : normalised;
  return `${HEADER}\n${section}\n${body}`;
}

// Extracts a previously-written `## vX.Y.Z (...)` section's text (heading through the line
// before the next `## vA.B.C (` heading, or end of file) back out of CHANGELOG.md -- used by
// `release-local.mjs --notes-from-changelog` to source the GitHub release notes for a version
// `release.mjs` already committed, never a second copy of the generation logic. Returns null if
// no section for that version exists.
export function extractChangelogSection(changelogText, version) {
  assertValidSemver(version, 'extractChangelogSection version');
  // Normalised to LF first, same reasoning as `prependChangelogSection`: a CRLF working-tree
  // copy must not change where the heading/next-heading boundaries land.
  const normalised = changelogText.replace(/\r\n/g, '\n');
  const headingRe = new RegExp(`^## v${version.replace(/\./g, '\\.')} \\(`, 'm');
  const match = headingRe.exec(normalised);
  if (!match) return null;
  const start = match.index;
  const rest = normalised.slice(start + 1);
  const nextHeadingMatch = /\n## v\d+\.\d+\.\d+ \(/.exec(rest);
  const end = nextHeadingMatch ? start + 1 + nextHeadingMatch.index : normalised.length;
  return normalised.slice(start, end).replace(/\n+$/, '\n');
}
