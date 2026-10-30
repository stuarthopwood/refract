import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { formatDuration } from './toolStatus'
import { diffStat } from '@/lib/diff'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

export function joinMetaParts(parts: Array<React.ReactNode | undefined>): React.ReactNode | undefined {
  const visible = parts.filter((part): part is React.ReactNode => part !== undefined)
  if (visible.length === 0) return undefined
  return (
    <>
      {visible.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
            </>
          )}
          {part}
        </React.Fragment>
      ))}
    </>
  )
}

const diffStatCache = new WeakMap<NonNullable<ToolItem['edit']>, { added: number; removed: number } | undefined>()
function cachedDiffStat(edit: NonNullable<ToolItem['edit']>): { added: number; removed: number } | undefined {
  if (diffStatCache.has(edit)) return diffStatCache.get(edit)
  const stat = diffStat(edit.path, edit.oldText, edit.newText)
  diffStatCache.set(edit, stat)
  return stat
}

export function editStatForItem(item: ToolItem): { added: number; removed: number } | undefined {
  return item.status === 'done' && item.edit ? cachedDiffStat(item.edit) : undefined
}
export function diffStatAriaText(stat: { added: number; removed: number } | undefined): string | undefined {
  if (!stat) return undefined
  return `${stat.added} ${stat.added === 1 ? 'line' : 'lines'} added, ${stat.removed} ${stat.removed === 1 ? 'line' : 'lines'} removed`
}
export function callMeta(item: ToolItem): React.ReactNode | undefined {
  const stat = editStatForItem(item)
  const duration = item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined
  return joinMetaParts([
    stat ? (
      <span aria-hidden="true" className="tabular-nums">
        +{stat.added} -{stat.removed}
      </span>
    ) : undefined,
    duration
  ])
}
