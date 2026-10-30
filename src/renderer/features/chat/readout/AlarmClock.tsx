import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { BellIcon } from 'lucide-react'
import { READOUT_KIND_ICONS } from '@/components/icons/readout-icons'
import { ListCardButton } from '@/components/ListCardButton'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { CountBadge } from '@/components/ui/count-badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSettingsStore } from '@/state'
import type { Alarm } from '../../../../shared/model'
import { ReadoutItem } from './ReadoutItem'

const MAX_ALARMS = 20
const MAX_LABEL_CHARS = 80
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
  const [time, setTime] = useState(() => toInputTime(editing?.fireAtMs ?? now))
  const [label, setLabel] = useState(editing?.label ?? '')
  const [saving, setSaving] = useState(false)
  const fireAtMs = time ? nextOccurrence(time, now) : null

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (fireAtMs === null) return
    setSaving(true)
    const ok = await upsertAlarm({ id: editing?.id ?? crypto.randomUUID(), label: label.trim(), fireAtMs, active: true })
    setSaving(false)
    if (ok) onDone()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={timeId} className="text-sm font-medium">
          Time
        </label>
        <Input id={timeId} type="time" required autoFocus value={time} onChange={(e) => setTime(e.target.value)} />
        {fireAtMs !== null && isTomorrow(fireAtMs, now) && <p className="text-xs text-muted-foreground">Tomorrow</p>}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={labelId} className="text-sm font-medium">
          Label
        </label>
        <Input id={labelId} maxLength={MAX_LABEL_CHARS} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || fireAtMs === null}>
          Save
        </Button>
      </div>
    </form>
  )
}

function AlarmRow({ alarm, now, onEdit }: { alarm: Alarm; now: number; onEdit: () => void }) {
  const deleteAlarm = useSettingsStore((s) => s.deleteAlarm)
  const time = timeFormat.format(alarm.fireAtMs)
  const name = alarm.label ? `${time} ${alarm.label}` : time
  const hint = !alarm.active ? 'Fired' : isTomorrow(alarm.fireAtMs, now) ? 'Tomorrow' : null
  return (
    <ListCardButton
      ariaLabel={`Edit alarm ${name}${hint ? `, ${hint}` : ''}`}
      onClick={onEdit}
      className={alarm.active ? undefined : 'opacity-70'}
      actions={
        <Button type="button" size="sm" variant="ghost-destructive" aria-label={`Delete alarm ${name}`} onClick={() => void deleteAlarm(alarm.id)}>
          Delete
        </Button>
      }
    >
      <span className="font-medium tabular-nums">{time}</span>
      {alarm.label && <span className="truncate text-muted-foreground">{alarm.label}</span>}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </ListCardButton>
  )
}

/** The composer clock: its readout opens a Popover that lists, adds, edits and deletes Alarms (#1426). */
export function AlarmClock({ formatted, now, className }: { formatted: string; now: Date; className?: string }) {
  const alarms = useSettingsStore((s) => s.settings.alarms) ?? NO_ALARMS
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<{ editing: Alarm | null } | null>(null)
  const nowMs = now.getTime()
  const armed = alarms.filter((a) => a.active).length
  const sorted = [...alarms].sort((a, b) => Number(b.active) - Number(a.active) || a.fireAtMs - b.fireAtMs)
  const name = armed > 0 ? `Current time ${formatted}, ${armed} ${armed === 1 ? 'alarm' : 'alarms'} set. Open alarms` : `Current time ${formatted}. Open alarms`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setForm(null)
      }}
    >
      <PopoverAnchor asChild>
        <ReadoutItem
          icon={READOUT_KIND_ICONS['current-time']}
          className={className}
          accessibleName={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          onActivate={() => setOpen((v) => !v)}
        >
          <span aria-hidden>{formatted}</span>
          {armed > 0 && (
            <span aria-hidden className="relative inline-flex">
              <BellIcon className="size-4" />
              <CountBadge value={armed} />
            </span>
          )}
        </ReadoutItem>
      </PopoverAnchor>
      <PopoverContent side="top" align="end" collisionPadding={8} className="w-80 p-4" aria-label="Alarms">
        <ScreenSection
          title="Alarms"
          count={alarms.length}
          empty={alarms.length === 0 && !form ? 'No alarms set' : null}
          actions={
            !form && (
              <Button type="button" size="sm" variant="outline" disabled={alarms.length >= MAX_ALARMS} onClick={() => setForm({ editing: null })}>
                Add alarm
              </Button>
            )
          }
        >
          {form && <AlarmForm key={form.editing?.id ?? 'new'} editing={form.editing} now={nowMs} onDone={() => setForm(null)} />}
          {!form && (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {sorted.map((alarm) => (
                <AlarmRow key={alarm.id} alarm={alarm} now={nowMs} onEdit={() => setForm({ editing: alarm })} />
              ))}
            </div>
          )}
        </ScreenSection>
      </PopoverContent>
    </Popover>
  )
}
