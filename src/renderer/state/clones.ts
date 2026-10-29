// Background clones (spec 054 FR-020..FR-030): one loading toast per clone, driven by the
// `repositories:clone-progress` event. The Clone dialog closes the moment a clone starts, so this
// module (not a component) owns each clone's toast for its whole life.
import type { CloneProgressEvent, CloneStage } from '../../shared/ipc-repositories-clone'
import { notifyPersistentError, notifyProgress } from './notify'
import type { ProgressToast } from './notify'
import { useRepositoriesStore } from './repositories-store'
import { useSettingsStore } from './settings-store'
import { useViewStore } from './view-store'
import { parentOf } from '../lib/parent-path'

const STAGE_LABELS: Record<CloneStage, string> = {
  starting: 'Starting',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  updating: 'Updating files',
  adding: 'Adding project'
}

interface ActiveClone {
  name: string
  destination: string
  toast: ProgressToast
}

const active = new Map<string, ActiveClone>()
// Progress events can arrive before `clone()` resolves with the id; hold them until it does.
const early = new Map<string, CloneProgressEvent[]>()
let subscribed = false

export function openProject(projectId: string): void {
  useViewStore.getState().openChat(projectId)
}

function handle(event: CloneProgressEvent): void {
  const clone = active.get(event.cloneId)
  if (!clone) {
    early.set(event.cloneId, [...(early.get(event.cloneId) ?? []), event])
    return
  }
  switch (event.phase) {
    case 'progress':
      clone.toast.update(`Cloning ${clone.name}: ${STAGE_LABELS[event.stage]}`)
      return
    case 'done': {
      active.delete(event.cloneId)
      useRepositoriesStore.getState().addLocal(event.project)
      clone.toast.succeed(`Cloned ${clone.name}`, { label: 'Open', onClick: () => openProject(event.project.id) })
      return
    }
    case 'done-not-added':
      active.delete(event.cloneId)
      clone.toast.fail(
        `Cloned to ${event.destination}, but couldn't add it as a Project. Use Add project > Local folder.`
      )
      return
    case 'failed':
      active.delete(event.cloneId)
      clone.toast.fail(event.message)
      return
    case 'cancelled':
      active.delete(event.cloneId)
      if (event.cleanupFailedPath) clone.toast.fail(`Cancelled; couldn't remove ${event.cleanupFailedPath}`)
      else clone.toast.info('Clone cancelled')
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.refract.repositories.onCloneProgress(handle)
}

export interface StartCloneInput {
  source: string
  destination: string
  saveAsDefault: boolean
}

/** Starts a clone in the background. Resolves once it has started (or failed to), not when it ends. */
export async function startClone({ source, destination, saveAsDefault }: StartCloneInput): Promise<void> {
  ensureSubscribed()
  const result = await window.refract.repositories.clone({ source, destination })
  if (!result.ok) {
    notifyPersistentError(result.error.message)
    return
  }
  if (result.value.kind === 'existing') {
    openProject(result.value.projectId)
    return
  }
  const { cloneId, nameWithOwner } = result.value
  const name = nameWithOwner.split('/').pop() ?? nameWithOwner
  const toast = notifyProgress(cloneId, `Cloning ${name}: ${STAGE_LABELS.starting}`, () => {
    void window.refract.repositories.cloneCancel(cloneId)
  })
  active.set(cloneId, { name, destination: result.value.destination, toast })
  for (const event of early.get(cloneId) ?? []) handle(event)
  early.delete(cloneId)

  const parent = parentOf(result.value.destination)
  if (saveAsDefault && parent) {
    const saved = await window.refract.settings.setDefaultCloneFolder(parent)
    if (saved.ok) useSettingsStore.getState().setSettings(saved.value)
    else notifyPersistentError(saved.error.message)
  }
}
