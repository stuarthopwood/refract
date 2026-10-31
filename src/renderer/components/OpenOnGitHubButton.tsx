import { ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'

/** The Issue and Pull request headers' Open on GitHub: a real anchor so it opens in the system browser (#1132). */
export function OpenOnGitHubButton({ url }: { url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button asChild variant="ghost" size="icon-sm" aria-label="Open on GitHub (opens in browser)" className={COMPOSER_BUTTON_FOCUS_CLASS}>
          <a href={url} target="_blank" rel="noreferrer noopener" data-open-on-github>
            <ExternalLinkIcon aria-hidden className="size-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open on GitHub</TooltipContent>
    </Tooltip>
  )
}
