// Hand-rolled radiogroup (roving tabindex): arrows and Home/End both move focus and live-preview.
// Not migrated to ui/radio-group.tsx, whose Home/End only move focus (#498).
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { ThemeSwatchChip } from '@/components/ui/theme-swatch-chip'
import { cn } from '@/lib/utils'
import { useActiveThemeId, useThemeStore } from '@/state'
import { THEMES } from '../../../shared/themes'
import type { ThemeId } from '../../../shared/themes'

const THEME_LIST = Object.values(THEMES)

interface ThemePickerProps {
  /** Ids of the heading and hint rendered in AppearanceSection. */
  labelledBy: string
  describedBy: string
}

export function ThemePicker({ labelledBy, describedBy }: ThemePickerProps) {
  const activeId = useActiveThemeId()
  const preview = useThemeStore((state) => state.preview)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Choosing the active entry is a no-op so `preview` doesn't round-trip over IPC for nothing.
  function choose(id: ThemeId) {
    if (id === activeId) return
    preview(id)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = Math.min(index + 1, THEME_LIST.length - 1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = THEME_LIST.length - 1
    if (nextIndex === null) return
    const nextTheme = THEME_LIST[nextIndex]
    if (!nextTheme) return
    event.preventDefault()
    choose(nextTheme.id)
    buttonRefs.current[nextIndex]?.focus()
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex max-w-sm flex-col gap-1">
      {THEME_LIST.map((theme, index) => {
        const isActive = theme.id === activeId
        return (
          <button
            key={theme.id}
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-state={isActive ? 'checked' : 'unchecked'}
            aria-labelledby={`theme-option-${theme.id}-name`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => choose(theme.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'group/radio-item flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <span aria-hidden className={RADIO_RING_CLASS}>
              {isActive && <span className={RADIO_DOT_CLASS} />}
            </span>
            <span id={`theme-option-${theme.id}-name`} className="min-w-0 flex-1 truncate">{theme.name}</span>
            <ThemeSwatchChip swatch={theme.swatch} swatchPrimary={theme.swatchPrimary} />
          </button>
        )
      })}
    </div>
  )
}
