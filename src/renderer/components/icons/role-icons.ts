// The one role-icon map (#717), imported by Settings > Models. Muted tone, `aria-hidden`, never
// coloured: the four switcher roles' colour is a separate swatch (foundations-icons.md "role
// identity"). A role missing here (for example a freshly added one) simply shows no icon.
import {
  ChartColumnIcon,
  EyeIcon,
  FeatherIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  MapIcon,
  MicIcon,
  ScaleIcon,
  ScanEyeIcon,
  StarIcon,
  TurtleIcon,
  UsersIcon,
  Volume2Icon,
  ZapIcon
} from 'lucide-react'
import type { SettingIcon } from '@/components/settings/SettingRow'
import type { ModelRoleId } from '../../../shared/model'

export const ROLE_ICONS: Partial<Record<ModelRoleId, SettingIcon>> = {
  default: StarIcon,
  smol: FeatherIcon,
  slow: TurtleIcon,
  vision: EyeIcon,
  plan: MapIcon,
  commit: GitCommitHorizontalIcon,
  tiny: ZapIcon,
  memory: HistoryIcon,
  widget: ChartColumnIcon,
  task: UsersIcon,
  advisor: ScanEyeIcon,
  image: ImageIcon,
  web: GlobeIcon,
  speech: Volume2Icon,
  dictation: MicIcon,
  judge: ScaleIcon
}
