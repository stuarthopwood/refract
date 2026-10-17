// Builds a git-style unified diff string for one file, for react-diff-view's `parseDiff`
// (DiffView.tsx, T025). Plain `diff` package (jsdiff) output starts with an `Index:` header that
// gitdiff-parser (which `parseDiff` wraps) cannot read, so this wraps it in a minimal
// `diff --git a/<path> b/<path>` header instead. `oldText === ''` is treated as a new file
// (`--- /dev/null`) so `parseDiff` infers `type: 'add'` rather than `'modify'`.
import { createTwoFilesPatch } from 'diff'
import { type FileData, isDelete, isInsert, parseDiff } from 'react-diff-view'

// Gate round 1 (code-reviewer High, H2): diffing a large, very different old/new pair is
// unbounded computational cost run synchronously on every render of every `edit` tool-call row
// (`ToolRow.tsx`'s `callMeta`) -- capped here so the algorithm gives up and `createTwoFilesPatch`
// returns `undefined` (the `CreatePatchOptionsAbortable` overload) rather than ever blocking the
// render on a pathological input; `buildUnifiedDiff` then returns `''`, its own existing
// "no diff" value every caller already handles.
const MAX_EDIT_LENGTH = 100_000

export function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  // Security remediation (Low, PR #597): a crafted file path with embedded CR/LF could
  // otherwise inject extra header lines into the diff text this function returns, which is
  // both parsed for display (DiffView.tsx) and put on the clipboard verbatim by its Copy button.
  const safePath = path.replace(/[\r\n]/g, '')
  const isAdd = oldText === ''
  const oldName = isAdd ? '/dev/null' : `a/${safePath}`
  const newName = `b/${safePath}`
  const patch = createTwoFilesPatch(oldName, newName, oldText, newText, '', '', { context: 3, maxEditLength: MAX_EDIT_LENGTH })
  if (!patch) return ''

  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('--- '))
  if (start === -1) return ''
  const body = lines.slice(start).join('\n')
  const header = `diff --git a/${safePath} b/${safePath}\n${isAdd ? 'new file mode 100644\n' : ''}`
  return header + body + (body.endsWith('\n') ? '' : '\n')
}

// Gate round 1 (code-reviewer High, H2): the added/removed line count used to be hand-rolled
// twice -- once here, once in `DiffView.tsx`'s own `stats` -- which could disagree the moment
// either copy drifted. One function, shared by both: `DiffView`'s expanded body and the row's
// own "+N −M" stat (#632) can never show a different count for the identical diff again.
export function countChanges(file: Pick<FileData, 'hunks'>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (isInsert(change)) added++
      else if (isDelete(change)) removed++
    }
  }
  return { added, removed }
}

// #632: the "+N −M" one-line stat a collapsed/expanded `edit` call shows in its own row (never
// a wrong count: `undefined` when the two texts parse to no hunks at all, e.g. an unreadable or
// identical pair, or when `buildUnifiedDiff` gave up above) -- shares `buildUnifiedDiff`/
// `parseDiff`/`countChanges` with `DiffView.tsx`'s own expanded diff body instead of a second
// hand-rolled line-count, so the row's stat and the dialog's own header stat (#630) can never
// disagree.
export function diffStat(path: string, oldText: string, newText: string): { added: number; removed: number } | undefined {
  const patch = buildUnifiedDiff(path, oldText, newText)
  const parsed = patch ? parseDiff(patch)[0] : undefined
  if (!parsed || parsed.hunks.length === 0) return undefined
  return countChanges(parsed)
}

