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
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { useAccountsStore } from '@/state/accounts'
import { openProject, startClone } from '@/state/clones'
import type { GitHubOwnerListing, GitHubRepoListing, GitHubRepoRow } from '../../../shared/ipc-repositories-clone'
import { defaultFolderCheckbox, isPlausibleSource, joinPath, repoNameFromSource } from './clone-destination'

const PER_OWNER_LIMIT = 100
const PASTE_ERROR = 'Enter owner/name or a github.com URL.'

type RepoItem = GitHubRepoRow & { id: string }

export interface CloneProjectDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

function toGroups(
  listing: GitHubRepoListing | null,
  filter: string,
  retrying: ReadonlySet<string>,
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
        ? {
            message: `Couldn't load ${owner.owner}`,
            actionLabel: retrying.has(owner.owner) ? 'Retrying…' : 'Retry',
            onRetry: () => onRetry(owner.owner)
          }
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
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<RepoItem | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [destinationEdited, setDestinationEdited] = useState(false)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null)
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set())
  const [selectionAnnouncement, announceSelection] = useClearedAnnouncement()
  const filterRef = useRef<HTMLInputElement>(null)
  const pasteRef = useRef<HTMLInputElement>(null)
  const destinationRef = useRef<HTMLInputElement>(null)
  const signInRef = useRef<HTMLButtonElement>(null)
  // Bumped on every load and on close: a listing that lands for an older request is dropped.
  const requestRef = useRef(0)
  const retryingRef = useRef<Set<string>>(new Set())
  const wasSignedOutRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    const token = ++requestRef.current
    setLoading(true)
    setLoadError(null)
    const result = await window.refract.repositories.listGitHub()
    if (token !== requestRef.current) return
    setLoading(false)
    if (result.ok) setListing(result.value)
    else setLoadError({ code: result.error.code, message: result.error.message })
  }, [])

  const retryOwner = useCallback(async (owner: string): Promise<void> => {
    if (retryingRef.current.has(owner)) return
    const token = requestRef.current
    retryingRef.current.add(owner)
    setRetrying(new Set(retryingRef.current))
    const result = await window.refract.repositories.listGitHub(owner)
    retryingRef.current.delete(owner)
    setRetrying(new Set(retryingRef.current))
    if (token !== requestRef.current) return
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
      requestRef.current++
      retryingRef.current.clear()
      setRetrying(new Set())
      setListing(null)
      setLoading(false)
      setLoadError(null)
      setFilter('')
      setSelected(null)
      setPaste('')
      setPasteError(null)
      setDestination('')
      setDestinationEdited(false)
      setDestinationError(null)
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

  const { groups, shown, total } = useMemo(
    () => toGroups(listing, filter, retrying, (owner) => void retryOwner(owner)),
    [listing, filter, retrying, retryOwner]
  )
  const checkbox = defaultFolderCheckbox(destination, defaultFolder)
  const saveAsDefault = saveChoice ?? checkbox.initiallyChecked
  const alreadyAdded = selected?.existingProjectId ?? null
  const countText = listing ? `Showing ${shown} of ${total}` : undefined
  const signedOut = listing !== null && !listing.signedIn
  const ghUnavailable = loadError?.code === 'gh-unavailable'

  useEffect(() => {
    if (signedOut) {
      wasSignedOutRef.current = true
      signInRef.current?.focus()
    } else if (listing?.signedIn && wasSignedOutRef.current) {
      wasSignedOutRef.current = false
      filterRef.current?.focus()
    }
  }, [signedOut, listing])

  async function handleBrowse(): Promise<void> {
    const result = await window.refract.repositories.pickFolder()
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (result.value === null) return
    setDestinationEdited(true)
    setDestinationError(null)
    setDestination(repoName ? joinPath(result.value, repoName) : result.value)
  }

  async function handleSubmit(): Promise<void> {
    if (alreadyAdded) {
      openProject(alreadyAdded)
      onOpenChange(false)
      return
    }
    if (!selected && !isPlausibleSource(source)) {
      setPasteError(PASTE_ERROR)
      pasteRef.current?.focus()
      return
    }
    if (destination.trim() === '') {
      setDestinationError('Choose a folder to clone into.')
      destinationRef.current?.focus()
      return
    }
    if (starting) return
    setStarting(true)
    const result = await startClone({ source, destination: destination.trim(), saveAsDefault: checkbox.visible && saveAsDefault })
    setStarting(false)
    if (result.started) {
      onOpenChange(false)
      return
    }
    if (result.inlineError) {
      setDestinationError(result.inlineError)
      destinationRef.current?.focus()
    } else onOpenChange(false)
  }

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
            void handleSubmit()
          }}
        >
          {signedOut ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Sign in to GitHub to see your repositories</EmptyTitle>
                {addFlow?.code && (
                  <EmptyDescription role="status">
                    Enter code <span className="font-mono text-foreground">{addFlow.code}</span> in the browser window GitHub opened.
                  </EmptyDescription>
                )}
              </EmptyHeader>
              <EmptyContent>
                <Button
                  ref={signInRef}
                  type="button"
                  variant="ghost"
                  onClick={() => void useAccountsStore.getState().addAccountStart()}
                >
                  Sign in
                </Button>
              </EmptyContent>
            </Empty>
          ) : ghUnavailable ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>GitHub CLI isn't installed</EmptyTitle>
                <EmptyDescription>
                  Install the GitHub CLI (gh) from cli.github.com, then try again. You can still paste a repository below.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="ghost" onClick={() => void load()}>
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
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
                announceSelection(
                  item.existingProjectId
                    ? `Selected ${item.nameWithOwner}. Already added, Open project`
                    : `Selected ${item.nameWithOwner}`
                )
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
              empty={
                loading ? (
                  'Loading repositories…'
                ) : loadError ? (
                  <div role="alert" className="flex items-center justify-between gap-2">
                    <span className="min-w-0">{loadError.message}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                      Retry
                    </Button>
                  </div>
                ) : filter ? (
                  'No repositories match'
                ) : (
                  'No repositories found'
                )
              }
              countText={countText}
              announcement={countText}
            />
          )}
          <div role="status" className="sr-only">
            {selectionAnnouncement}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="clone-paste" className="text-sm">
              Or paste a repository
            </label>
            <Input
              id="clone-paste"
              ref={pasteRef}
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
                if (paste.trim() && !isPlausibleSource(paste)) setPasteError(PASTE_ERROR)
              }}
            />
            {pasteError && (
              <p id="clone-paste-error" role="alert" className="text-xs text-destructive">
                {pasteError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="clone-destination" className="text-sm">
              Clone into
            </label>
            <div className="flex gap-2">
              <Input
                id="clone-destination"
                ref={destinationRef}
                value={destination}
                placeholder="C:\Repos\my-project"
                className="flex-1"
                aria-invalid={destinationError ? true : undefined}
                aria-describedby={destinationError ? 'clone-destination-error' : undefined}
                onChange={(event) => {
                  setDestinationEdited(true)
                  setDestinationError(null)
                  setDestination(event.target.value)
                }}
              />
              <Button type="button" variant="ghost" onClick={() => void handleBrowse()}>
                <FolderOpenIcon aria-hidden />
                Browse
              </Button>
            </div>
            {destinationError && (
              <p id="clone-destination-error" role="alert" className="text-xs text-destructive">
                {destinationError}
              </p>
            )}
          </div>
          {checkbox.visible && (
            <CheckboxItem
              className={CHECKBOX_LIST_ITEM_CLASS}
              checked={saveAsDefault}
              onCheckedChange={(value) => setSaveChoice(value === true)}
            >
              <span className={CHECKBOX_BOX_CLASS}>
                <CheckboxIndicator />
              </span>
              <span className="min-w-0 flex-1">Use this folder for future clones</span>
            </CheckboxItem>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={(source === '' && !alreadyAdded) || (!alreadyAdded && destination.trim() === '') || starting}>
              {alreadyAdded ? 'Open project' : 'Clone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
