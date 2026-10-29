import { FolderGit2Icon, FolderGitIcon } from 'lucide-react'
import { IconBrandBitbucket, IconBrandGithub, IconBrandGitlab } from '@tabler/icons-react'
import type { ComponentType } from 'react'
import type { RepositoryRemote } from '../../../shared/model'

type HeaderIcon = ComponentType<{ 'aria-hidden'?: boolean; className?: string }>

// Issue #646: three-way host classification. A known host gets its brand mark, any other remote
// (or one this reader could not classify) keeps the generic remote icon, and a confirmed `none`
// keeps the local-only icon.
const BRAND_ICONS: Record<string, HeaderIcon> = {
  'github.com': IconBrandGithub,
  'gitlab.com': IconBrandGitlab,
  'bitbucket.org': IconBrandBitbucket
}

export function remoteHeaderIcon(remote: RepositoryRemote | undefined): HeaderIcon {
  if (remote?.kind === 'none') return FolderGitIcon
  if (remote?.kind === 'has') return BRAND_ICONS[remote.host] ?? FolderGit2Icon
  return FolderGit2Icon
}

// Issue #503: "owner/repo" when the remote is on github.com (the only host `gh` filing supports), else undefined.
export function githubRemoteSlug(remote: RepositoryRemote | undefined): string | undefined {
  if (remote?.kind !== 'has' || remote.host !== 'github.com') return undefined
  return remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : undefined
}

// A host without a dot is a literal `url.<base>.insteadOf` alias (git config's raw URL is never
// rewritten), so naming it as a host would be a false claim; only a dotted host is shown.
export function remoteHeaderTooltip(remote: RepositoryRemote | undefined): string {
  if (remote?.kind === 'has') {
    if (!remote.host.includes('.')) return 'Git repository, has a remote'
    const path = remote.owner && remote.repo ? `${remote.host}/${remote.owner}/${remote.repo}` : remote.host
    return `Git repository, remote: ${path}`
  }
  if (remote?.kind === 'none') return 'Git repository, local only (no remote)'
  return 'Git repository'
}
