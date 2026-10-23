import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingFieldRow } from '@/components/SettingFieldRow'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import type { TokenGuardKeyInfo, TokenGuardValue } from '../../../shared/tokenGuard'

const FORMAT_HINT: Partial<Record<TokenGuardKeyInfo['kind'], string>> = {
  count: 'Whole number, 0 or more.',
  record: 'Format: model=tokens, model=tokens.',
  list: 'Comma-separated.'
}

const ERROR_TEXT: Partial<Record<TokenGuardKeyInfo['kind'], string>> = {
  count: 'Enter a whole number, 0 or more.',
  record: 'Enter model=tokens pairs separated by commas, tokens a whole number, 0 or more.',
  list: 'Enter a comma-separated list.'
}

// One "Set by Refract" row of Settings > OMP: a typed control plus a per-row reset to default.
interface OmpValueRowProps {
  info: TokenGuardKeyInfo
  value: TokenGuardValue | undefined
  defaultValue: TokenGuardValue | undefined
  onChange: (value: unknown) => void | Promise<boolean>
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
  const inputRef = useRef<HTMLInputElement>(null)
  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue)

  useEffect(() => setDraft(text), [text])

  // aria-disabled keeps the button focusable, so the guard lives in the handler.
  const resetButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-disabled={isDefault}
      aria-label={`Reset ${info.label} to default`}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={() => {
        if (isDefault) return
        onReset()
        inputRef.current?.focus()
      }}
    >
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
  const showError = invalid && draft !== text
  const errorId = `${id}-error`
  const commit = (): void => {
    const parsed = parseText(info.kind, draft)
    if (parsed === undefined || draft === text) return
    void Promise.resolve(onChange(parsed)).then((ok) => {
      if (ok === false) setDraft(text)
    })
  }
  return (
    <SettingFieldRow
      id={id}
      label={info.label}
      description={`Set by Refract. Default: ${toText(defaultValue) || 'none'}. ${FORMAT_HINT[info.kind] ?? ''}`.trim()}
      note={
        showError ? (
          <span id={errorId} className="text-xs text-destructive">
            {ERROR_TEXT[info.kind] ?? 'Enter a valid value.'}
          </span>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          id={id}
          className="w-72 min-w-0 flex-1"
          aria-describedby={showError ? `${id}-description ${errorId}` : `${id}-description`}
          aria-invalid={invalid}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          onBlur={commit}
        />
        {resetButton}
      </div>
    </SettingFieldRow>
  )
}
