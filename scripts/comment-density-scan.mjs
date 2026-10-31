// Comment scanners and per-file line metrics for check-comment-density.mjs.
// Both scanners return comment character ranges; metrics are derived from the ranges alone.
// By design, a trailing `//` comment on a code line explains that line and never forms a comment block (#1499).

import ts from '@typescript/typescript6';

function scriptKindFor(ext) {
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

// Every comment is leading or same-line trailing trivia of some token (end-of-file included), so two lookups per token
// find them all; `{/* ... */}` and `code(); /* ...` are only found as trailing trivia. JSX text is skipped: `//` there is text.
export function scanTypeScriptComments(text, ext) {
  const sf = ts.createSourceFile('f' + ext, text, ts.ScriptTarget.Latest, false, scriptKindFor(ext));
  const ranges = [];
  const seen = new Set();
  const visit = (node) => {
    const children = node.getChildren(sf).filter((c) => !ts.isJSDoc(c));
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.JsxText) return;
      const found = [
        ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.getFullStart()) ?? [])
      ];
      for (const c of found) {
        if (!seen.has(c.pos)) {
          seen.add(c.pos);
          ranges.push([c.pos, c.end]);
        }
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return ranges.sort((a, b) => a[0] - b[0]);
}

const isIdent = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

function skipQuoted(text, i, quote) {
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

// Returns the index after a raw string starting at `i` (at the `r`), or -1 if `i` is not one.
function rawStringEnd(text, i) {
  const prev = text[i - 1];
  const prefixed = (prev === 'b' || prev === 'c') && !isIdent(text[i - 2]);
  if (isIdent(prev) && !prefixed) return -1;
  let j = i + 1;
  while (text[j] === '#') j++;
  if (text[j] !== '"') return -1;
  const close = '"' + '#'.repeat(j - i - 1);
  const end = text.indexOf(close, j + 1);
  return end === -1 ? text.length : end + close.length;
}

export function scanRustComments(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      ranges.push([i, j]);
      i = j;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      ranges.push([i, j]);
      i = j;
    } else if (ch === '"') {
      i = skipQuoted(text, i, '"');
    } else if (ch === 'r' && rawStringEnd(text, i) !== -1) {
      i = rawStringEnd(text, i);
    } else if (ch === "'") {
      // A char literal closes after one code point; anything else is a lifetime or label.
      if (next === '\\') i = skipQuoted(text, i, "'");
      else {
        const width = next !== undefined && next.codePointAt(0) > 0xffff ? 2 : 1;
        i = text[i + 1 + width] === "'" ? i + 2 + width : i + 1;
      }
    } else i++;
  }
  return ranges;
}

// A line is a comment line when it has content and every non-whitespace character is in a comment, or when its last
// content opens a comment that continues onto the next line (`code(); /* ...`), so such a block cannot dodge the cap.
export function measureLines(text, ranges) {
  const endOf = new Int32Array(text.length);
  for (const [a, b] of ranges) endOf.fill(b, a, b);
  let nonBlank = 0;
  let commentLines = 0;
  let maxBlock = 0;
  let block = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let content = false;
    let allComment = true;
    let last = -1;
    for (let k = start; k < end; k++) {
      const c = text.charCodeAt(k);
      if (c === 32 || c === 9 || c === 13) continue;
      content = true;
      last = k;
      if (!endOf[k]) allComment = false;
    }
    if (content) nonBlank++;
    if (content && (allComment || endOf[last] > end)) {
      commentLines++;
      block++;
      if (block > maxBlock) maxBlock = block;
    } else block = 0;
    start = end + 1;
  }
  return { nonBlank, commentLines, maxBlock };
}

export function measureFile(text, ext) {
  const ranges = ext === '.rs' ? scanRustComments(text) : scanTypeScriptComments(text, ext);
  return measureLines(text, ranges);
}
