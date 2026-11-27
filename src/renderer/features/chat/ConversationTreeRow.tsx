import { useId, useRef, useState } from 'react'
import { CheckIcon, TagIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/IconButton'
import { InlineStatus } from '@/components/InlineStatus'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ConversationTreeEntry } from '../../../shared/model'
import { MAX_TREE_INDENT, roleLabel } from './conversationTree'

export interface ConversationTreeRowProps {
  entry: ConversationTreeEntry
  depth: number
  /** The entry the Conversation currently ends at. */
  isLeaf: boolean
  /** Rewind and Fork are refused while the agent works; `reasonId` names the text that says why. */
  actionsDisabled: boolean
  reasonId: string
  /** The failure of this row's Rewind or Fork, shown on the action itself. */
  actionError: string | null
  onRewind(entry: ConversationTreeEntry): void
  onFork(entry: ConversationTreeEntry): void
  /** Resolves to the failure text, or null when the label saved. */
  onLabel(entry: ConversationTreeEntry, label: string): Promise<string | null>
}

export function ConversationTreeRow({ entry, depth, isLeaf, actionsDisabled, reasonId, actionError, onRewind, onFork, onLabel }: ConversationTreeRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [labelError, setLabelError] = useState<string | null>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const errorId = useId()
  const who = roleLabel(entry.role)
  const preview = entry.text || `(${who} message without text)`
  const when = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : null

  function startEditing() {
    setDraft(entry.label ?? '')
    setLabelError(null)
    setEditing(true)
  }

  function stopEditing() {
    setEditing(false)
    setLabelError(null)
    // The edit button is replaced while editing, so focus would otherwise fall to the page.
    queueMicrotask(() => editButtonRef.current?.focus())
  }

  async function save() {
    if (saving) return
    setSaving(true)
    const failure = await onLabel(entry, draft)
    setSaving(false)
    if (failure) setLabelError(failure)
    else stopEditing()
  }

  function guarded(action: (entry: ConversationTreeEntry) => void) {
    return () => {
      if (!actionsDisabled) action(entry)
    }
  }

  return (
    <li data-slot="conversation-tree-row" data-entry-id={entry.id} aria-current={isLeaf ? 'true' : undefined} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5" style={{ marginLeft: `${Math.min(depth, MAX_TREE_INDENT) * 0.75}rem` }}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{who}</span>
        {when && <span>{when}</span>}
        {isLeaf && <Badge variant="secondary">Current</Badge>}
        {entry.label && !editing && <Badge variant="outline">{entry.label}</Badge>}
      </div>
      <p className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{preview}</p>
      {editing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Input
            autoFocus
            value={draft}
            aria-label={`Label for ${who} message: ${preview.slice(0, 40)}`}
            aria-describedby={labelError ? errorId : undefined}
            aria-invalid={labelError ? true : undefined}
            placeholder="Label (empty removes it)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              // The Escape that cancels an edit must not also close the dialog.
              event.stopPropagation()
              stopEditing()
            }}
          />
          <IconButton label="Save label" type="submit" aria-disabled={saving} className="aria-disabled:opacity-50">
            <CheckIcon />
          </IconButton>
          <IconButton label="Cancel label edit" onClick={stopEditing}>
            <XIcon />
          </IconButton>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            aria-disabled={actionsDisabled}
            aria-describedby={actionsDisabled ? reasonId : actionError ? errorId : undefined}
            aria-label={`Rewind to here: ${preview.slice(0, 40)}`}
            className={cn(actionsDisabled && 'opacity-50')}
            onClick={guarded(onRewind)}
          >
            Rewind to here
          </Button>
          <Button
            variant="outline"
            size="xs"
            aria-disabled={actionsDisabled}
            aria-describedby={actionsDisabled ? reasonId : actionError ? errorId : undefined}
            aria-label={`Fork from here: ${preview.slice(0, 40)}`}
            className={cn(actionsDisabled && 'opacity-50')}
            onClick={guarded(onFork)}
          >
            Fork from here
          </Button>
          <IconButton ref={editButtonRef} label={entry.label ? 'Edit label' : 'Add label'} onClick={startEditing}>
            <TagIcon />
          </IconButton>
        </div>
      )}
      {(labelError ?? actionError) && (
        <InlineStatus tone="error" density="compact" id={errorId} className="p-0">
          {labelError ?? actionError}
        </InlineStatus>
      )}
    </li>
  )
}
