import * as React from "react"
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { COMPOSER_BUTTON_FOCUS_CLASS } from "@/components/ui/composerFocus"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClearedAnnouncement } from "@/lib/use-cleared-announcement"
import { sanitiseForClipboard } from "@/lib/clipboard-sanitise"
import { copyDecision, clipboardRejectionToResult } from "@/lib/clipboard-copy-decision"
import { notify } from "@/state"
import type { Result } from "../../../shared/ipc"

const COPIED_RESET_MS = 1500

export interface CopyButtonProps {
  getText?: () => string
  onCopy?: () => Promise<boolean>
  label: string
  announcement: string
  className?: string
  tabIndex?: number
  disabled?: boolean
  icon?: LucideIcon
  /** Shows `label` as visible text on an outline button; the accessible name is then the visible text. */
  showLabel?: boolean
}

export function CopyButton({ getText, onCopy, label, announcement, className, tabIndex, disabled, icon: Icon = CopyIcon, showLabel = false }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()
  const resetRef = React.useRef<number | undefined>(undefined)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.clearTimeout(resetRef.current)
    }
  }, [])

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    // stopPropagation keeps a click here from reaching the region this button copies from.
    event.stopPropagation()
    if (onCopy) {
      const ok = await onCopy()
      if (!mountedRef.current) return
      window.clearTimeout(resetRef.current)
      if (!ok) {
        setCopied(false)
        announcePolite("")
        announceAssertive("Could not copy")
        return
      }
      announceAssertive("")
      setCopied(true)
      announcePolite(announcement)
      resetRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
      return
    }
    const decision = copyDecision(sanitiseForClipboard(getText?.() ?? ""))
    if (decision.kind === "nothing") {
      window.clearTimeout(resetRef.current)
      setCopied(false)
      announcePolite("")
      notify({ code: "clipboard-failed", message: "Nothing to copy: this block only contains hidden characters" })
      return
    }
    try {
      await navigator.clipboard.writeText(decision.text)
    } catch {
      let result: Result<void>
      try {
        result = await window.refract.clipboard.writeText(decision.text)
      } catch (err) {
        result = clipboardRejectionToResult(err)
      }
      if (!mountedRef.current) return
      if (!result.ok) {
        window.clearTimeout(resetRef.current)
        setCopied(false)
        announcePolite("")
        notify(result.error)
        announceAssertive("Could not copy")
        return
      }
    }
    if (!mountedRef.current) return
    announceAssertive("")
    setCopied(true)
    announcePolite(announcement)
    window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
  }

  const name = copied ? "Copied" : label

  const icon = copied ? <CheckIcon aria-hidden /> : <Icon aria-hidden />

  return (
    <>
      {showLabel ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          tabIndex={tabIndex}
          disabled={disabled}
          onClick={(event) => void handleCopy(event)}
          className={cn("shrink-0", className)}
        >
          {icon}
          {name}
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={name}
              tabIndex={tabIndex}
              disabled={disabled}
              onClick={(event) => void handleCopy(event)}
              className={cn("shrink-0", COMPOSER_BUTTON_FOCUS_CLASS, className)}
            >
              {icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{name}</TooltipContent>
        </Tooltip>
      )}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </span>
      <span aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </span>
    </>
  )
}
