// One Settings > Advanced row: picks the control for the key's kind, shows the description,
// "Default: X" only when the value differs, and a Reset button that is always there but disabled at\r\n// the default (so the control never jumps). A dependent row
// (`info.dependsOn` off) stays visible, indented, with every control disabled, and says why.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings/SettingRow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { COMPACTION_METHODS } from '../../../../shared/tokenGuard'
import type { TokenGuardKeyInfo, TokenGuardValue } from '../../../../shared/tokenGuard'
import { MethodOrderChecklist } from './MethodOrderChecklist'
import { formatCount, NumberUnitField } from './NumberUnitField'
import { PerModelThresholdTable } from './PerModelThresholdTable'
import { RadioSettingRow } from './RadioSettingRow'

interface AdvancedRowProps {
  info: TokenGuardKeyInfo
  value: TokenGuardValue | undefined
  defaultValue: TokenGuardValue | undefined
  /** Set while the row's controlling toggle is off. */
  disabledReason?: string
  /** Token count a new per-model entry starts with. */
  fallbackTokens: number
  onChange: (value: unknown) => Promise<boolean>
  onReset: () => Promise<void>
}

const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): string =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(Object.entries(v).sort()) : JSON.stringify(v)
  return norm(a) === norm(b)
}

function describeDefault(info: TokenGuardKeyInfo, def: TokenGuardValue | undefined): string {
  if (typeof def === 'number') return `${formatCount(def)} ${info.unit ?? ''}`.trim()
  if (typeof def === 'boolean') return def ? 'on' : 'off'
  if (typeof def === 'string') return info.options?.find((o) => o.value === def)?.label ?? def
  if (Array.isArray(def)) return def.map((m) => COMPACTION_METHODS.find((c) => c.value === m)?.label ?? m).join(', ')
  if (def) return `${Object.keys(def).length} models`
  return 'none'
}

// The first control to focus after Reset (the Reset button itself is skipped).
const FIRST_CONTROL = 'input:not(:disabled), [role="switch"], [role="radio"][aria-checked="true"], [role="checkbox"], button:not([data-reset]):not(:disabled)'

export function AdvancedRow({ info, value, defaultValue, disabledReason, fallbackTokens, onChange, onReset }: AdvancedRowProps) {
  const id = `advanced-${info.key}`
  const isDefault = same(value, defaultValue)
  const disabled = disabledReason !== undefined
  const rowRef = useRef<HTMLDivElement>(null)
  const describedBy = [`${id}-description`, disabled ? `${id}-reason` : undefined].filter(Boolean).join(' ')
  const stacked = info.kind === 'order' || info.kind === 'record'

  const description: ReactNode = (
    <>
      {info.description}
      {!isDefault && <> Default: {describeDefault(info, defaultValue)}.</>}
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
  const note = disabled ? (
    <span id={`${id}-reason`} className="text-xs text-muted-foreground">
      {disabledReason}
    </span>
  ) : undefined

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
      control = (
        <NumberUnitField
          id={id}
          value={typeof value === 'number' ? value : 0}
          unit={info.unit ?? ''}
          labelId={`${id}-label`}
          describedBy={describedBy}
          disabled={disabled}
          onCommit={onChange}
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
          value={value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}}
          fallbackTokens={fallbackTokens}
          disabled={disabled}
          describedBy={describedBy}
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
        labelAddon={stacked ? reset : undefined}
      >
        {stacked ? (
          control
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {control}
            {reset}
          </div>
        )}
      </SettingRow>
    )
  }

  return (
    <div ref={rowRef} className={info.dependsOn ? 'pl-6' : undefined}>
      {row}
    </div>
  )
}