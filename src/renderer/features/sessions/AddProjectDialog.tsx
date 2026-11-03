import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { FolderOpenIcon } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { notify, useRepositoriesStore } from '@/state'

export interface AddProjectDialogProps {
  /** The element (usually a Button) that opens the dialog; omit when `open` is controlled. */
  trigger?: ReactNode
  open?: boolean
  onOpenChange?(open: boolean): void
}

// Local project path entry (docs/DESIGN.md "First run and empty states"): paste an absolute path,
// or Browse for one with the native folder picker (contracts/ipc.md `repositories.pickFolder`).
export function AddProjectDialog({ trigger, open: controlledOpen, onOpenChange }: AddProjectDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean): void => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  const [path, setPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const add = useRepositoriesStore((state) => state.add)

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) setPath('')
  }
  async function handleBrowse(): Promise<void> {
    setBrowsing(true)
    const result = await window.refract.repositories.pickFolder()
    setBrowsing(false)
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (result.value !== null) setPath(result.value)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = path.trim()
    if (!trimmed) return
    setSubmitting(true)
    const repository = await add(trimmed)
    setSubmitting(false)
    if (repository) handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Paste the folder path of a local git repository, or browse for one.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-2">
            <label htmlFor="repository-path" className="text-sm">
              Project path
            </label>
            <div className="flex gap-2">
              <Input
                id="repository-path"
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="C:\Repos\my-project"
                aria-describedby="repository-path-hint"
                className="flex-1"
              />
              <Button type="button" variant="ghost" disabled={browsing} onClick={() => void handleBrowse()}>
                <FolderOpenIcon aria-hidden />
                {browsing ? 'Browsing…' : 'Browse'}
              </Button>
            </div>
            <p id="repository-path-hint" className="text-xs text-muted-foreground">
              Paste the folder path
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path.trim() || submitting}>
              {submitting ? 'Adding…' : 'Add project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
