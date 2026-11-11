// One Settings > Advanced row: picks the control for the key's kind, shows the description,
// "Default: X" only when the value differs, and a Reset button that is always there but disabled at
// the default (so the control never jumps). A dependent row
// (`info.dependsOn` off) stays visible, indented, with every control disabled, and says why.
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ImpactWarning } from '@/components/settings/ImpactWarning'
import { SettingRow } from '@/components/settings/SettingRow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { appliesToNewSessionsOnly } from '../../../../shared/tokenGuard'
import type { TokenGuardKeyInfo, TokenGuardValue } from '../../../../shared/tokenGuard'
import { MAX_PERCENT, MIN_PERCENT, percentToTokens, tokensToPercent } from './contextWindow'
import { MethodOrderChecklist } from './MethodOrderChecklist'
import { formatCount, NumberUnitField, WINDOW_UNKNOWN_HINT } from './NumberUnitField'
import { describeValue, sameValue } from './changedRows'
import { PerModelThresholdTable } from './PerModelThresholdTable'
import { RadioSettingRow } from './RadioSettingRow'

interface AdvancedRowProps {
  info: TokenGuardKeyInfo
  value: TokenGuardValue | undefined
  defaultValue: TokenGuardValue | undefined
  /** Set while the row's controlling toggle is off. */
  disabledReason?: string
  /** True when the open Project's `.omp/config.yml` sets this key; Refract never edits that file. */
  projectOverride?: boolean
  /** Percent a new per-model threshold starts with. */
  seedPercent: number
  /** Context window of the Default role's model; null when unknown. */
  defaultWindow: number | null
  /** True until the model catalogue has loaded, so an unknown window is not reported early. */
  catalogLoading: boolean
  onChange: (value: unknown) => Promise<boolean>
  onReset: () => Promise<void>
}

// The first control to focus after Reset (the Reset button itself is skipped).
const FIRST_CONTROL = 'input:not(:disabled), [role="switch"], [role="radio"][aria-checked="true"], [role="checkbox"], button:not([data-reset]):not(:disabled)'

export function AdvancedRow({ info, value, defaultValue, disabledReason, projectOverride, seedPercent, defaultWindow, catalogLoading, onChange, onReset }: AdvancedRowProps) {
  const id = `advanced-${info.key}`
  const isDefault = sameValue(value, defaultValue)
  const disabled = disabledReason !== undefined
  const rowRef = useRef<HTMLDivElement>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const impactId = `${id}-impact`
  const models: Record<string, string | number> = info.kind === 'record' && value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const { impact } = info
  const costlier =
    impact !== undefined &&
    (info.kind === 'record'
      ? Object.values(models).some((percent) => impact.costlierWhen(percent, `${seedPercent}%`))
      : impact.costlierWhen(value, defaultValue))
  // The expanded per-model table warns on its own rows; the summary warning (rendered under the
  // trigger) is only referenced while the table is closed.
  const summaryShown = costlier && !(info.kind === 'record' && tableOpen)
  const newSessionsOnly = appliesToNewSessionsOnly(info.key)
  const noteId = `${id}-status`
  const describedBy = [`${id}-description`, summaryShown ? impactId : undefined, disabled ? `${id}-reason` : undefined, newSessionsOnly ? noteId : undefined, projectOverride ? `${noteId}-project` : undefined].filter(Boolean).join(' ')
  const stacked = info.kind === 'order' || info.kind === 'record'

  const description: ReactNode = (
    <>
      {info.description}
      {info.percentOfWindow && defaultWindow !== null && " The % is of the Default model's context window."}
      {!isDefault && <> Default: {describeValue(info, defaultValue, defaultWindow)}.</>}
    </>
  )
  const reset = (
    <Button
      variant="ghost"
      size="sm"
      data-reset
      disabled={isDefault || disabled}
      aria-label={`Reset ${info.label} to default`}
      onClick={() => {
        void onReset().then(() => requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>(FIRST_CONTROL)?.focus()))
      }}
    >
      Reset
    </Button>
  )
  const statusNotes = (
    <>
      {newSessionsOnly && (
        <span id={noteId} className="text-xs text-muted-foreground">
          Applies to new Sessions
        </span>
      )}
      {projectOverride && (
        <span id={`${noteId}-project`} className="text-xs text-muted-foreground">
          This Project's .omp/config.yml sets this too, so it wins here. Refract does not edit that file.
        </span>
      )}
    </>
  )
  const note = (
    <>
      {info.impact && info.kind !== 'record' && <ImpactWarning id={impactId} text={info.impact.text} active={costlier} />}
      {disabled && (
        <span id={`${id}-reason`} className="text-xs text-muted-foreground">
          {disabledReason}
        </span>
      )}
      {statusNotes}
    </>
  )

  let row: ReactNode
  if (info.kind === 'enum') {
    row = (
      <RadioSettingRow
        id={id}
        label={info.label}
        description={description}
        note={note}
        options={info.options ?? []}
        value={String(value ?? '')}
        actions={reset}
        disabled={disabled}
        describedBy={describedBy}
        onChange={(next) => void onChange(next)}
      />
    )
  } else {
    let control: ReactNode
    if (info.kind === 'toggle') {
      control = (
        <Switch
          id={id}
          aria-describedby={describedBy}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(next) => void onChange(next)}
        />
      )
    } else if (info.kind === 'count') {
      const tokens = typeof value === 'number' ? value : 0
      const percentWindow = info.percentOfWindow ? defaultWindow : null
      const bounded = percentWindow !== null || info.unit === '%'
      control = (
        <NumberUnitField
          id={id}
          value={percentWindow !== null ? tokensToPercent(tokens, percentWindow) : tokens}
          unit={percentWindow !== null ? '%' : (info.unit ?? '')}
          min={bounded ? MIN_PERCENT : undefined}
          max={bounded ? MAX_PERCENT : undefined}
          hint={percentWindow !== null ? `≈ ${formatCount(tokens)} tokens` : info.percentOfWindow && !catalogLoading ? WINDOW_UNKNOWN_HINT : undefined}
          labelId={`${id}-label`}
          describedBy={describedBy}
          disabled={disabled}
          onCommit={percentWindow !== null ? (percent) => onChange(percentToTokens(percent, percentWindow)) : onChange}
        />
      )
    } else if (info.kind === 'order') {
      control = (
        <MethodOrderChecklist
          id={id}
          value={Array.isArray(value) ? value : []}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
        />
      )
    } else {
      control = (
        <PerModelThresholdTable
          id={id}
          value={models}
          impact={info.impact}
          seedPercent={seedPercent}
          disabled={disabled}
          describedBy={describedBy}
          open={tableOpen}
          onOpenChange={setTableOpen}
          onChange={onChange}
        />
      )
    }
    row = (
      <SettingRow
        id={id}
        label={info.label}
        description={description}
        note={note}
        labelAsText={stacked}
        layout={stacked ? 'stacked' : 'inline'}
        disabled={disabled}
      >
        <div className={stacked ? 'flex flex-col gap-2' : 'flex flex-wrap items-center justify-end gap-2'}>
          {control}
          <div className={stacked ? 'flex justify-end' : undefined}>{reset}</div>
        </div>
      </SettingRow>
    )
  }

  return (
    <div ref={rowRef} className={info.dependsOn ? 'pl-6' : undefined}>
      {row}
    </div>
  )
}