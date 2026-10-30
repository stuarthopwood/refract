import * as React from 'react'
import { extractTaskGoalPreview } from './stageMeta'

/** The task's goal preview, clamped to 3 lines; plain text only because `task` is untrusted agent text (#1077). */
export function SubagentGoalPreview({ task }: { task: string }) {
  const goalPreview = React.useMemo(() => extractTaskGoalPreview(task), [task])
  if (goalPreview == null) return null
  return <p className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{goalPreview}</p>
}
