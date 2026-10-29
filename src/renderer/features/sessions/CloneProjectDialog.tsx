// "Clone from GitHub" dialog (spec 054, #867; UI ruling from ui-architect-v3): one step -- filter,
// grouped repository list, paste field, destination, then Clone. Clone closes the dialog at once;
// progress continues as a toast owned by state/clones.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpenIcon, LockIcon } from 'lucide-react'
import { FilterableGroupedListbox } from '@/components/FilterableGroupedListbox'
import type { ListboxGroup } from '@/components/FilterableGroupedListbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CHECKBOX_BOX_CLASS, CHECKBOX_LIST_ITEM_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { notify, useSettingsStore } from '@/state'
import { useAccountsStore } from '@/state/accounts'
import { openProject, startClone } from '@/state/clones'
import type { GitHubOwnerListing, GitHubRepoListing, GitHubRepoRow } from '../../../shared/ipc-repositories-clone'
import { defaultFolderCheckbox, isPlausibleSource, joinPath, repoNameFromSource } from './clone-destination'

const PER_OWNER_LIMIT = 100

type RepoItem = GitHubRepoRow & { id: string }

export interface CloneProjectDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

function toGroups(
  listing: GitHubRepoListing | null,
  filter: string,
  onRetry: (owner: string) => void
): { groups: ListboxGroup<RepoItem>[]; shown: number; total: number } {
  if (!listing) return { groups: [], shown: 0, total: 0 }
  const needle = filter.trim().toLowerCase()
  const self = listing.owners.filter((owner) => owner.kind === 'self')
  const orgs = listing.owners.filter((owner) => owner.kind === 'org').sort((a, b) => a.owner.localeCompare(b.owner))
  let shown = 0
  let total = 0
  const groups = [...self, ...orgs].map((owner: GitHubOwnerListing): ListboxGroup<RepoItem> => {
    total += owner.repos.length
    const matches = owner.repos.filter(
      (repo) =>
        !needle || repo.nameWithOwner.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle)
    )
    const items = matches.slice(0, PER_OWNER_LIMIT).map((repo) => ({ ...repo, id: repo.nameWithOwner }))
    shown += items.length
    return {
      id: owner.owner,
      label: owner.owner,
      items,
      error: owner.error
        ? { message: `Couldn't load ${owner.owner}`, actionLabel: 'Retry', onRetry: () => onRetry(owner.owner) }
        : undefined
    }
  })
  return { groups, shown, total }
}

export function CloneProjectDialog({ open, onOpenChange }: CloneProjectDialogProps) {
  const defaultFolder = useSettingsStore((state) => state.settings.defaultCloneFolder ?? null)
  const addFlow = useAccountsStore((state) => state.addFlow)
  const addFlowOutcome = useAccountsStore((state) => state.addFlowOutcome)
  const [listing, setListing] = useState<GitHubRepoListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<RepoItem | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [destinationEdited, setDestinationEdited] = useState(false)
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    const result = await window.refract.repositories.listGitHub()
    setLoading(false)
    if (result.ok) setListing(result.value)
    else setLoadError(result.error.message)
  }, [])

  const retryOwner = useCallback(async (owner: string): Promise<void> => {
    const result = await window.refract.repositories.listGitHub(owner)
    if (!result.ok) {
      notify(result.error)
      return
    }
    const fresh = result.value.owners.find((entry) => entry.owner === owner)
    if (!fresh) return
    setListing((current) =>
      current ? { ...current, owners: current.owners.map((entry) => (entry.owner === owner ? fresh : entry)) } : current
    )
  }, [])

  useEffect(() => {
    if (open) void load()
    else {
      setListing(null)
      setFilter('')
      setSelected(null)
      setPaste('')
      setPasteError(null)
      setDestination('')
      setDestinationEdited(false)
      setSaveChoice(null)
    }
  }, [open, load])

  // A finished sign-in changes what the listing can show.
  useEffect(() => {
    if (open && addFlowOutcome === 'completed') void load()
  }, [open, addFlowOutcome, load])

  const source = selected?.nameWithOwner ?? paste.trim()
  const repoName = repoNameFromSource(source)

  // Prefill `<default>\<name>` until the person has edited the field themselves.
  useEffect(() => {
    if (destinationEdited) return
    setDestination(defaultFolder && repoName ? joinPath(defaultFolder, repoName) : '')
  }, [defaultFolder, repoName, destinationEdited])

  const { groups, shown, total } = useMemo(() => toGroups(listing, filter, (owner) => void retryOwner(owner)), [listing, filter, retryOwner])
  const checkbox = defaultFolderCheckbox(destination, defaultFolder)
  const saveAsDefault = saveChoice ?? checkbox.initiallyChecked
  const alreadyAdded = selected?.existingProjectId ?? null
  const countText = listing ? `Showing ${shown} of ${total}` : undefined
  const canClone = source !== '' && destination.trim() !== ''

  async function handleBrowse(): Promise<void> {
    const result = await window.refract.repositories.pickFolder()
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (result.value === null) return
    setDestinationEdited(true)
    setDestination(repoName ? joinPath(result.value, repoName) : result.value)
  }

  function handleSubmit(): void {
    if (alreadyAdded) {
      openProject(alreadyAdded)
      onOpenChange(false)
      return
    }
    if (!selected && !isPlausibleSource(source)) {
      setPasteError('Enter owner/name or a github.com URL.')
      return
    }
    void startClone({ source, destination: destination.trim(), saveAsDefault: checkbox.visible && saveAsDefault })
    onOpenChange(false)
  }

  const signedOut = listing !== null && !listing.signedIn

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          filterRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>Pick a repository or paste one, choose a folder, and Refract adds it as a project.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canClone || alreadyAdded) handleSubmit()
          }}
        >
          {signedOut ? (
            <div className="flex flex-col items-start gap-2 rounded-md border border-border p-3 text-sm">
              <p>Sign in to GitHub to see your repositories</p>
              {addFlow?.code && (
                <p className="text-muted-foreground">
                  Enter code <span className="font-mono text-foreground">{addFlow.code}</span> in the browser window GitHub opened.
                </p>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => void useAccountsStore.getState().addAccountStart()}>
                Sign in
              </Button>
            </div>
          ) : (
            <FilterableGroupedListbox
              groups={groups}
              value={filter}
              onValueChange={setFilter}
              label="Filter repositories"
              placeholder="Filter repositories"
              inputRef={filterRef}
              selectedId={selected?.id ?? null}
              onSelect={(item) => {
                setSelected(item)
                setPaste('')
                setPasteError(null)
              }}
              renderItem={(repo) => (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate">{repo.nameWithOwner}</span>
                    {repo.isPrivate && (
                      <>
                        <LockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                        <span className="sr-only">Private</span>
                      </>
                    )}
                    {repo.existingProjectId && <Badge variant="outline">Already added</Badge>}
                  </span>
                  {repo.description && <span className="truncate text-xs text-muted-foreground">{repo.description}</span>}
                </span>
              )}
              emptyText={
                loading ? 'Loading repositories...' : loadError ?? (filter ? 'No repositories match' : 'No repositories found')
              }
              countText={countText}
              announcement={countText}
            />
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="clone-paste" className="text-sm">
              Or paste a repository
            </label>
            <Input
              id="clone-paste"
              value={paste}
              placeholder="owner/name or https://github.com/owner/name"
              aria-invalid={pasteError ? true : undefined}
              aria-describedby={pasteError ? 'clone-paste-error' : undefined}
              onChange={(event) => {
                setPaste(event.target.value)
                setSelected(null)
                setPasteError(null)
              }}
              onBlur={() => {
                if (paste.trim() && !isPlausibleSource(paste)) setPasteError('Enter owner/name or a github.com URL.')
              }}
            />
            {pasteError && (
              <p id="clone-paste-error" className="text-xs text-destructive">
                {pasteError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="clone-destination" className="text-sm">
              Clone into
            </label>
            <div className="flex gap-2">
              <Input
                id="clone-destination"
                value={destination}
                placeholder="C:\Repos\my-project"
                className="flex-1"
                onChange={(event) => {
                  setDestinationEdited(true)
                  setDestination(event.target.value)
                }}
              />
              <Button type="button" variant="outline" onClick={() => void handleBrowse()}>
                <FolderOpenIcon aria-hidden />
                Browse
              </Button>
            </div>
          </div>
          {checkbox.visible && (
            <div className="flex items-center gap-2">
              <CheckboxItem
                id="clone-save-default"
                className={CHECKBOX_LIST_ITEM_CLASS}
                checked={saveAsDefault}
                onCheckedChange={(value) => setSaveChoice(value === true)}
              >
                <span className={CHECKBOX_BOX_CLASS}>
                  <CheckboxIndicator />
                </span>
              </CheckboxItem>
              <label htmlFor="clone-save-default" className="text-sm">
                Use this folder for future clones
              </label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canClone && !alreadyAdded}>
              {alreadyAdded ? 'Open project' : 'Clone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
