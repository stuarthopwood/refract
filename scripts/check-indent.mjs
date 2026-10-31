#!/usr/bin/env node
// Guard for #387: the codebase is 2-space indented, so an odd indent flags the edit tool's
// silent reformatting bug. Parity only; `--check-nesting` adds a noisy heuristic, off by default.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2).filter((a) => a !== '--check-nesting');
const checkNesting = process.argv.includes('--check-nesting');
const root = path.resolve(process.cwd(), args[0] ?? repoRoot);
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git']);

// Known pre-existing odd-indent damage; allowed so new instances still fail. Remove when fixed (#593).
const ALLOWED_FILES = new Set([
  'src/renderer/state/theme-store.ts',
  'src/renderer/lib/use-cleared-announcement.ts'
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Heuristic: not string/regex-aware, so brackets in template literals are miscounted; expect noise.
export function findNestingInversions(lines) {
  const violations = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const stripped = line.replace(/^ +/, '');
    const indent = line.length - stripped.length;
    const codePart = stripped.replace(/\/\/.*$/, '');
    if (stack.length > 0 && indent < stack[stack.length - 1]) {
      violations.push({ lineNo: i + 1, indent, openerIndent: stack[stack.length - 1], text: stripped.slice(0, 80) });
    }
    let opens = 0;
    let closes = 0;
    for (const ch of codePart) {
      if (ch === '{' || ch === '(' || ch === '[') opens++;
      else if (ch === '}' || ch === ')' || ch === ']') closes++;
    }
    const net = opens - closes;
    if (net < 0) {
      const popCount = Math.min(-net, stack.length);
      stack.splice(stack.length - popCount, popCount);
    } else if (net > 0) {
      for (let k = 0; k < net; k++) stack.push(indent);
    }
  }
  return violations;
}

// JSDoc continuation lines (` * text`, `*/`) are legitimately odd-indented and excluded.
export function findOddIndentLines(lines) {
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const stripped = line.replace(/^ +/, '');
    const indent = line.length - stripped.length;
    if (indent === 0) continue;
    if (stripped.startsWith('*')) continue; // JSDoc ` * text` continuation or a bare `*/` close
    if (indent % 2 === 1) bad.push({ lineNo: i + 1, indent, text: stripped.slice(0, 80) });
  }
  return bad;
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let fileCount = 0;
  let damagedFileCount = 0;
  let lineCount = 0;
  let nestingFileCount = 0;
  let nestingLineCount = 0;

  for (const file of isDirectory(root) ? walk(root) : []) {
    fileCount++;
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');

    const content = readFileSync(file, 'utf-8');
    const lines = content.split(/\r\n|\n/);

    if (!ALLOWED_FILES.has(relative)) {
      const bad = findOddIndentLines(lines);

      if (bad.length > 0) {
        damagedFileCount++;
        lineCount += bad.length;
        console.log(`${relative}: ${bad.length} odd-indent line${bad.length === 1 ? '' : 's'}`);
        for (const { lineNo, indent, text } of bad.slice(0, 5)) {
          console.log(`  ${relative}:${lineNo} (indent ${indent}) ${text}`);
        }
        if (bad.length > 5) console.log(`  ... and ${bad.length - 5} more`);
      }
    }

    if (checkNesting) {
      const nestingBad = findNestingInversions(lines);
      if (nestingBad.length > 0) {
        nestingFileCount++;
        nestingLineCount += nestingBad.length;
        console.log(`${relative}: ${nestingBad.length} possible nesting inversion${nestingBad.length === 1 ? '' : 's'} (heuristic, review manually)`);
        for (const { lineNo, indent, openerIndent, text } of nestingBad.slice(0, 5)) {
          console.log(`  ${relative}:${lineNo} (indent ${indent} < opener indent ${openerIndent}) ${text}`);
        }
        if (nestingBad.length > 5) console.log(`  ... and ${nestingBad.length - 5} more`);
      }
    }
  }

  if (fileCount === 0) {
    console.log(`no matching .ts/.tsx/.js/.mjs files found under ${root}`);
    process.exit(2);
  } else if (damagedFileCount > 0) {
    console.log(`${lineCount} odd-indent line${lineCount === 1 ? '' : 's'} across ${damagedFileCount} file${damagedFileCount === 1 ? '' : 's'} (${fileCount} scanned, ${ALLOWED_FILES.size} allow-listed)`);
    process.exit(1);
  } else {
    if (checkNesting && nestingFileCount > 0) {
      console.log(`0 odd-indent lines across ${fileCount} files scanned (${ALLOWED_FILES.size} allow-listed); ${nestingLineCount} possible nesting inversion${nestingLineCount === 1 ? '' : 's'} across ${nestingFileCount} file${nestingFileCount === 1 ? '' : 's'} (heuristic, not a failure -- review manually)`);
    } else {
      console.log(`0 odd-indent lines across ${fileCount} files scanned (${ALLOWED_FILES.size} allow-listed)`);
    }
    process.exit(0);
  }
}

