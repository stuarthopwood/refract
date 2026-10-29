// Git decoration (spec 036, #768): the status -> `--git-*` token map the File explorer paints on a
// row's name and icon, plus the folder rollup. The trailing status icon and its screen-reader word
// stay (colour is never the only signal); `GitChangesFileRow.tsx` reuses `STATUS_MARKS` unchanged.
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  EyeOffIcon,
  FilePlus2Icon,
  FileX2Icon,
  PencilIcon,
  type LucideIcon
} from 'lucide-react'
import type { GitStatusMap, GitStatusMark } from '../../../../shared/model'

export interface StatusMark {
  Icon: LucideIcon
  /** Tailwind text colour class from the `--git-*` token for this mark. */
  className: string
  label: string
}

export const STATUS_MARKS: Record<GitStatusMark, StatusMark> = {
  modified: { Icon: PencilIcon, className: 'text-git-modified', label: 'Modified' },
  added: { Icon: FilePlus2Icon, className: 'text-git-added', label: 'Added' },
  untracked: { Icon: CircleDashedIcon, className: 'text-git-untracked', label: 'Untracked' },
  deleted: { Icon: FileX2Icon, className: 'text-git-deleted', label: 'Deleted' },
  ignored: { Icon: EyeOffIcon, className: 'text-git-ignored', label: 'Ignored' },
  renamed: { Icon: ArrowRightLeftIcon, className: 'text-git-renamed', label: 'Renamed' },
  conflicted: { Icon: AlertCircleIcon, className: 'text-git-conflicted', label: 'Conflicted' },
  staged: { Icon: CheckCircle2Icon, className: 'text-git-staged', label: 'Staged' }
}

/** Most significant first. `ignored` never rolls up into a parent folder. */
const ROLLUP_PRECEDENCE: GitStatusMark[] = ['conflicted', 'deleted', 'modified', 'staged', 'renamed', 'added', 'untracked']

const ROLLUP_RANK = new Map<GitStatusMark, number>(ROLLUP_PRECEDENCE.map((mark, index) => [mark, index]))

/** Folder path (relative, POSIX) -> the most significant mark among its descendants. One pass over
 * the whole-worktree `GitStatusMap`; memoise on the map reference. */
export function buildFolderRollup(statusMap: GitStatusMap): Map<string, GitStatusMark> {
  const rollup = new Map<string, GitStatusMark>()
  for (const [path, mark] of Object.entries(statusMap)) {
    const rank = ROLLUP_RANK.get(mark)
    if (rank === undefined) continue
    let end = path.lastIndexOf('/')
    while (end > 0) {
      const folder = path.slice(0, end)
      const current = rollup.get(folder)
      if (current !== undefined && (ROLLUP_RANK.get(current) ?? Infinity) <= rank) break
      rollup.set(folder, mark)
      end = folder.lastIndexOf('/')
    }
  }
  return rollup
}
