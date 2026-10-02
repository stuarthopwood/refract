import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { FolderGit2Icon, GitBranchIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export interface NewSessionDialogProps {
  repository: Repository
  /** The element (usually a Button) that opens the dialog. */
  trigger: ReactNode
}

// New session creation from the Base branch picker (docs/DESIGN.md "Layout", CONTEXT.md "Base
// branch"): preselects the repository's default branch, then hands off to the sessions store's
// `create`, which also selects and opens the new Session. Refract generates the Session's name
// and branch; this dialog never asks for them.
export function NewSessionDialog({ repository, trigger }: NewSessionDialogProps) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<BranchEntry[] | null>(null)
  const [baseBranch, setBaseBranch] = useState(repository.defaultBranch)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
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
  }, [open, repository.id])

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setError(null)
      setBaseBranch(repository.defaultBranch)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session in {repository.name}</DialogTitle>
          <DialogDescription>Refract names the Session and its branch automatically.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="base-branch" className="text-sm font-medium">
              Base branch
            </label>
            <Select value={baseBranch} onValueChange={setBaseBranch} disabled={loadingBranches}>
              <SelectTrigger id="base-branch" className="w-full">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" sideOffset={4}>
                <SelectGroup>
                  <SelectLabel className="flex items-center gap-1.5">
                    <GitBranchIcon aria-hidden className="size-3.5" />
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
                      <SelectLabel className="flex items-center gap-1.5">
                        <FolderGit2Icon aria-hidden className="size-3.5" />
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
          <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
            {error ?? ''}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || loadingBranches}>
              {submitting ? 'Creating…' : 'Create session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
