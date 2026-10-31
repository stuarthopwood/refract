import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { FolderGit2Icon, GitBranchIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state'
import type { BranchEntry } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { parseItemRef } from './githubItemRef'
import type { ItemRef } from './startSessionFromItem'
import { requestSessionFromItem } from './startSessionRequest'

export interface NewSessionDialogProps {
  repository: Repository
  /** The element (usually a Button) that opens the dialog. Omit it when the caller controls open. */
  trigger?: ReactNode
  /** Controlled open state, for a caller that opens the dialog from elsewhere (Home's Project picker menu). */
  open?: boolean
  onOpenChange?(open: boolean): void
  /** Opens in issue or pull request mode (the palette items): a number or link is required and there is no Base branch. */
  presetKind?: ItemRef['kind']
}

// New session creation from the Base branch picker (docs/DESIGN.md "Layout", CONTEXT.md "Base
// branch"): preselects the repository's default branch, then hands off to the sessions store's
// `create`, which also selects and opens the new Session. Refract generates the Session's name
// and branch; this dialog never asks for them.
export function NewSessionDialog({ repository, trigger, open: controlledOpen, onOpenChange, presetKind }: NewSessionDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean): void => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [entries, setEntries] = useState<BranchEntry[] | null>(null)
  const [baseBranch, setBaseBranch] = useState(repository.defaultBranch)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [itemText, setItemText] = useState('')
  const parsedItem = itemText.trim() ? parseItemRef(itemText, repository, presetKind) : null
  const itemRef = parsedItem?.ok ? parsedItem.ref : null
  const itemMode = presetKind !== undefined || itemText.trim() !== ''
  // Issue #620, UX consult item 2 decision 6: the same per-repository in-flight guard the
  // header "+" and the row's "New session from {branch}" menu item share -- `create()` itself
  // enforces it (so a submit here while one of those is already running is refused, not a
  // silent second worktree), but the Create button also reads it directly so it reads
  // "Creating…" and is disabled for that case too, not just this dialog's own `submitting`.
  const creatingRepository = useSessionsStore((state) => state.creatingRepositoryIds.has(repository.id))

  useEffect(() => {
    if (!open || presetKind) return
    setError(null)
    setLoadingBranches(true)
    let cancelled = false
    void (async () => {
      const result = await window.refract.repositories.branches(repository.id)
      if (cancelled) return
      if (result.ok) {
        setEntries(result.value)
        setBaseBranch(result.value.find((entry) => entry.kind === 'default')?.name ?? repository.defaultBranch)
      } else {
        setEntries(null)
        setError(result.error.message)
      }
      setLoadingBranches(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, repository.id, presetKind])

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setError(null)
      setItemText('')
      setBaseBranch(repository.defaultBranch)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (itemMode && !itemRef) return
    if (itemRef) {
      handleOpenChange(false)
      await requestSessionFromItem(itemRef)
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await useSessionsStore.getState().create(repository.id, baseBranch)
    setSubmitting(false)
    if (result.ok) {
      handleOpenChange(false)
    } else {
      setError(result.error.message)
    }
  }

  const options: BranchEntry[] = entries ?? [{ name: repository.defaultBranch, kind: 'default' }]
  const branchOptions = options.filter((entry) => entry.kind !== 'session')
  const sessionOptions = options.filter((entry) => entry.kind === 'session')

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{presetKind === 'issue' ? 'New session from an issue' : presetKind === 'pull-request' ? 'New session from a pull request' : 'New session'} in {repository.name}</DialogTitle>
          <DialogDescription>Refract names the Session and its branch automatically.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {!itemMode && (
          <div className="flex flex-col gap-2">
            <label htmlFor="base-branch" className="text-sm">
              Base branch
            </label>
            <Select value={baseBranch} onValueChange={setBaseBranch} disabled={loadingBranches}>
              <SelectTrigger id="base-branch" className="w-full">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent side="bottom" sideOffset={4}>
                <SelectGroup>
                  <SelectLabel className="flex items-center gap-2">
                    <GitBranchIcon aria-hidden className="size-4" />
                    Branches
                  </SelectLabel>
                  {branchOptions.map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {sessionOptions.length > 0 && (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel className="flex items-center gap-2">
                        <FolderGit2Icon aria-hidden className="size-4" />
                        Sessions
                      </SelectLabel>
                      {sessionOptions.map((entry) => (
                        <SelectItem key={entry.name} value={entry.name} textValue={entry.sessionName}>
                          <span className="min-w-0 truncate">{entry.sessionName}</span>
                          <span className="text-xs text-muted-foreground">{entry.name}</span>
                          {entry.archived && <Badge variant="secondary">Archived</Badge>}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="session-item" className="text-sm">
              {presetKind === 'issue' ? 'Issue number or link' : presetKind === 'pull-request' ? 'Pull request number or link' : 'Issue or pull request link (optional)'}
            </label>
            <Input id="session-item" value={itemText} onChange={(event) => setItemText(event.target.value)} aria-describedby="session-item-error" aria-invalid={parsedItem?.ok === false} placeholder="https://github.com/owner/repo/issues/123" />
            <p id="session-item-error" role="alert" className={cn('text-sm text-destructive', !(parsedItem && !parsedItem.ok) && 'sr-only')}>
              {parsedItem && !parsedItem.ok ? parsedItem.message : ''}
            </p>
          </div>
          <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
            {error ?? ''}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || (itemMode ? !itemRef : loadingBranches) || creatingRepository}>
              {submitting || creatingRepository ? 'Creating…' : itemMode ? 'Start session' : 'Create session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
