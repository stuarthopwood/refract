// Changelog generation shared by `release.mjs` and `release-local.mjs --notes-from-changelog`.
// PR list comes from `gh api repos/<repo>/releases/generate-notes` (same data as GitHub's button), never a hand-rolled git-log walk.

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

// Only the `## What's Changed` bullets; New Contributors and the Full Changelog link must not leak in.
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

// Parses `type(scope)!: description`; null for a non-conventional (legacy) subject.
export function parseConventionalSubject(subject) {
  const m = subject.match(CONVENTIONAL_RE);
  if (!m) return null;
  return { type: m[1], scope: m[2] ? m[2].slice(1, -1) : null, breaking: Boolean(m[3]), description: m[4] };
}

// `!` means breaking for any type. Type matching is case-insensitive, like `release.mjs`'s `inferLevel`.
export function classifyTitle(title) {
  const parsed = parseConventionalSubject(title);
  if (!parsed) return 'other';
  if (parsed.breaking) return 'breaking';
  const type = parsed.type.toLowerCase();
  if (type === 'feat') return 'feature';
  if (type === 'fix' || type === 'perf') return 'fix';
  return 'other';
}

// Legacy non-conventional titles land in Other verbatim.
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

// Prepends a section to CHANGELOG.md (newest on top), creating the file if missing.
export function prependChangelogSection(existingText, section) {
  const HEADER = '# Changelog\n';
  if (existingText == null || existingText.trim().length === 0) {
    return `${HEADER}\n${section}`;
  }
  // Normalise to LF: a Windows checkout (autocrlf) yields CRLF, which would fail `startsWith(HEADER)` and prepend a second header.
  const normalised = existingText.replace(/\r\n/g, '\n');
  const body = normalised.startsWith(HEADER) ? normalised.slice(HEADER.length).replace(/^\n+/, '') : normalised;
  return `${HEADER}\n${section}\n${body}`;
}

// Offset of the first line that begins with `heading`, or -1; a plain scan, no regex built from input.
function findHeadingStart(text, heading) {
  let offset = 0;
  while (offset <= text.length) {
    if (text.startsWith(heading, offset)) return offset;
    const nl = text.indexOf('\n', offset);
    if (nl === -1) return -1;
    offset = nl + 1;
  }
  return -1;
}

// Extracts a `## vX.Y.Z (...)` section for `release-local.mjs --notes-from-changelog`; null if absent.
export function extractChangelogSection(changelogText, version) {
  assertValidSemver(version, 'extractChangelogSection version');
  // Normalise to LF so CRLF copies do not shift heading boundaries.
  const normalised = changelogText.replace(/\r\n/g, '\n');
  const start = findHeadingStart(normalised, `## v${version} (`);
  if (start === -1) return null;
  // Any `## ` heading ends the section: the real CHANGELOG.md has a hand-written `## Unreleased` between versions.
  const rest = normalised.slice(start + 1);
  const nextHeadingMatch = /\n## /.exec(rest);
  const end = nextHeadingMatch ? start + 1 + nextHeadingMatch.index : normalised.length;
  return normalised.slice(start, end).replace(/\n+$/, '\n');
}
