// A Project group's Sessions drawn as a tree (#1862). Only used when at least one Session in the group
// has a listed parent; a group with none keeps its flat `<ul>` markup.
import { useMemo } from 'react'
import { useSessionListStore, useSessionsStore, useSplitStore } from '@/state'
import type { Repository } from '../../../shared/model'
import { SessionRow } from './SessionRow'
import { treeGroupId } from './SessionRowTree'
import { fromLabel, subtreeContains, type SessionTreeNode } from './sessionTree'
import type { SessionSummary } from '../../../shared/ipc'

function SessionTreeItem({ node, repository, sessionsById }: { node: SessionTreeNode; repository: Repository; sessionsById: ReadonlyMap<string, SessionSummary> }) {
  const { session } = node
  const hasChildren = node.children.length > 0
  const open = useSessionListStore((state) => state.isParentOpen(session.id))
  // A derived boolean, so a pane change re-renders only the parents that actually contain the pane's Session.
  const selectedBelow = useSplitStore(
    (state) => hasChildren && !open && state.paneSessionIds.some((id) => node.children.some((child) => subtreeContains(child, id)))
  )
  return (
    <SessionRow session={session} repository={repository} tree={{ node, from: fromLabel(session, sessionsById), open, selectedBelow }}>
      {hasChildren && open && (
        <ul role="group" id={treeGroupId(session.id)} className="flex flex-col gap-0">
          {node.children.map((child) => (
            <SessionTreeItem key={child.session.id} node={child} repository={repository} sessionsById={sessionsById} />
          ))}
        </ul>
      )}
    </SessionRow>
  )
}

export function SessionTreeList({ nodes, repository, label }: { nodes: readonly SessionTreeNode[]; repository: Repository; label: string }) {
  const sessions = useSessionsStore((state) => state.sessions)
  // The unfiltered store list, so a child whose parent is archived, hidden or filtered out still names it.
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  return (
    <ul role="tree" aria-label={label} className="flex flex-col gap-0 py-1">
      {nodes.map((node) => (
        <SessionTreeItem key={node.session.id} node={node} repository={repository} sessionsById={sessionsById} />
      ))}
    </ul>
  )
}
