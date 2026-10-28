// Spec 007 US2: a keyboard-operable theme picker (FR-001, FR-002, FR-006) -- hand-rolled
// `role="radiogroup"`/`role="radio"` using the classic roving-tabindex pattern: only the
// currently-active entry sits in the Tab order, and arrow/Home/End keys move both focus and the
// live preview together, matching how a native `<input type="radio">` list already behaves
// (arrowing IS choosing, not just moving focus). Every preset renders in `THEMES`' own
// declaration order (FR-001).
// Quality-gate remediation (code-reviewer, Medium, issue #498, cycle 2): a `components/ui/
// radio-group.tsx` primitive now exists (built for `MergeDialog.tsx`), but this picker is NOT
// migrated to it -- that primitive's Home/End only move focus (Space selects), while this
// picker's Home/End also live-previews immediately, same as its arrow keys; migrating would be a
// user-visible behaviour change outside #498/#500's scope. Left as a follow-up.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useActiveThemeId, useThemeStore } from '@/state'
import { THEMES } from '../../../shared/themes'
import type { ThemeId } from '../../../shared/themes'

const THEME_LIST = Object.values(THEMES)

interface ThemePickerProps {
  /** Issue #554 gate round 2 (L1): the group's accessible name/description now come from
   * `AppearanceSection.tsx`'s own heading and hint `<p>`, matching `ChatWidthPicker`'s group --
   * a bare `aria-label="Theme"` string duplicated the heading text instead of pointing at it. */
  labelledBy: string
  describedBy: string
}

export function ThemePicker({ labelledBy, describedBy }: ThemePickerProps) {
  const activeId = useActiveThemeId()
  const preview = useThemeStore((state) => state.preview)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  // FR-002/FR-006 deviation note (2a): choosing the already-active entry is a deliberate no-op
  // -- it never re-fires `preview` (which would otherwise round-trip over IPC for nothing).
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
    <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col gap-1">
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
            aria-labelledby={`theme-option-${theme.id}-name`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => choose(theme.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-4 shrink-0 rounded-full border border-border',
                isActive && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
              )}
              style={{ backgroundColor: theme.swatch }}
            />
            <span id={`theme-option-${theme.id}-name`} className="flex-1">{theme.name}</span>
            {isActive && (
              <span aria-hidden className="flex items-center gap-1 text-xs">
                <CheckIcon aria-hidden className="size-4" />
                <span>Current</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
