// The Settings section list (wave 2, spec 035 FR-003): one flat, task-based list with a leading icon
// per item from the nav map below, `aria-current` on the active item, and the shared selected-row
// treatment (`ActiveIndicatorBar`, #1122).
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import type { SettingIcon } from '@/components/settings/SettingRow'
import { cn } from '@/lib/utils'
import {
  BrainIcon,
  LayersIcon,
  MessageSquareIcon,
  PaletteIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SlidersHorizontalIcon
} from 'lucide-react'
import type { SettingsSectionId } from '../../state/view-store'

interface SettingsSectionDescriptor {
  id: SettingsSectionId
  label: string
  icon: SettingIcon
}

export const SETTINGS_SECTIONS: SettingsSectionDescriptor[] = [
  { id: 'appearance', label: 'Appearance', icon: PaletteIcon },
  { id: 'chat', label: 'Chat', icon: MessageSquareIcon },
  { id: 'status-line', label: 'Status line', icon: PanelBottomIcon },
  { id: 'models', label: 'Models', icon: BrainIcon },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontalIcon },
  { id: 'sessions', label: 'Sessions', icon: LayersIcon },
  { id: 'panels', label: 'Panels', icon: PanelRightIcon }
]

interface SettingsNavProps {
  active: SettingsSectionId
  onSelect: (section: SettingsSectionId) => void
}

export function SettingsNav({ active, onSelect }: SettingsNavProps) {
  return (
    <nav aria-label="Settings sections" className="w-48 shrink-0 overflow-y-auto bg-card p-2">
      <ul className="flex flex-col gap-1">
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon
          const isActive = section.id === active
          return (
            <li key={section.id}>
              <button
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelect(section.id)}
                // Issue #1122: `relative` anchors the shared bar below; `data-choice-item` joins the
                // square-choice selector (globals.css), which overrides this button's own
                // `rounded-md`. `bg-clip-padding` keeps the fill flush with the bar (gate round 1).
                data-choice-item
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-md border border-transparent bg-clip-padding px-2 py-1 text-left text-sm outline-none',
                  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                  // Forced colours strips the box-shadow ring and the transparent border, so draw a
                  // real outline there (same pattern as SessionList.tsx's Clear filter).
                  'forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-[-2px]',
                  isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                {isActive && <ActiveIndicatorBar />}
                <Icon aria-hidden className="size-4 shrink-0" />
                {section.label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
