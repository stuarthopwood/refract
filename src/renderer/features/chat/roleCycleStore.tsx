// Role list cache and the Ctrl+R role cycle (#766 part B, amended item 3). Each press moves to
// the next applicable role and updates the pill at once (`cycling`); the applyRole call goes out
// only `CYCLE_DEBOUNCE_MS` after the last press, so tapping through three roles is one switch.
import { create } from 'zustand'
import { toast } from 'sonner'
import { ROLE_LABEL } from '@/lib/modelRoles'
import { notify, useModelRolesStore, useSessionsStore } from '@/state'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'
import { applicableRoles, resolveRoleModelName, shortModelName, type RoleListEntry } from './roleModelText'

export const CYCLE_DEBOUNCE_MS = 600
const SETTLE_CLEAR_MS = 1500
const NO_ROLES: readonly RoleListEntry[] = []

interface RoleCycleState {
  rolesBySession: Record<string, RoleListEntry[] | undefined>
  /** The role chosen by Ctrl+R but not yet sent (or sent and not yet reflected in the Session). */
  cycling: Record<string, string | undefined>
  loadRoles(sessionId: string): Promise<RoleListEntry[]>
}

export const useRoleCycleStore = create<RoleCycleState>((set, get) => ({
  rolesBySession: {},
  cycling: {},
  async loadRoles(sessionId) {
    const result = await window.refract.model.listRoles(sessionId)
    const roles = result.ok ? result.value.roles.map(({ role, model }) => ({ role, model })) : (get().rolesBySession[sessionId] ?? [])
    set((state) => ({ rolesBySession: { ...state.rolesBySession, [sessionId]: roles } }))
    return roles
  }
}))

export function useSessionRoles(sessionId: string): readonly RoleListEntry[] {
  return useRoleCycleStore((state) => state.rolesBySession[sessionId]) ?? NO_ROLES
}

export function useCyclingRole(sessionId: string): string | undefined {
  return useRoleCycleStore((state) => state.cycling[sessionId])
}

const timers = new Map<string, number>()

/** A switcher pick supersedes any Ctrl+R press still waiting out its debounce. */
export function cancelCycle(sessionId: string): void {
  window.clearTimeout(timers.get(sessionId))
  timers.delete(sessionId)
  setCycling(sessionId, undefined)
}

function setCycling(sessionId: string, role: string | undefined) {
  useRoleCycleStore.setState((state) => ({ cycling: { ...state.cycling, [sessionId]: role } }))
}

function roleText(sessionId: string, role: string): string {
  const roles = useRoleCycleStore.getState().rolesBySession[sessionId] ?? NO_ROLES
  const model = resolveRoleModelName(role, roles, useModelRolesStore.getState().catalogs.chat)
  const label = (ROLE_LABEL as Partial<Record<string, string>>)[role] ?? role
  return model ? `${label} · ${shortModelName(model)}` : label
}

async function flush(sessionId: string) {
  const role = useRoleCycleStore.getState().cycling[sessionId]
  if (!role) return
  const session = useSessionsStore.getState().sessions.find((x) => x.id === sessionId)
  const unchanged = session && !session.pinned && session.currentRole === role && !session.pendingSelection
  if (unchanged) return setCycling(sessionId, undefined)
  const result = await window.refract.model.applyRole(sessionId, role)
  if (!result.ok) {
    if (useRoleCycleStore.getState().cycling[sessionId] === role) setCycling(sessionId, undefined)
    notify(result.error, sessionId)
    return
  }
  const label = (ROLE_LABEL as Partial<Record<string, string>>)[role] ?? role
  useChatAreaAnnouncer.getState().announce(result.value.queued ? `${label} role queued for next turn` : `Role: ${roleText(sessionId, role)}`)
  window.setTimeout(() => {
    if (useRoleCycleStore.getState().cycling[sessionId] === role && !timers.has(sessionId)) setCycling(sessionId, undefined)
  }, SETTLE_CLEAR_MS)
}

/** One Ctrl+R (`1`) or Shift+Ctrl+R (`-1`) press. */
export async function cycleRole(sessionId: string, direction: 1 | -1): Promise<void> {
  const store = useRoleCycleStore.getState()
  void useModelRolesStore.getState().loadCatalog('chat', false)
  const roles = applicableRoles(store.rolesBySession[sessionId] ?? (await store.loadRoles(sessionId)))
  if (roles.length === 0) return
  const session = useSessionsStore.getState().sessions.find((x) => x.id === sessionId)
  const base = useRoleCycleStore.getState().cycling[sessionId] ?? session?.pendingSelection?.role ?? (session?.pinned ? null : session?.currentRole)
  const index = roles.findIndex((entry) => entry.role === base)
  const next = index < 0 ? (direction > 0 ? 0 : roles.length - 1) : (index + direction + roles.length) % roles.length
  const role = roles[next]!.role
  setCycling(sessionId, role)
  // Visual only: the debounced chat-area announcer is the one spoken result.
  toast.custom(
    () => (
      <div aria-hidden className="rounded-lg border border-border bg-popover px-4 py-4 text-sm text-popover-foreground shadow-lg">
        Role: {roleText(sessionId, role)}
      </div>
    ),
    { id: `role-cycle-${sessionId}`, duration: 2500 }
  )
  window.clearTimeout(timers.get(sessionId))
  timers.set(
    sessionId,
    window.setTimeout(() => {
      timers.delete(sessionId)
      void flush(sessionId)
    }, CYCLE_DEBOUNCE_MS)
  )
}
