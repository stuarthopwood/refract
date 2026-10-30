// jsdiff output starts with an `Index:` header gitdiff-parser cannot read, so wrap it in a `diff --git` header.
import { createTwoFilesPatch } from 'diff'
import { type FileData, isDelete, isInsert, parseDiff } from 'react-diff-view'

const MAX_EDIT_LENGTH = 100_000

export function buildUnifiedDiff(path: string, oldText: string, newText: string): string | undefined {
  const safePath = path.replace(/[\r\n]/g, '')
  const isAdd = oldText === ''
  const oldName = isAdd ? '/dev/null' : `a/${safePath}`
  const newName = `b/${safePath}`
  const patch = createTwoFilesPatch(oldName, newName, oldText, newText, '', '', { context: 3, maxEditLength: MAX_EDIT_LENGTH })
  if (patch === undefined) return undefined

  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('--- '))
  if (start === -1) return ''
  const body = lines.slice(start).join('\n')
  const header = `diff --git a/${safePath} b/${safePath}\n${isAdd ? 'new file mode 100644\n' : ''}`
  return header + body + (body.endsWith('\n') ? '' : '\n')
}

// Shared so `DiffView` and the row's "+N -M" stat never disagree (#632).
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

export function diffStat(path: string, oldText: string, newText: string): { added: number; removed: number } | undefined {
  const patch = buildUnifiedDiff(path, oldText, newText)
  const parsed = patch ? parseDiff(patch)[0] : undefined
  if (!parsed || parsed.hunks.length === 0) return undefined
  return countChanges(parsed)
}

