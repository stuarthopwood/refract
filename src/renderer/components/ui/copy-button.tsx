import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClearedAnnouncement } from "@/lib/use-cleared-announcement"
import { sanitiseForClipboard } from "@/lib/clipboard-sanitise"
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
  // Quality-gate remediation (High, cycle 2): a block can unmount mid-copy (a tool row
  // collapses, a streaming Mermaid fence swaps to its rendered image) while the clipboard write
  // is still pending; without this guard `setCopied`/`announcePolite` would run on an unmounted
  // component and the reset timer below would never be cleared. Mirrors
  // `OmpProvidersSection.tsx`'s own `mountedRef` guard for the same shape of async handler --
  // including its `mountedRef.current = true` at the top of the effect: `<StrictMode>`
  // (main.tsx) mounts, unmounts and remounts every component once in development, and without
  // resetting the flag back to `true` on that remount, the cleanup's `false` is never undone,
  // silently skipping every post-await "Copied", announcement and failure toast in `pnpm dev`
  // for the rest of the component's life (cycle 2 finding: production builds were unaffected,
  // which is why the round-1 live verification never caught it).
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
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
    // Quality-gate remediation (Medium, cycle 2): a block composed entirely of characters the
    // sanitiser strips (vanishingly rare, but possible for agent-authored content) must not
    // silently empty the user's clipboard or announce a success that didn't happen.
    if (text === "") return
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
