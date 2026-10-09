#!/usr/bin/env node
// Static heuristic guard for the Electron drag-region bug class (issue #500): a JSX element
// sitting where `App.tsx`'s permanent full-width drag strip (or an explicit `drag-region` class)
// would swallow clicks, with an interactive child that has no `no-drag-region` override. This is
// a TEXT heuristic over the source (not a real JSX/AST parser, matching check-ui-text.mjs's own
// approach), so false positives/negatives are expected and resolved via an inline
// `// drag-regions-allow: <reason>` marker comment rather than by loosening the rules below.
// Usage: node scripts/check-drag-regions.mjs [rootDir] (default: <repoRoot>/src/renderer). Exits
// 1 if any unallowed violation is found, 2 if no .tsx files were scanned, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const root = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, 'src', 'renderer'));

// Quality-gate remediation (cycle 2, Medium, both code-reviewer and test-reviewer): the original
// rule required `h-10` together with `border-b`, which matches every header AFTER it has already
// been fixed to follow that convention, but misses the original, unfixed shape of #500 itself (a
// `border-b` row with no fixed height at all) -- confirmed with a fixture copy of `origin/main`'s
// pre-fix `PullRequestsView.tsx`. `border-b` alone (any height) is the real shared signal a
// header-shaped row has; `h-10` is just one specific height convention, not the thing that
// actually matters for this bug class. Dropped in favour of requiring an interactive descendant
// instead (below), which is what the test-reviewer's fixtures proved was missing.
//
// This does flag some content-area rows that merely LOOK like a window-chrome header (same
// `border-b` + interactive-children shape) but are actually safe, because they render below
// their OWN screen's drag-region banner (SettingsScreen/ManageSessionsScreen's pattern) or inside
// a portaled overlay (Sheet) -- a fact no single-file text scan can see, since it depends on
// where a *different* component mounts this one. Those are marked with an inline
// `// drag-regions-allow: <reason>` comment rather than narrowing the rule, since narrowing it
// enough to exclude them would also hide a real future instance of this same shape.
const TOKEN = (word) => new RegExp('(?:^|[\\s"\'`])' + word + '(?=[\\s"\'`]|$)');
const BORDER_B = TOKEN('border-b');
const DECLARES_REGION = (classNameText) => classNameText.includes('drag-region');
const DECLARES_NO_DRAG = (classNameText) => classNameText.includes('no-drag-region');

// Quality-gate remediation (cycle 2, Medium, test-reviewer fixtures): extended past the original
// four tags -- `a`, `TabsTrigger`, `ToggleGroupItem`, `Switch`, `PopoverTrigger`, `textarea`,
// `select`, `Checkbox` and `RadioGroupItem` are all real interactive openers this codebase uses
// that the original list missed.
const INTERACTIVE_OPENER = /<(Button|button|SelectTrigger|DropdownMenuTrigger|input|a|TabsTrigger|ToggleGroupItem|Switch|PopoverTrigger|textarea|select|Checkbox|RadioGroupItem)\b/g;

// Inline marker: `// drag-regions-allow: <reason>` on the line immediately before an element's
// opening tag suppresses every violation found anywhere inside that element's subtree -- stable
// across refactors, unlike a `file:line` key (which silently stops matching the moment anything
// above the flagged line changes) or a per-violation-line key (noisy for a container with many
// interactive children).
const ALLOW_MARKER = /drag-regions-allow:/;

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
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
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

// Finds the END of the tag whose `<Name` starts at `lines[startIdx][startCol]`: the first `>`
// that is not part of `=>` (an arrow-function prop value -- the false positive/negative cycle 2
// found: a multi-line tag with `onClick={() => ...}` before its `className` was cut off at the
// arrow's `>`, hiding the real className from every check below). Capped to avoid runaway scans.
function gatherTag(lines, startIdx, startCol) {
  let text = '';
  const cap = Math.min(lines.length, startIdx + 20);
  for (let i = startIdx; i < cap; i++) {
    const line = i === startIdx ? lines[i].slice(startCol) : lines[i];
    text += line + '\n';
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '>' && line[j - 1] !== '=') {
        const selfClosing = line.slice(0, j).trimEnd().endsWith('/');
        return { text, selfClosing };
      }
    }
  }
  return { text, selfClosing: false };
}

const OPEN_TAG = /^(\s*)<([A-Za-z][\w.]*)\b/;
const CLOSE_TAG = /^(\s*)<\/[A-Za-z]/;

let violationCount = 0;
let fileCount = 0;

for (const file of isDirectory(root) ? walk(root) : []) {
  fileCount++;
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const content = readFileSync(file, 'utf-8');
  const lines = content.split(/\r\n|\n/);
  const stack = []; // { indent, region: 'drag' | 'no-drag' | null, borderB: boolean, allowed: boolean }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const closeMatch = CLOSE_TAG.exec(line);
    if (closeMatch) {
      const indent = closeMatch[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    }

    const openMatch = OPEN_TAG.exec(line);
    if (openMatch) {
      const indent = openMatch[1].length;
      const { text, selfClosing } = gatherTag(lines, i, 0);
      const noDrag = DECLARES_NO_DRAG(text);
      const region = noDrag ? 'no-drag' : DECLARES_REGION(text) ? 'drag' : null;
      const borderB = BORDER_B.test(text);
      const allowed = ALLOW_MARKER.test(line) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]));
      if (!selfClosing) stack.push({ indent, region, borderB, allowed });
    }

    // Quality-gate remediation (cycle 2, Medium, test-reviewer fixtures): runs on every line that
    // contains an interactive opener ANYWHERE in its text -- not only a line that opens one at
    // the start (`openMatch`) -- so an inline conditional opener (`{open && <Button>...}`) or a
    // one-line self-closing opener (`<input ... />`) is checked too; both were previously
    // silently skipped.
    INTERACTIVE_OPENER.lastIndex = 0;
    let openerMatch;
    while ((openerMatch = INTERACTIVE_OPENER.exec(line))) {
      const startCol = openerMatch.index;
      const { text: ownText } = gatherTag(lines, i, startCol);
      const ownNoDrag = DECLARES_NO_DRAG(ownText);
      const ownAllowed = ALLOW_MARKER.test(line) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]));
      let covering = ownNoDrag ? 'no-drag' : null;
      let allowedByAncestor = ownAllowed;
      if (!covering) {
        for (let j = stack.length - 1; j >= 0; j--) {
          const frame = stack[j];
          if (frame.allowed) allowedByAncestor = true;
          if (frame.region === 'no-drag') {
            covering = 'no-drag';
            break;
          }
          if (frame.region === 'drag') {
            covering = 'drag';
            break;
          }
          if (frame.borderB) covering = covering ?? 'undeclared-border-b';
          // keep scanning outward: a further-out explicit drag/no-drag still overrides.
        }
      }
      if ((covering === 'drag' || covering === 'undeclared-border-b') && !allowedByAncestor) {
        const lineNo = i + 1;
        const reason =
          covering === 'drag'
            ? 'interactive opener inside a drag-region element has no no-drag-region override'
            : 'interactive opener inside an undeclared border-b row (no drag-region/no-drag-region) -- the #500 shape';
        console.log(relative + ':' + lineNo + ' ' + reason);
        violationCount++;
      }
    }
  }
}

if (fileCount === 0) {
  console.log('no .tsx files found under ' + root);
  process.exit(2);
} else if (violationCount > 0) {
  console.log(violationCount + ' drag-region violation' + (violationCount === 1 ? '' : 's') + ' found across ' + fileCount + ' file' + (fileCount === 1 ? '' : 's'));
  process.exit(1);
} else {
  console.log('0 drag-region violations found across ' + fileCount + ' file' + (fileCount === 1 ? '' : 's'));
  process.exit(0);
}
