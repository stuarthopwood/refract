// Inline row actions for a File explorer tree row (spec 035, #756): Open in VS Code, Reveal in File
// Explorer and Copy path as ghost icon buttons between the name/status mark and the kebab. They
// are mouse shortcuts only (`tabIndex={-1}`, grill 2026-10-29): the keyboard route stays the
// kebab menu and Shift+F10. How many show follows the TREE's width, via a container query on the
// `@container` tree element: below 300px none; 300-380px Open in VS Code + Copy path; above
// 380px all three.
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { CheckIcon, Code2Icon, CopyIcon, FolderOpenIcon, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'

const COPIED_RESET_MS = 1500

interface TreeRowActionsProps {
  selected: boolean
  onOpenInVSCode: () => void
  onReveal: () => void
  /** Resolves `true` when the path reached the clipboard. */
  onCopyPath: () => Promise<boolean>
}

export function TreeRowActions({ selected, onOpenInVSCode, onReveal, onCopyPath }: TreeRowActionsProps) {
  const [copied, setCopied] = useState(false)
  const [announcement, announce] = useClearedAnnouncement()
  const resetRef = useRef<number>(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.clearTimeout(resetRef.current)
    }
  }, [])

  async function handleCopy(): Promise<void> {
    const ok = await onCopyPath()
    if (!ok || !mountedRef.current) return
    setCopied(true)
    announce('Path copied')
    window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
  }

  // Same reveal as the kebab: hover, focus-within or selected.
  const reveal = `shrink-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${selected ? 'opacity-100' : 'opacity-0'}`

  function renderButton(
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
    visibility: string
  ) {
    return (
      <Tooltip>
        <TooltipTrigger asChild aria-describedby={undefined}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={label}
            className={`${reveal} ${visibility}`}
            // The whole row carries `onClick`; a click here must not also select/open/toggle it.
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              onClick()
            }}
          >
            <Icon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      {renderButton('Open in VS Code', Code2Icon, onOpenInVSCode, 'hidden @min-[300px]:inline-flex')}
      {renderButton('Reveal in File Explorer', FolderOpenIcon, onReveal, 'hidden @min-[381px]:inline-flex')}
      {renderButton(copied ? 'Copied' : 'Copy path', copied ? CheckIcon : CopyIcon, () => void handleCopy(), 'hidden @min-[300px]:inline-flex')}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
