// Spec 036 (#842): Settings > Appearance > Text size. Three independent scales (App, Chat, Code),
// four presets that set all three at once, per-role Reset and Reset all. Changes apply live (the
// typography store writes the CSS variables) and are saved after a short pause; no Save step.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { SELECTED_SEGMENT_CLASS, ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingRow } from '@/components/settings/SettingRow'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { TYPOGRAPHY_ROLES, useTypographyStore } from '@/state/typography-store'
import type { TypographyRole } from '@/state/typography-store'
import { DEFAULT_TYPOGRAPHY } from '../../../shared/typography'
import { ScaleControl, scaleToPercent } from './ScaleControl'

const PRESETS = [
  { value: '90', label: 'Small' },
  { value: '100', label: 'Default' },
  { value: '115', label: 'Large' },
  { value: '130', label: 'Larger' }
] as const

const ROLE_ROWS: Record<TypographyRole, { label: string; description: string; fontClass: string; preview: string }> = {
  app: {
    label: 'App',
    description: 'Menus, lists, headers, dialogs and these settings.',
    fontClass: 'font-ui',
    preview: 'Sessions, repositories and settings read like this.'
  },
  chat: {
    label: 'Chat',
    description: 'The conversation text in the transcript.',
    fontClass: 'font-ui',
    preview: 'The agent’s reply reads like this in the transcript.'
  },
  code: {
    label: 'Code',
    description: 'Code blocks, inline code, tool output, diffs, file headers and the message box.',
    fontClass: 'font-code',
    preview: 'const answer = 42 // code reads like this'
  }
}

const SCALE_KEY = { app: 'appScale', chat: 'chatScale', code: 'codeScale' } as const

export function TextSizeGroup() {
  const typography = useTypographyStore((state) => state.typography)
  const setRole = useTypographyStore((state) => state.setRole)
  const setAll = useTypographyStore((state) => state.setAll)
  const [announcement, announce] = useClearedAnnouncement()
  const firstRender = useRef(true)

  const percents = TYPOGRAPHY_ROLES.map((role) => scaleToPercent(typography[SCALE_KEY[role]]))
  const [appPercent = 100, chatPercent = 100, codePercent = 100] = percents
  const allAtDefault = percents.every((percent) => percent === 100)
  const sharedPercent = appPercent === chatPercent && chatPercent === codePercent ? String(appPercent) : ''

  // One polite announcement after the values settle, never one per slider step.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const timer = setTimeout(() => {
      announce(`Text size: App ${appPercent} percent, Chat ${chatPercent} percent, Code ${codePercent} percent.`)
    }, 600)
    return () => clearTimeout(timer)
  }, [appPercent, chatPercent, codePercent, announce])

  return (
    <SettingsGroup
      title="Text size"
      headingId="text-size-heading"
      descriptionId="text-size-hint"
      description="Applies immediately. Scales text only, not spacing or icons. Windows’ own Text size setting is not read, so set it here."
    >
      <SettingRow id="text-size-presets" label="Presets" labelAsText>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={sharedPercent}
            onValueChange={(value) => {
              const percent = Number(value)
              if (!value || !Number.isFinite(percent)) return
              const scale = percent / 100
              setAll({ appScale: scale, chatScale: scale, codeScale: scale })
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-labelledby="text-size-presets-label"
          >
            {PRESETS.map((preset) => (
              <ToggleGroupItem key={preset.value} value={preset.value} className={SELECTED_SEGMENT_CLASS}>
                {preset.label} · {preset.value}%
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            variant="outline"
            size="sm"
            aria-disabled={allAtDefault || undefined}
            className={allAtDefault ? 'opacity-50' : undefined}
            onClick={() => {
              if (!allAtDefault) setAll(DEFAULT_TYPOGRAPHY)
            }}
          >
            Reset all
          </Button>
        </div>
      </SettingRow>
      {TYPOGRAPHY_ROLES.map((role) => (
        <ScaleControl
          key={role}
          id={`text-size-${role}`}
          role={ROLE_ROWS[role].label}
          description={ROLE_ROWS[role].description}
          scale={typography[SCALE_KEY[role]]}
          onScaleChange={(scale) => setRole(role, scale)}
          fontClass={ROLE_ROWS[role].fontClass}
          preview={ROLE_ROWS[role].preview}
        />
      ))}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </SettingsGroup>
  )
}
