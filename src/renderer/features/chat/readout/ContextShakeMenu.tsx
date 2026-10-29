// Spec 052 (issue #506): the Context usage readout's shake menu. Shake is OMP's local, inline
// context reduction, sent as the typed prompts `/shake`, `/shake thinking` and `/shake images`
// (FINDINGS item 12). OMP's own `command_output` notice in the transcript is the visible result;
// this menu only announces that the shake started. Thinking and images are not recoverable, so
// they confirm first; elide keeps `artifact://` references and does not.
import { Fragment, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { BrainIcon, ImageIcon, ScissorsIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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

/** Wraps the Context readout (`children`, a `ReadoutItem`) as the menu trigger. */
export function ContextShakeMenu({ sessionId, figure, children }: { sessionId: string; figure: string | null; children: ReactNode }) {
  const idle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'idle')
  const [confirming, setConfirming] = useState<ShakeAction | null>(null)

  function run(action: ShakeAction): void {
    // Re-read the live status: the Session can turn busy while the confirmation is open.
    if (useSessionsStore.getState().sessions.find((x) => x.id === sessionId)?.status !== 'idle') return
    useDraftStore.getState().announceAttachment(sessionId, `Shaking ${action.id}`)
    void window.refract.chat
      .send(sessionId, action.command)
      .then((result) => {
        if (!result.ok) notify(result.error)
      })
      .catch((err: unknown) => notify({ code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) }))
  }

  function handleSelect(action: ShakeAction): void {
    if (!idle) return
    if (action.loss) setConfirming(action)
    else run(action)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
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
                <DropdownMenuItem aria-disabled={!idle} aria-describedby={idle ? undefined : IDLE_REASON_ID} onSelect={() => handleSelect(action)} className={idle ? undefined : 'opacity-50'}>
                  <Icon aria-hidden className="size-4" />
                  <div className="flex flex-col gap-1 py-1">
                    <span>{action.label}</span>
                    <span className="text-xs text-muted-foreground">{action.hint}</span>
                  </div>
                </DropdownMenuItem>
              </Fragment>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.label}?</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.loss}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => confirming && run(confirming)}>
              {confirming?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
