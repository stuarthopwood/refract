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
// Always visible, never hover-only (quality-gate round 2): issue #524's own acceptance
// criterion -- "Visible without hover (keyboard and touch users must see it)" -- overrides the
// #474 icon-only bundle's general allowance for a hover/keyboard-focus reveal.
const COPIED_RESET_MS = 1500

// Strips C0 control characters (except tab/newline/CR, which are legitimate code-text bytes)
// and DEL from the copied value before it reaches the clipboard (security review, PR #597):
// agent-written tool output and fence content are attacker-influenceable (prompt injection, a
// malicious repo's command output), and an invisible escape sequence or bracketed-paste
// terminator copied verbatim could break out of a terminal's bracketed paste on later use
// ("pastejacking"). The visible transcript text is unaffected; only the clipboard write is
// sanitised.
function sanitiseForClipboard(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
}

export interface CopyButtonProps {
  /** Computed lazily on click so a caller never has to keep a second "full" copy of large or
   * truncated content around just for this button to read (e.g. a tool Output capped at 200
   * visible lines still copies its full value). Must return plain text, never markup. */
  getText: () => string
  /** Accessible name and tooltip text while idle, verb first, sentence case (e.g. "Copy code,
   * typescript", "Copy diff", "Copy pasted text"). Swapped for "Copied" for `COPIED_RESET_MS`
   * after a successful copy, so the tooltip text and `aria-label` always match (WCAG 2.5.3). */
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
  // Quality-gate remediation (Medium): a block can unmount mid-copy (a tool row collapses, a
  // streaming Mermaid fence swaps to its rendered image) while the clipboard write is still
  // pending; without this guard `setCopied`/`announcePolite` would run on an unmounted
  // component and the reset timer below would never be cleared. Mirrors
  // `OmpProvidersSection.tsx`'s own `mountedRef` guard for the same shape of async handler.
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    return () => {
      mountedRef.current = false
      window.clearTimeout(resetRef.current)
    }
  }, [])

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    // The button always sits beside, never inside, the scrollable/selectable region it copies
    // from, but stopPropagation keeps a click here purely this control's own action regardless.
    event.stopPropagation()
    const text = sanitiseForClipboard(getText())
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // The sandboxed renderer denies every Clipboard API permission
      // (`session.setPermissionRequestHandler`, src/main/index.ts), so this falls back to main's
      // own allowlisted channel -- the same try/catch order as `useWorktreeActions.ts`'s `copyPath`.
      const result = await window.refract.clipboard.writeText(text)
      if (!mountedRef.current) return
      if (!result.ok) {
        notify(result.error)
        announceAssertive("Could not copy")
        return
      }
    }
    if (!mountedRef.current) return
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
