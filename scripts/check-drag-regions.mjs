#!/usr/bin/env node
// Static text heuristic (not an AST parser, like check-ui-text.mjs) for the Electron drag-region bug class (#500): an interactive child with no `no-drag-region`
// override under `App.tsx`'s full-width drag strip or a `drag-region` class. False positives are resolved with an inline `// drag-regions-allow: <reason>` marker.
// Usage: node scripts/check-drag-regions.mjs [rootDir] (default: <repoRoot>/src/renderer). Exits
// 1 if any unallowed violation is found, 2 if no .tsx files were scanned, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeRegExp } from './check-drag-regions-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const root = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, 'src', 'renderer'));

// Header-shaped row: `border-b` alone (any height) is the shared signal, since the unfixed #500 shape had no fixed height.
// Content-area rows below their own screen's drag banner (Settings/ManageSessions) or in a portaled Sheet look the same but are safe; no single-file scan can tell,
// so they carry an inline `// drag-regions-allow: <reason>` instead of a narrower rule that would hide a real future instance.
const TOKEN = (word) => new RegExp('(?:^|[\\s"\'`])' + word + '(?=[\\s"\'`]|$)');
const BORDER_B = TOKEN('border-b');
// #606 removed `border-b` from headers, so also match `h-10` + `shrink-0` together: every real header row pairs them,
// while `h-10` alone false-positives on interior controls (e.g. `ProfileItem.tsx`'s name button).
const SHRINK_0 = TOKEN('shrink-0');
const H_10 = TOKEN('h-10');
const isHeaderShapedByHeight = (text) => H_10.test(text) && SHRINK_0.test(text);
const DECLARES_REGION = (classNameText) => classNameText.includes('drag-region');
const DECLARES_NO_DRAG = (classNameText) => classNameText.includes('no-drag-region');

// Interactive openers this codebase uses beyond `button`: `a`, `TabsTrigger`, `ToggleGroupItem`, `Switch`, `PopoverTrigger`, `textarea`, `select`, `Checkbox`, `RadioGroupItem`.
const INTERACTIVE_OPENER = /<(Button|button|SelectTrigger|DropdownMenuTrigger|input|a|TabsTrigger|ToggleGroupItem|Switch|PopoverTrigger|textarea|select|Checkbox|RadioGroupItem)\b/g;

// Inline marker `// drag-regions-allow: <reason>` on the line before an opening tag suppresses its whole subtree; a `file:line` key breaks on any edit above it.
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

// End of the tag starting at `lines[startIdx][startCol]`: the first `>` not part of `=>` (an arrow prop before `className` would cut the tag off). Capped to avoid runaway scans.
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
  const stack = []; // { indent, region: 'drag' | 'no-drag' | null, headerShaped: boolean, allowed: boolean }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const closeMatch = CLOSE_TAG.exec(line);
    if (closeMatch) {
      const indent = closeMatch[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    }

    let closedThisLine = false;
    const openMatch = OPEN_TAG.exec(line);
    if (openMatch) {
      const indent = openMatch[1].length;
      const { text, selfClosing } = gatherTag(lines, i, 0);
      const noDrag = DECLARES_NO_DRAG(text);
      const region = noDrag ? 'no-drag' : DECLARES_REGION(text) ? 'drag' : null;
      const headerShaped = BORDER_B.test(text) || isHeaderShapedByHeight(text);
      const allowed = ALLOW_MARKER.test(line) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]));
      // Always push (unless self-closing) and pop after the opener scan: a same-line child needs its parent's drag-region/header shape on the stack
      // (`<div className="drag-region h-10 shrink-0"><Button onClick={...}>Close</Button></div>`).
      const tagName = escapeRegExp(openMatch[2]);
      const rest = line.slice(openMatch[0].length);
      // Count opens vs closes of this tag name: a same-named child's `</div>` would otherwise drop the outer frame.
      const opens = (rest.match(new RegExp('<' + tagName + '(?=[\\s/>]|$)', 'g')) || []).length;
      const closes = (rest.match(new RegExp('</' + tagName + '\\s*>', 'g')) || []).length;
      closedThisLine = closes > opens;
      if (!selfClosing) stack.push({ indent, region, headerShaped, allowed });
      // Chrome band (#682): a visible drag row must paint the shared `titlebar-surface`; only the invisible `-z-10` hit-test strip in App.tsx is exempt.
      if (region === 'drag' && !allowed && !text.includes('titlebar-surface') && !text.includes('-z-10')) {
        console.log(relative + ':' + (i + 1) + ' drag-region element does not use the shared titlebar-surface class (Chrome band, #682)');
        violationCount++;
      }
    }

    // Runs on any line containing an interactive opener, so inline conditionals (`{open && <Button>}`) and one-line self-closing openers are checked.
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
          if (frame.headerShaped) covering = covering ?? 'undeclared-header-shaped';
          // keep scanning outward: a further-out explicit drag/no-drag still overrides.
        }
      }
      if ((covering === 'drag' || covering === 'undeclared-header-shaped') && !allowedByAncestor) {
        const lineNo = i + 1;
        const reason =
          covering === 'drag'
            ? 'interactive opener inside a drag-region element has no no-drag-region override'
            : 'interactive opener inside an undeclared header-shaped row (no drag-region/no-drag-region) -- the #500 shape';
        console.log(relative + ':' + lineNo + ' ' + reason);
        violationCount++;
      }
    }

    if (openMatch && closedThisLine) stack.pop();
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
