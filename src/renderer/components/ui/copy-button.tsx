import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClearedAnnouncement } from "@/lib/use-cleared-announcement"
import { notify } from "@/state"

// Shared icon-only Copy control (#524): every code surface -- markdown fences, mermaid source,
// tool Arguments/Output, write previews, subagent Prompt/Result, approval details (all via
// `CodeBlockHeader`, Markdown.tsx), edit/PR diffs (DiffView.tsx), and the pasted-text preview
// (TextPreviewModal.tsx) -- renders exactly this component so the click handler, clipboard
// fallback, "Copied" check-state, and live-region announcement never drift between call sites.
const COPIED_RESET_MS = 1500

export interface CopyButtonProps {
  /** Computed lazily on click so a caller never has to keep a second "full" copy of large or
   * truncated content around just for this button to read (e.g. a tool Output capped at 200
   * visible lines still copies its full value). Must return plain text, never markup. */
  getText: () => string
  /** Accessible name and tooltip text while idle, verb first, sentence case (e.g. "Copy code",
   * "Copy diff", "Copy pasted text"). Swapped for "Copied" for `COPIED_RESET_MS` after a
   * successful copy, so the tooltip text and `aria-label` always match (WCAG 2.5.3). */
  label: string
  /** Polite live-region text announced on success (e.g. "Code copied", "Diff copied"). */
  announcement: string
  className?: string
}

export function CopyButton({ getText, label, announcement, className }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()
  const resetRef = React.useRef<number | undefined>(undefined)

  React.useEffect(() => {
    return () => {
      window.clearTimeout(resetRef.current)
    }
  }, [])

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    // The button always sits beside, never inside, the scrollable/selectable region it copies
    // from, but stopPropagation keeps a click here purely this control's own action regardless.
    event.stopPropagation()
    const text = getText()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // The sandboxed renderer denies every Clipboard API permission
      // (`session.setPermissionRequestHandler`, src/main/index.ts), so this falls back to main's
      // own allowlisted channel -- the same try/catch order as `useWorktreeActions.ts`'s `copyPath`.
      const result = await window.refract.clipboard.writeText(text)
      if (!result.ok) {
        notify(result.error)
        announceAssertive("Could not copy")
        return
      }
    }
    setCopied(true)
    announcePolite(announcement)
    window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
  }

  const name = copied ? "Copied" : label

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={name}
            onClick={(event) => void handleCopy(event)}
            className={cn("shrink-0", className)}
          >
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </span>
      <span aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </span>
    </>
  )
}
