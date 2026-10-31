import { ExternalLinkIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'

/** The Issue and Pull request headers' Open on GitHub: a real anchor so it opens in the system browser (#1132). */
export function OpenOnGitHubButton({ url }: { url: string }) {
  return (
    <IconButton asChild label="Open on GitHub (opens in browser)" className={COMPOSER_BUTTON_FOCUS_CLASS}>
      <a href={url} target="_blank" rel="noreferrer noopener" data-open-on-github>
        <ExternalLinkIcon aria-hidden className="size-4" />
      </a>
    </IconButton>
  )
}
