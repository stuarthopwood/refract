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
import { useSessionsStore } from '@/state'
import type { Repository } from '../../../shared/model'

export interface NewSessionDialogProps {
  repository: Repository
  /** The element (usually a Button) that opens the dialog. */
  trigger: ReactNode
}

// New session creation (docs/DESIGN.md "First run and empty states", CONTEXT.md "Base branch"):
// picks the Base branch, preselecting the repository's default branch, then hands off to
// `sessions.create`. Pinion generates the Session's name and branch; this dialog never asks for
// them.
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
      const result = await window.pinion.repositories.branches(repository.id)
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
    const result = await window.pinion.sessions.create({ repositoryId: repository.id, baseBranch })
    setSubmitting(false)
    if (result.ok) {
      await useSessionsStore.getState().refresh()
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
          <DialogDescription>Pinion names the Session and its branch automatically.</DialogDescription>
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
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
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
