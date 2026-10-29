// The one readout-kind-to-icon map (#717): imported by the Status line chips (`ReadoutChips.tsx`)
// and by Settings > Status line, so a readout wears the same glyph in both places. Turn time and
// Current time deliberately do not share a glyph.
import { ActivityIcon, ClockIcon, FileDiffIcon, GaugeIcon, GitPullRequestIcon, ListTodoIcon, TimerIcon, UsersIcon } from 'lucide-react'
import type { SettingIcon } from '@/components/settings/SettingRow'
import type { ReadoutKind } from '../../../shared/model'

export const READOUT_KIND_ICONS: Record<ReadoutKind, SettingIcon> = {
  changes: FileDiffIcon,
  'context-usage': GaugeIcon,
  'turn-time': TimerIcon,
  'current-time': ClockIcon,
  'pull-request': GitPullRequestIcon,
  subagents: UsersIcon,
  'todo-progress': ListTodoIcon,
  'current-work': ActivityIcon
}
