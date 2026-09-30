// Builds a git-style unified diff string for one file, for react-diff-view's `parseDiff`
// (DiffView.tsx, T025). Plain `diff` package (jsdiff) output starts with an `Index:` header that
// gitdiff-parser (which `parseDiff` wraps) cannot read, so this wraps it in a minimal
// `diff --git a/<path> b/<path>` header instead. `oldText === ''` is treated as a new file
// (`--- /dev/null`) so `parseDiff` infers `type: 'add'` rather than `'modify'`.
import { createTwoFilesPatch } from 'diff'

export function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  const isAdd = oldText === ''
  const oldName = isAdd ? '/dev/null' : `a/${path}`
  const newName = `b/${path}`
  const patch = createTwoFilesPatch(oldName, newName, oldText, newText, '', '', { context: 3 })

  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('--- '))
  if (start === -1) return ''
  const body = lines.slice(start).join('\n')
  const header = `diff --git a/${path} b/${path}\n${isAdd ? 'new file mode 100644\n' : ''}`
  return header + body + (body.endsWith('\n') ? '' : '\n')
}
