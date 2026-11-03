import type { ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'
import { RowKebabMenu } from '@/components/RowKebabMenu'
import { requestSessionFromItem } from '@/features/sessions/startSessionRequest'
import type { ItemRef } from '@/features/sessions/startSessionFromItem'

/** A list row's "New session" action (kebab, right-click, Shift+F10) built on the shared `RowKebabMenu` (#1310). */
export function NewSessionRowMenu({ item, title, children }: { item: ItemRef; title: string; children: ReactNode }) {
  const noun = item.kind === 'issue' ? 'issue' : 'pull request'
  return (
    <RowKebabMenu
      label={`More actions for ${noun} #${item.number}: ${title}`}
      entries={[{ id: 'new-session', label: 'New session', icon: PlusIcon, onSelect: () => void requestSessionFromItem(item) }]}
    >
      {children}
    </RowKebabMenu>
  )
}