import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { formatDuration } from './toolStatus'
import { diffStat } from '@/lib/diff'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// #806: split out of `ToolRow.tsx` (gate round 2, Main) once that file grew past the 600-line
// cap -- the meta-slot/edit-stat builders below have no dependency on `ToolRow.tsx`'s own JSX
// tree, only on shared types and `toolStatus.tsx`/`lib/diff.ts`, so they move cleanly.

// #632: a row's meta slot can now carry more than one fact (a derived result alongside the
// duration, or a group's failed/interrupted counts alongside its total time) -- joined with a
// visible middot (`aria-hidden`, decorative) plus an sr-only ", " so a screen reader hears each
// as its own word, never one run-on string (the exact grammar #570 decision 12 established for
// "N failed"/"N interrupted"; this is that same rule, generalised to every meta slot rather than
// copied by hand at each call site). `undefined` when every part is `undefined`, never an empty
// wrapper `CollapsedLine` would still render a bare leading separator for.
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

// Gate round 1 (code-reviewer High, H2): `diffStat` re-diffs on every render of every `edit`
// row; memoised in a `WeakMap` keyed on `item.edit` (stable for that `TranscriptItem`'s life --
// a genuinely new result gets a new `edit` object, never a stale cache hit).
const diffStatCache = new WeakMap<NonNullable<ToolItem['edit']>, { added: number; removed: number } | undefined>()
function cachedDiffStat(edit: NonNullable<ToolItem['edit']>): { added: number; removed: number } | undefined {
  if (diffStatCache.has(edit)) return diffStatCache.get(edit)
  const stat = diffStat(edit.path, edit.oldText, edit.newText)
  diffStatCache.set(edit, stat)
  return stat
}

// #632 section 3's "muted result" column, for one call's own row (solo or nested `ToolCallRow`):
// an `edit` call's own "+N -M" line stat (`diffStat`, grounded in the same old/new text
// `DiffView`'s expanded body already diffs, #630) joined with duration. `grep`/`glob`/`find`/
// `read`/`write` get no stat: no documented, fixture-backed OMP output shape to probe first
// (the issue's own rule is "no count rather than a wrong one"). Gated on `status === 'done'`
// (Sec Medium H3), same as `ToolCallBody`'s own "Wrote N lines" text.
export function editStatForItem(item: ToolItem): { added: number; removed: number } | undefined {
  return item.status === 'done' && item.edit ? cachedDiffStat(item.edit) : undefined
}
// Gate round 1 (Main, D2): the sr-only "N lines added, M removed" text used to carry inline but
// was never announced -- an explicit `aria-label` (both `ToolCallRow`'s and the solo
// `ToolGroupRow`'s own trigger) makes a browser ignore every child. Callers fold this into their
// own aria-label array; the visual "+N -M" here stays `aria-hidden`.
export function diffStatAriaText(stat: { added: number; removed: number } | undefined): string | undefined {
  if (!stat) return undefined
  return `${stat.added} ${stat.added === 1 ? 'line' : 'lines'} added, ${stat.removed} ${stat.removed === 1 ? 'line' : 'lines'} removed`
}
// Gate round 1 (ui-architect-v3 High H5): a coloured stat broke #570 decisions 1/3 ("success
// stays neutral") -- both colour classes dropped, `tabular-nums` kept.
export function callMeta(item: ToolItem): React.ReactNode | undefined {
  const stat = editStatForItem(item)
  const duration = item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined
  return joinMetaParts([
    stat ? (
      <span aria-hidden="true" className="tabular-nums">
        {/* Gate round 2 (Low, Main): ASCII "-", not the Unicode minus sign (U+2212) this used
         * to draw -- #925's own shared `DiffStatCounts` settled on the ASCII glyph everywhere a
         * change count shows (`sessionDisplay.tsx`'s own header comment), and this tool-row
         * stat is the one remaining change count that still drew the Unicode one. */}
        +{stat.added} -{stat.removed}
      </span>
    ) : undefined,
    duration
  ])
}
