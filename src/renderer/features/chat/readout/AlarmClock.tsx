import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BellIcon } from 'lucide-react'
import { READOUT_KIND_ICONS } from '@/components/icons/readout-icons'
import { ListCardButton } from '@/components/ListCardButton'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSettingsStore } from '@/state'
import { notifyAlarmDeleted, setAlarmListOpen } from '@/state/notify'
import { MAX_ALARMS, MAX_ALARM_LABEL_CHARS } from '../../../../shared/model'
import type { Alarm } from '../../../../shared/model'
import { ReadoutItem } from './ReadoutItem'

const DAY_MS = 86_400_000
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
  const [time, setTime] = useState(() => toInputTime(editing?.fireAtMs ?? now + 60_000))
  const [label, setLabel] = useState(editing?.label ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const fireAtMs = time ? nextOccurrence(time, now) : null
  const showTomorrow = fireAtMs !== null && isTomorrow(fireAtMs, now)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    // Not `disabled` while saving: a disabled Save would drop keyboard focus.
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
        <label htmlFor={timeId} className="text-sm font-medium">
          Time
        </label>
        <Input
          id={timeId}
          type="time"
          required
          autoFocus
          value={time}
          aria-describedby={showTomorrow ? hintId : undefined}
          onChange={(e) => setTime(e.target.value)}
        />
        {showTomorrow && (
          <p id={hintId} className="text-xs text-muted-foreground">
            Tomorrow
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={labelId} className="text-sm font-medium">
          Label
        </label>
        <Input id={labelId} maxLength={MAX_ALARM_LABEL_CHARS} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" />
      </div>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          Could not save the alarm. Try again.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={saving || undefined} disabled={fireAtMs === null}>
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
  onDeleted: (alarm: Alarm) => void
}

function AlarmRow({ alarm, now, highlighted, onEdit, onDeleted }: AlarmRowProps) {
  const deleteAlarm = useSettingsStore((s) => s.deleteAlarm)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const time = timeFormat.format(alarm.fireAtMs)
  const name = alarm.label ? `${time} ${alarm.label}` : time
  const hint = !alarm.active ? 'Fired' : isTomorrow(alarm.fireAtMs, now) ? 'Tomorrow' : null
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  return (
    <div ref={rowRef}>
      <ListCardButton
        ariaLabel={`Edit alarm ${name}${hint ? `, ${hint}` : ''}`}
        onClick={onEdit}
        highlighted={highlighted}
        actions={
          <Button
            type="button"
            variant="ghost-destructive"
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
  const prevActive = useRef<Set<string>>(new Set())
  const [firedIds, setFiredIds] = useState<ReadonlySet<string>>(new Set())
  const nowMs = now.getTime()
  const armed = alarms.filter((a) => a.active).length
  const full = alarms.length >= MAX_ALARMS
  const sorted = [...alarms].sort((a, b) => Number(b.active) - Number(a.active) || a.fireAtMs - b.fireAtMs)
  const name = armed > 0 ? `Current time ${formatted}, ${armed} ${armed === 1 ? 'alarm' : 'alarms'} set. Open alarms` : `Current time ${formatted}. Open alarms`
  // The focused control unmounts on save, cancel and delete; park focus on a visible control so keyboard users keep their place.
  const parkFocus = () =>
    requestAnimationFrame(() => {
      const root = contentRef.current
      const target = root?.querySelector<HTMLElement>('[data-alarm-add]:not(:disabled)') ?? root?.querySelector<HTMLElement>('button[aria-label^="Edit alarm"]')
      ;(target ?? root)?.focus()
    })

  const changeOpen = (next: boolean) => {
    setOpen(next)
    setAlarmListOpen(next)
    if (!next) {
      setForm(null)
      setFiredIds(new Set())
    }
  }
  // The module flag outlives this component, so clear it if the chip is hidden while open.
  useEffect(() => () => setAlarmListOpen(false), [])

  // An armed alarm turning inactive is a fire; mark its row so it is noticed in the open list.
  useEffect(() => {
    const active = new Set(alarms.filter((a) => a.active).map((a) => a.id))
    const fired = alarms.filter((a) => !a.active && prevActive.current.has(a.id)).map((a) => a.id)
    prevActive.current = active
    if (open && fired.length > 0) setFiredIds((prev) => new Set([...prev, ...fired]))
  }, [alarms, open])

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
          {armed > 0 && (
            <span aria-hidden className="inline-flex items-center gap-1">
              <BellIcon className="size-4" />
              <span className="tabular-nums">{armed}</span>
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
              <Button type="button" size="sm" variant="outline" data-alarm-add="" disabled={full} onClick={() => setForm({ editing: null })}>
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
          {!form && (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {sorted.map((alarm) => (
                <AlarmRow
                  key={alarm.id}
                  alarm={alarm}
                  now={nowMs}
                  highlighted={firedIds.has(alarm.id)}
                  onEdit={() => setForm({ editing: alarm })}
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
