import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state'
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
  const [branches, setBranches] = useState<string[] | null>(null)
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
        setBranches(result.value.branches)
        setBaseBranch(result.value.default)
      } else {
        setBranches(null)
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

  const branchOptions = branches ?? [repository.defaultBranch]

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
              <SelectContent>
                {branchOptions.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
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
