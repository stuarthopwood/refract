#!/usr/bin/env node
// Fails when the renderer's list of Refract-written line prefixes (src/shared/contextLines.ts, #2320) and the
// Rust that writes them disagree: a prefix the Rust no longer writes, or a bracketed label the Rust writes
// that the renderer would show as the user's own text.
// Usage: node scripts/check-context-prefixes.mjs
// Exit: 1 on drift, 0 otherwise.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listSource = readFileSync(path.join(repoRoot, 'src/shared/contextLines.ts'), 'utf8');
const listed = [...listSource.matchAll(/prefix: '(\[[^\]']+\]) '/g)].map((m) => m[1]);

function* rustFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* rustFiles(full);
    else if (entry.name.endsWith('.rs') && !entry.name.endsWith('.test.rs')) yield full;
  }
}

// A string literal that opens with a capitalised bracketed label and a space, such as "[Refract] {line}".
const LABELLED_LITERAL = /"(\[[A-Z][^\]"\\]*\]) /g;
const written = new Map();
for (const file of rustFiles(path.join(repoRoot, 'src-tauri/src'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(LABELLED_LITERAL)) {
    written.set(match[1], path.relative(repoRoot, file));
  }
}

const problems = [];
if (listed.length === 0) problems.push('no prefixes found in src/shared/contextLines.ts');
for (const [label, file] of written) {
  if (!listed.includes(label)) problems.push(`${file} writes "${label} ..." but src/shared/contextLines.ts does not list it`);
}
for (const label of listed) {
  if (!written.has(label)) problems.push(`src/shared/contextLines.ts lists ${label} but no Rust under src-tauri/src writes it`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-context-prefixes: ${problem}`);
  process.exit(1);
}
console.log(`check-context-prefixes: ${listed.length} prefixes match the Rust.`);
