import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BellIcon, BellRingIcon } from 'lucide-react'
import { READOUT_KIND_ICONS } from '@/components/icons/readout-icons'
import { FieldLabel } from '@/components/FieldLabel'
import { ListCardButton } from '@/components/ListCardButton'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineStatus } from '@/components/InlineStatus'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSettingsStore } from '@/state'
import { useAlarmFiredStore } from '@/state/alarm-fired-store'
import { notifyAlarmDeleted, setAlarmListOpen } from '@/state/notify'
import { MAX_ALARMS, MAX_ALARM_LABEL_CHARS } from '../../../../shared/model'
import type { Alarm } from '../../../../shared/model'
import { ReadoutItem } from './ReadoutItem'

const DAY_MS = 86_400_000
// Long enough that Save cannot race the alarm into firing within seconds.
const DEFAULT_LEAD_MS = 5 * 60_000
const NO_ALARMS: Alarm[] = []
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const pad = (n: number): string => String(n).padStart(2, '0')
const toInputTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The next occurrence of `HH:MM` after `now`; a time already passed today rolls to tomorrow. */
function nextOccurrence(hhmm: string, now: number): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  return at.getTime() > now ? at.getTime() : at.getTime() + DAY_MS
}

const isTomorrow = (ms: number, now: number): boolean => new Date(ms).toDateString() === new Date(now + DAY_MS).toDateString()

const describedBy = (...ids: Array<string | undefined>): string | undefined => ids.filter(Boolean).join(' ') || undefined

interface AlarmFormProps {
  editing: Alarm | null
  now: number
  onDone: () => void
}

function AlarmForm({ editing, now, onDone }: AlarmFormProps) {
  const upsertAlarm = useSettingsStore((s) => s.upsertAlarm)
  const timeId = useId()
  const labelId = useId()
  const hintId = useId()
  const errorId = useId()
  const [time, setTime] = useState(() => toInputTime(editing?.fireAtMs ?? now + DEFAULT_LEAD_MS))
  const [label, setLabel] = useState(editing?.label ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const fireAtMs = time ? nextOccurrence(time, now) : null
  const showTomorrow = fireAtMs !== null && isTomorrow(fireAtMs, now)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (fireAtMs === null || saving) return
    setSaving(true)
    setFailed(false)
    const ok = await upsertAlarm({ id: editing?.id ?? crypto.randomUUID(), label: label.trim(), fireAtMs, active: true })
    setSaving(false)
    if (ok) onDone()
    else setFailed(true)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={timeId}>Time</FieldLabel>
        <Input
          id={timeId}
          type="time"
          required
          autoFocus
          value={time}
          aria-describedby={describedBy(showTomorrow ? hintId : undefined, failed ? errorId : undefined)}
          onChange={(e) => {
            setTime(e.target.value)
            setFailed(false)
          }}
        />
        {showTomorrow && (
          <p id={hintId} className="text-xs text-muted-foreground">
            Tomorrow
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={labelId}>Label (optional)</FieldLabel>
        <Input
          id={labelId}
          maxLength={MAX_ALARM_LABEL_CHARS}
          value={label}
          aria-describedby={failed ? errorId : undefined}
          onChange={(e) => {
            setLabel(e.target.value)
            setFailed(false)
          }}
        />
      </div>
      {failed && (
        <InlineStatus id={errorId} tone="error" density="compact">
          Could not save the alarm. Try again.
        </InlineStatus>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={saving} disabled={fireAtMs === null}>
          Save
        </Button>
      </div>
    </form>
  )
}

interface AlarmRowProps {
  alarm: Alarm
  now: number
  highlighted: boolean
  onEdit: () => void
  onDismiss: () => void
  onRearm: (alarm: Alarm, ok: boolean) => void
  onDeleted: (alarm: Alarm) => void
}

function AlarmRow({ alarm, now, highlighted, onEdit, onDismiss, onRearm, onDeleted }: AlarmRowProps) {
  const deleteAlarm = useSettingsStore((s) => s.deleteAlarm)
  const [rearming, setRearming] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const time = timeFormat.format(alarm.fireAtMs)
  const name = alarm.label ? `${time} ${alarm.label}` : time
  const hint = !alarm.active ? 'Fired' : isTomorrow(alarm.fireAtMs, now) ? 'Tomorrow' : null
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  return (
    <div ref={rowRef} data-alarm-row="" data-alarm-id={alarm.id}>
      <ListCardButton
        ariaLabel={`Edit alarm ${name}${hint ? `, ${hint}` : ''}`}
        onClick={onEdit}
        highlighted={highlighted}
        actions={
          <Button
            type="button"
            variant="ghost-destructive"
            size="sm"
            aria-label={`Delete alarm ${name}`}
            onClick={async () => {
              if (await deleteAlarm(alarm.id)) onDeleted(alarm)
            }}
          >
            Delete
          </Button>
        }
      >
        <span className={alarm.active ? 'font-medium tabular-nums' : 'tabular-nums text-muted-foreground'}>{time}</span>
        {alarm.label && <span className="truncate text-muted-foreground">{alarm.label}</span>}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </ListCardButton>
      {highlighted && (
        <div className="mt-2 flex justify-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={rearming}
            aria-label={`Re-arm alarm ${name}`}
            onClick={async () => {
              setRearming(true)
              const ok = await useSettingsStore.getState().upsertAlarm({ ...alarm, fireAtMs: nextOccurrence(toInputTime(alarm.fireAtMs), Date.now()), active: true })
              setRearming(false)
              onRearm(alarm, ok)
            }}
          >
            Re-arm
          </Button>
          <Button type="button" variant="text" size="sm" aria-label={`Dismiss alarm ${name}`} onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}

/** The composer clock: its readout opens a Popover that lists, adds, edits and deletes Alarms (#1426). */
export function AlarmClock({ formatted, now, className }: { formatted: string; now: Date; className?: string }) {
  const alarms = useSettingsStore((s) => s.settings.alarms) ?? NO_ALARMS
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<{ editing: Alarm | null } | null>(null)
  const clockRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const contentId = useId()
  const firedIds = useAlarmFiredStore((s) => s.firedIds)
  const [status, setStatus] = useState<{ tone: 'error' | 'notice'; text: string } | null>(null)
  const nowMs = now.getTime()
  const armed = alarms.filter((a) => a.active).length
  const full = alarms.length >= MAX_ALARMS
  const sorted = [...alarms].sort(
    (a, b) => Number(firedIds.has(b.id)) - Number(firedIds.has(a.id)) || Number(b.active) - Number(a.active) || a.fireAtMs - b.fireAtMs
  )
  const hasFired = firedIds.size > 0
  const alarmsSet = armed > 0 ? `, ${armed} ${armed === 1 ? 'alarm' : 'alarms'} set` : ''
  const name = `Current time ${formatted}${alarmsSet}${hasFired ? ', alarm fired' : ''}. Open alarms`
  // The focused control unmounts on save, cancel and delete; park focus on a visible control so keyboard users keep their place.
  const parkFocus = (rowId?: string) =>
    requestAnimationFrame(() => {
      const root = contentRef.current
      const target =
        (rowId ? root?.querySelector<HTMLElement>(`[data-alarm-id="${rowId}"] button`) : null) ??
        root?.querySelector<HTMLElement>('[data-alarm-add]:not(:disabled)') ?? root?.querySelector<HTMLElement>('[data-alarm-row] button')
      ;(target ?? root)?.focus()
    })

  const changeOpen = (next: boolean) => {
    setOpen(next)
    setAlarmListOpen(next)
    if (!next) setForm(null)
    setStatus(null)
  }
  // The module flag outlives this component, so clear it if the chip is hidden while open.
  useEffect(() => () => setAlarmListOpen(false), [])

  // An armed alarm turning inactive is a fire; it stays marked (row and bell) until dismissed, popover open or not.
  useEffect(() => {
    useAlarmFiredStore.getState().sync(alarms)
  }, [alarms])

  const openForm = (editing: Alarm | null) => {
    setStatus(null)
    setForm({ editing })
  }

  const dismiss = (id: string) => {
    useAlarmFiredStore.getState().dismiss(id)
    parkFocus(id)
  }

  const onRearm = (alarm: Alarm, ok: boolean) => {
    if (ok) {
      useAlarmFiredStore.getState().dismiss(alarm.id)
      setStatus({ tone: 'notice', text: 'Alarm re-armed.' })
      parkFocus(alarm.id)
    } else setStatus({ tone: 'error', text: 'Could not re-arm the alarm. Try again.' })
  }

  const onDeleted = (alarm: Alarm) => {
    notifyAlarmDeleted(() => void useSettingsStore.getState().upsertAlarm(alarm))
    parkFocus()
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverAnchor asChild>
        <ReadoutItem
          ref={clockRef}
          icon={READOUT_KIND_ICONS['current-time']}
          className={className}
          accessibleName={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          onActivate={() => changeOpen(!open)}
        >
          <span aria-hidden>{formatted}</span>
          {(armed > 0 || hasFired) && (
            <span aria-hidden data-alarm-fired={hasFired ? '' : undefined} className="inline-flex items-center gap-1">
              {hasFired ? <BellRingIcon className="size-4 text-active-indicator" /> : <BellIcon className="size-4" />}
              {armed > 0 && <span className="tabular-nums">{armed}</span>}
            </span>
          )}
        </ReadoutItem>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        id={contentId}
        side="top"
        align="start"
        collisionPadding={8}
        className="w-80 p-4"
        aria-label="Alarms"
        onInteractOutside={(e) => {
          // The clock's own click toggles; letting Radix close first would make it reopen.
          if (e.target instanceof Node && clockRef.current?.contains(e.target)) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (!form) return
          // Escape in the form acts as Cancel instead of closing the whole popover.
          e.preventDefault()
          setForm(null)
          parkFocus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const active = document.activeElement
          if (!active || active === document.body) clockRef.current?.focus()
        }}
      >
        <ScreenSection
          title={form ? (form.editing ? 'Edit alarm' : 'Add alarm') : 'Alarms'}
          count={form ? undefined : armed}
          note={full && !form ? `Limit of ${MAX_ALARMS} alarms reached. Delete one to add another.` : undefined}
          empty={alarms.length === 0 && !form ? 'No alarms set' : null}
          actions={
            !form && (
              <Button type="button" size="sm" variant="ghost" data-alarm-add="" disabled={full} onClick={() => openForm(null)}>
                Add alarm
              </Button>
            )
          }
        >
          {form && (
            <AlarmForm
              key={form.editing?.id ?? 'new'}
              editing={form.editing}
              now={nowMs}
              onDone={() => {
                setForm(null)
                parkFocus()
              }}
            />
          )}
          {status && !form && (
            <InlineStatus tone={status.tone} density="compact">
              {status.text}
            </InlineStatus>
          )}
          {!form && (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {sorted.map((alarm) => (
                <AlarmRow
                  key={alarm.id}
                  alarm={alarm}
                  now={nowMs}
                  highlighted={firedIds.has(alarm.id)}
                  onEdit={() => openForm(alarm)}
                  onDismiss={() => dismiss(alarm.id)}
                  onRearm={onRearm}
                  onDeleted={onDeleted}
                />
              ))}
            </div>
          )}
        </ScreenSection>
      </PopoverContent>
    </Popover>
  )
}
