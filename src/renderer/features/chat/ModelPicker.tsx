// The composer's one Role·Model switcher (#766 part B). The trigger is the combined
// `RoleModelPill`; the popover holds a row of role chips (Left/Right) above a model filter and
// list (Up/Down). Tab moves between the two, Esc closes and returns focus to the pill. Picking a
// role un-pins, picking a model pins; changes are accepted at any time (a working or stopped
// Session queues them for its next turn, shown as "next" and a clock glyph on the pill).
// Earlier gate-round history for this component lives in git (`git log -- ModelPicker.tsx`).
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CpuIcon, Loader2Icon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FILTER_MIN_CHARS, effectiveFilterQuery } from '@/components/filterQueryRule'
import { FilterResultStatus } from '@/components/FilterResultStatus'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { notify, useModelRolesStore, useSessionsStore } from '@/state'
import { ROLE_ICON, ROLE_LABEL, roleTone, type RoleChipRoleId } from '@/lib/modelRoles'
import type { ModelCatalogEntry } from '../../../shared/model'
import { ModelCatalogGroup } from './ModelCatalogGroup'
import { RoleOption } from './RoleOption'
import { RoleModelPill, useRoleModelDisplay } from './RoleModelPill'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'
import { cancelCycle, useCyclingRole, useRoleCycleStore, useSessionRoles } from './roleCycleStore'
import { friendlyRoleModel, resolveRoleModelName, shortModelName, shownText } from './roleModelText'
import { OPEN_ROLE_SWITCHER_EVENT, useRoleCycleShortcut } from './useRoleCycleShortcut'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS, usePickerOpenState } from './pickerShared'

type ApplyResult = { ok: true; value: { queued?: boolean } } | { ok: false; error: Parameters<typeof notify>[0] }

const roleLabelOf = (role: string) => (ROLE_LABEL as Partial<Record<string, string>>)[role] ?? role

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const { session, current } = useRoleModelDisplay(sessionId)
  const cycling = useCyclingRole(sessionId)
  const roles = useSessionRoles(sessionId)
  const loadRoles = useRoleCycleStore((s) => s.loadRoles)
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const catalogError = useModelRolesStore((s) => s.catalogErrors.chat)
  const loadCatalog = useModelRolesStore((s) => s.loadCatalog)
  const announce = useChatAreaAnnouncer((s) => s.announce)
  const [filter, setFilter] = useState('')
  const [roleActive, setRoleActive] = useState(0)
  const [modelActive, setModelActive] = useState(0)
  const [applying, setApplying] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const { open, setOpen, onOpenChange } = usePickerOpenState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const roleRowRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const outsideCloseRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const modelsHeadingId = useId()
  useRoleCycleShortcut(sessionId)

  const pending = session?.pendingSelection
  const pendingRole = cycling ?? pending?.role ?? null
  const hasPendingChoice = Boolean(pending?.role || pending?.model)

  useEffect(() => {
    void loadRoles(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.currentRole, session?.pinned, pending?.role])

  useEffect(() => {
    if (open || hasPendingChoice || cycling) void loadCatalog('chat', Boolean(open && catalogError))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasPendingChoice, cycling, loadCatalog])

  useEffect(() => {
    function onOpenRequest(event: Event) {
      if ((event as CustomEvent<string>).detail === sessionId) setOpen(true)
    }
    window.addEventListener(OPEN_ROLE_SWITCHER_EVENT, onOpenRequest)
    return () => window.removeEventListener(OPEN_ROLE_SWITCHER_EVENT, onOpenRequest)
  }, [sessionId, setOpen])

  const roleItems = useMemo(
    () =>
      roles.map((entry) => {
        const friendly = friendlyRoleModel(entry.role, entry.model, catalog)
        const resolved = resolveRoleModelName(entry.role, roles, catalog)
        return { role: entry.role, text: resolved ?? friendly.text, disabled: !friendly.hasFallback }
      }),
    [roles, catalog]
  )

  const filteredCatalog = useMemo(() => {
    const needle = effectiveFilterQuery(filter).toLowerCase()
    const entries = catalog ?? []
    return needle ? entries.filter((entry) => `${entry.provider} ${entry.name}`.toLowerCase().includes(needle)) : entries
  }, [catalog, filter])

  // Specials come first in the model list and hide while filtering.
  const keepAvailable = hasPendingChoice && Boolean(session?.lastModel || session?.currentRole)
  const followRole = session?.pinned ? (session.currentRole ?? 'default') : null
  const followModel = followRole ? resolveRoleModelName(followRole, roles, catalog) : null
  const specials: Array<'keep' | 'follow'> = effectiveFilterQuery(filter) ? [] : [...(keepAvailable ? (['keep'] as const) : []), ...(followRole ? (['follow'] as const) : [])]
  const specialCount = specials.length
  const totalModelRows = specialCount + (catalogError ? 1 : filteredCatalog.length)
  const activeModel = totalModelRows === 0 ? null : Math.min(modelActive, totalModelRows - 1)

  const optionId = (index: number) => `${listboxId}-option-${index}`
  const roleOptionId = (role: string) => `${listboxId}-role-${role}`
  const retryOptionId = `${listboxId}-option-retry`
  const activeModelDomId = activeModel === null ? undefined : catalogError && activeModel === specialCount ? retryOptionId : optionId(activeModel)
  const activeRoleItem = roleItems[roleActive]

  useEffect(() => {
    if (!open) return
    setFilter('')
    setModelActive(0)
    const index = roleItems.findIndex((item) => item.role === (pendingRole ?? (session?.pinned ? null : session?.currentRole)))
    setRoleActive(Math.max(index, 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roleItems.length])

  useEffect(() => {
    setModelActive(0)
  }, [filter])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
      roleRowRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, activeModel, roleActive])

  function closeAndReturnFocus() {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  async function apply(label: string, call: () => Promise<ApplyResult>) {
    cancelCycle(sessionId)
    setApplying(true)
    closeAndReturnFocus()
    try {
      const result = await call()
      if (!result.ok) return notify(result.error, sessionId)
      announce(result.value.queued ? `${label} queued for next turn` : label)
    } finally {
      setApplying(false)
    }
  }

  const selectRole = (role: string) => apply(`${roleLabelOf(role)} role`, () => window.refract.model.applyRole(sessionId, role))
  const selectModel = (entry: Pick<ModelCatalogEntry, 'provider' | 'id' | 'name'>) =>
    apply(entry.name, () => window.refract.model.setModel(sessionId, entry.provider, entry.id))
  const keepCurrent = () => {
    const model = session?.lastModel
    if (session?.pinned || !session?.currentRole) return model ? selectModel({ provider: model.provider, id: model.id, name: model.name ?? model.id }) : undefined
    return selectRole(session.currentRole)
  }

  function selectModelRow() {
    if (activeModel === null) return
    if (activeModel < specialCount) {
      if (specials[activeModel] === 'keep') void keepCurrent()
      else if (followRole) void selectRole(followRole)
      return
    }
    if (catalogError) return void retryCatalog()
    const entry = filteredCatalog[activeModel - specialCount]
    if (entry) void selectModel(entry)
  }

  async function retryCatalog() {
    if (retrying) return
    setRetrying(true)
    try {
      await loadCatalog('chat', true)
    } finally {
      setRetrying(false)
    }
  }

  function moveRole(step: number, absolute?: 'first' | 'last') {
    const usable = roleItems.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0)
    if (usable.length === 0) return
    if (absolute) return setRoleActive(absolute === 'first' ? usable[0]! : usable[usable.length - 1]!)
    const position = usable.indexOf(roleActive)
    setRoleActive(usable[Math.min(Math.max(position + step, 0), usable.length - 1)]!)
  }

  function handleRoleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = event.key
    const handled = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowDown', 'Enter', ' ', 'Escape', 'Tab'].includes(key)
    if (handled) event.preventDefault()
    // Radix's focus trap loops Tab after our handler has already moved focus.
    if (key === 'Tab') event.stopPropagation()
    if (key === 'ArrowLeft') moveRole(-1)
    else if (key === 'ArrowRight') moveRole(1)
    else if (key === 'Home') moveRole(0, 'first')
    else if (key === 'End') moveRole(0, 'last')
    else if (key === 'ArrowDown' || key === 'Tab') filterInputRef.current?.focus()
    else if (key === 'Enter' || key === ' ') {
      if (activeRoleItem && !activeRoleItem.disabled) void selectRole(activeRoleItem.role)
    } else if (key === 'Escape') closeAndReturnFocus()
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      setFilter((value) => value + key)
      filterInputRef.current?.focus()
    }
  }

  function handleFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setModelActive(Math.max(0, Math.min((activeModel ?? 0) + (event.key === 'ArrowDown' ? 1 : -1), totalModelRows - 1)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectModelRow()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeAndReturnFocus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      roleRowRef.current?.focus()
    }
  }

  const nextModel = pending?.model ?? null
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <RoleModelPill ref={triggerRef} sessionId={sessionId} busy={applying} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Choose role or model"
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-80 flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          outsideCloseRef.current = false
          roleRowRef.current?.focus()
        }}
        onInteractOutside={() => {
          outsideCloseRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // An outside click leaves focus where the user clicked.
          if (!outsideCloseRef.current) triggerRef.current?.focus()
          outsideCloseRef.current = false
        }}
      >
        <div
          ref={roleRowRef}
          role="listbox"
          tabIndex={0}
          aria-label="Roles"
          aria-orientation="horizontal"
          aria-activedescendant={activeRoleItem ? roleOptionId(activeRoleItem.role) : undefined}
          onKeyDown={handleRoleKeyDown}
          className="flex shrink-0 flex-wrap gap-1 p-1 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-composer-focus"
        >
          {roleItems.length === 0 && (
            <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
              Loading roles…
            </span>
          )}
          {roleItems.map((item, index) => (
            <RoleOption
              key={item.role}
              id={roleOptionId(item.role)}
              label={roleLabelOf(item.role)}
              Icon={ROLE_ICON[item.role as RoleChipRoleId] ?? CpuIcon}
              modelText={shortModelName(item.text)}
              tone={roleTone(item.role)}
              current={!session?.pinned && item.role === session?.currentRole}
              next={item.role === pendingRole}
              active={index === roleActive}
              disabled={item.disabled}
              onHover={() => !item.disabled && setRoleActive(index)}
              onSelect={() => void selectRole(item.role)}
            />
          ))}
        </div>
        <div className="shrink-0 p-1">
          <Input
            ref={filterInputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={activeModelDomId}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            placeholder={`Filter models… (${FILTER_MIN_CHARS}+ characters)`}
            aria-label="Filter models"
            className="h-6 rounded-[max(0px,calc(var(--radius-lg)-0.25rem))]"
          />
          <FilterResultStatus query={filter} count={catalog && !catalogError ? filteredCatalog.length : undefined} />
        </div>
        <div ref={listRef} id={listboxId} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto" onMouseDown={(event) => event.preventDefault()}>
          {specialCount > 0 && (
            <div role="group" aria-label="Role options">
              {specials.map((kind, index) => (
                <div
                  key={kind}
                  id={optionId(index)}
                  role="option"
                  aria-selected={false}
                  data-active={index === activeModel}
                  onMouseEnter={() => setModelActive(index)}
                  onClick={(event) => {
                    if (event.button !== 0) return
                    if (kind === 'keep') void keepCurrent()
                    else if (followRole) void selectRole(followRole)
                  }}
                  className={cn(PICKER_OPTION_CLASS, index === activeModel && PICKER_OPTION_ACTIVE_CLASS)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {kind === 'keep'
                      ? `Keep current (${shownText(current)})`
                      : `Follow role (${roleLabelOf(followRole!)}${followModel ? ` → ${shortModelName(followModel)}` : ''})`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <ModelCatalogGroup
            modelsHeadingId={modelsHeadingId}
            indexOffset={specialCount}
            catalogError={catalogError}
            catalog={catalog}
            filteredCatalog={filteredCatalog}
            clampedActiveIndex={activeModel}
            optionId={optionId}
            retryOptionId={retryOptionId}
            retrying={retrying}
            currentModel={session?.lastModel ?? null}
            nextModel={nextModel}
            onHoverIndex={setModelActive}
            onRetry={() => void retryCatalog()}
            onSelectModel={(entry) => void selectModel(entry)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
