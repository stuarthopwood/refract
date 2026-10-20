import * as React from 'react'
import { extractTaskGoalPreview } from './stageMeta'

/** Issue #1077: the goal paragraph alone -- `task`'s own first lines, clamped to 3 visible
 * lines, the untruncated task reachable via the owning row's own "See input & output" toggle.
 * Its own file (gate round 1 fix, item 7/file-size): `ToolRow.tsx`'s `SubagentBody` uses it for
 * a Stage member's own goal; `SubagentChainRow.tsx`'s `StageGroupRow` uses it directly, at the
 * Stage level, for a context-less solo Stage's own goal, ordered before its own "Uses:" line
 * rather than nested inside `SubagentBody`. Plain text only: `task` is untrusted agent-authored
 * text, never rendered as Markdown here. */
export function SubagentGoalPreview({ task }: { task: string }) {
  const goalPreview = React.useMemo(() => extractTaskGoalPreview(task), [task])
  if (goalPreview == null) return null
  return <p className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{goalPreview}</p>
}
