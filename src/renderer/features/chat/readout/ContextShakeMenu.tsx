// Spec 052 (issue #506): the Context usage readout's shake menu. Shake is OMP's local, inline
// context reduction, sent as the typed prompts `/shake`, `/shake thinking` and `/shake images`
// (FINDINGS item 12). OMP's own `command_output` notice in the transcript is the visible result;
// this menu only announces that the shake started. Thinking and images are not recoverable, so
// they confirm first; elide keeps `artifact://` references and does not.
import { Fragment, useRef, useState } from 'react'
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { BrainIcon, ExternalLinkIcon, ImageIcon, ScissorsIcon } from 'lucide-react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SUSPECT_WINDOW_ISSUE_URL, SUSPECT_WINDOW_LINK_LABEL } from '@/lib/suspectContextWindow'
import { notify, useDraftStore, useSessionsStore } from '@/state'

interface ShakeAction {
  id: 'context' | 'thinking' | 'images'
  label: string
  command: string
  hint: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  /** What is lost, naming the confirmation; absent when the action is recoverable. */
  loss?: string
}

const SHAKE_ACTIONS: ShakeAction[] = [
  { id: 'context', label: 'Shake context', command: '/shake', hint: 'Shortens old tool output; the agent can reopen it.', icon: ScissorsIcon },
  {
    id: 'thinking',
    label: 'Shake thinking',
    command: '/shake thinking',
    hint: "Removes past reasoning. Can't be undone.",
    icon: BrainIcon,
    loss: "The agent's earlier reasoning blocks are removed from this conversation. This can't be undone."
  },
  {
    id: 'images',
    label: 'Shake images',
    command: '/shake images',
    hint: "Removes attached images. Can't be undone.",
    icon: ImageIcon,
    loss: "Every image attached earlier in this conversation is removed. This can't be undone."
  }
]

const IDLE_REASON_ID = 'context-shake-idle-reason'

/** Wraps the Context readout (`children`, a `ReadoutItem`) as the menu trigger. A `notice` adds a tooltip and an upstream-issue link, because a tooltip cannot hold a clickable link. */
export function ContextShakeMenu({ sessionId, figure, notice, children }: { sessionId: string; figure: string | null; notice?: string; children: ReactNode }) {
  const idle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'idle')
  const [confirming, setConfirming] = useState<ShakeAction | null>(null)
  // Keeps the last action's text on screen while the dialog animates closed.
  const [shown, setShown] = useState<ShakeAction | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [tipOpen, setTipOpen] = useState(false)
  // Returning focus after the dialog must not pop the tooltip open.
  const suppressTipRef = useRef(false)
  // Right-click, Shift+F10 and the Menu key open the same menu as a left click.
  const openOnContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault()
    setMenuOpen(true)
  }

  function run(action: ShakeAction): void {
    // Re-read the live status: the Session can turn busy while the confirmation is open.
    if (useSessionsStore.getState().sessions.find((x) => x.id === sessionId)?.status !== 'idle') {
      useDraftStore.getState().announceAttachment(sessionId, `${action.label} did not run: the session is busy.`)
      return
    }
    useDraftStore.getState().announceAttachment(sessionId, `${action.label}...`)
    void window.refract.chat
      .send(sessionId, action.command)
      .then((result) => {
        if (!result.ok) notify(result.error)
      })
      .catch((err: unknown) => notify({ code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) }))
  }

  function handleSelect(action: ShakeAction, event: Event): void {
    if (!idle) {
      event.preventDefault()
      return
    }
    if (action.loss) {
      setShown(action)
      setConfirming(action)
    } else run(action)
  }

  return (
    <>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip open={Boolean(notice) && tipOpen} onOpenChange={(next) => !suppressTipRef.current && setTipOpen(next)}>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <DropdownMenuTrigger asChild ref={triggerRef} onContextMenu={openOnContextMenu}>{children}</DropdownMenuTrigger>
          </TooltipTrigger>
          {notice && <TooltipContent className="max-w-80">{notice}</TooltipContent>}
        </Tooltip>
        <DropdownMenuContent align="start" side="top">
          {figure && <DropdownMenuLabel className="text-foreground">{figure}</DropdownMenuLabel>}
          {!idle && (
            <DropdownMenuLabel id={IDLE_REASON_ID} className="font-normal">
              Available when the session is idle
            </DropdownMenuLabel>
          )}
          {SHAKE_ACTIONS.map((action) => {
            const Icon = action.icon
            return (
              <Fragment key={action.id}>
                {action.id === 'thinking' && <DropdownMenuSeparator />}
                <DropdownMenuItem aria-disabled={!idle} aria-describedby={idle ? undefined : IDLE_REASON_ID} onSelect={(event) => handleSelect(action, event)} className="aria-disabled:cursor-default aria-disabled:forced-colors:text-[GrayText]">
                  <Icon aria-hidden className={cn('size-4', !idle && 'opacity-50')} />
                  <div className={cn('flex flex-col gap-1 py-1', !idle && 'opacity-50')}>
                    <span>{action.label}</span>
                    <span className="text-xs text-muted-foreground">{action.hint}</span>
                  </div>
                </DropdownMenuItem>
              </Fragment>
            )
          })}
          {notice && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={SUSPECT_WINDOW_ISSUE_URL} target="_blank" rel="noreferrer noopener">
                  <ExternalLinkIcon aria-hidden className="size-4" />
                  {SUSPECT_WINDOW_LINK_LABEL}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAlertDialog
        open={confirming !== null}
        busy={false}
        tone="destructive"
        title={`${shown?.label ?? 'Shake'}?`}
        description={shown?.loss}
        confirmLabel={shown?.label ?? 'Shake'}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) run(confirming)
          setConfirming(null)
        }}
        onCloseAutoFocus={() => {
          suppressTipRef.current = true
          triggerRef.current?.focus()
          suppressTipRef.current = false
        }}
      />
    </>
  )
}
