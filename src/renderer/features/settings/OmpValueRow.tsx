import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import type { TokenGuardKeyInfo, TokenGuardValue } from '../../../shared/tokenGuard'

// One "Set by Refract" row of Settings > OMP: a typed control plus a per-row reset to default.
interface OmpValueRowProps {
  info: TokenGuardKeyInfo
  value: TokenGuardValue | undefined
  defaultValue: TokenGuardValue | undefined
  onChange: (value: unknown) => void
  onReset: () => void
}

function toText(value: TokenGuardValue | undefined): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
  }
  return value === undefined ? '' : String(value)
}

// Returns undefined when the text does not parse for the row's kind (the row keeps its text and
// the value is not saved).
function parseText(kind: TokenGuardKeyInfo['kind'], text: string): unknown {
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean)
  if (kind === 'count') {
    const n = Number(text.trim())
    return text.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : undefined
  }
  if (kind === 'list') return parts
  if (kind === 'record') {
    const record: Record<string, number> = {}
    for (const part of parts) {
      const [name, raw, ...rest] = part.split('=').map((piece) => piece.trim())
      const n = Number(raw)
      if (!name || rest.length > 0 || raw === '' || !Number.isInteger(n) || n < 0) return undefined
      record[name] = n
    }
    return record
  }
  return text.trim()
}

export function OmpValueRow({ info, value, defaultValue, onChange, onReset }: OmpValueRowProps) {
  const id = `omp-${info.key}`
  const text = toText(value)
  const [draft, setDraft] = useState(text)
  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue)

  useEffect(() => setDraft(text), [text])

  const resetButton = (
    <Button variant="ghost" size="sm" disabled={isDefault} aria-label={`Reset ${info.label} to default`} onClick={onReset}>
      Reset to default
    </Button>
  )

  if (info.kind === 'toggle') {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SettingSwitchRow
            id={id}
            label={info.label}
            description={`Set by Refract. Default: ${defaultValue === true ? 'on' : 'off'}.`}
            checked={value === true}
            onCheckedChange={onChange}
          />
        </div>
        {resetButton}
      </div>
    )
  }

  const invalid = parseText(info.kind, draft) === undefined
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {info.label}
        </label>
        <span id={`${id}-description`} className="text-xs text-muted-foreground">
          {`Set by Refract. Default: ${toText(defaultValue) || 'none'}.`}
          {info.kind === 'record' ? ' Format: model=tokens, model=tokens.' : ''}
          {info.kind === 'list' ? ' Comma-separated.' : ''}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id={id}
          className="w-72"
          aria-describedby={`${id}-description`}
          aria-invalid={invalid}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const parsed = parseText(info.kind, draft)
            if (parsed !== undefined && draft !== text) onChange(parsed)
          }}
        />
        {resetButton}
      </div>
    </div>
  )
}
