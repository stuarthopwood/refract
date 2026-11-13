import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { GhStackNotice } from '@/components/GhStackNotice'
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { useSettingsStore } from '@/state'
import { useGhStackStore } from '@/state/gh-stack-store'
import type { MergeMethod } from '../../../shared/github'
import type { StackPosition } from '../../../shared/stack-chain'
import { mergeDialogStack, mergeInputFor, mergeLayersText, stackFeatureOn } from './stack-view'

/** Props for {@link MergeDialog}. */
export interface MergeDialogProps {
  repositoryId: string
  number: number
  title: string
  headSha: string
  headBranch: string
  /** Where the pull request sits in a stack, from chaining; `null` when it has no neighbour. */
  stack: StackPosition | null
  allowedMergeMethods: MergeMethod[]
  open: boolean
  onOpenChange(open: boolean): void
  onMerged(): void
  restoreFocusTo: RefObject<HTMLButtonElement | null>
  restoreFocusFallbackTo: RefObject<HTMLElement | null>
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

const METHOD_DESCRIPTION: Record<MergeMethod, string> = {
  merge: 'Keeps every commit and adds a merge commit.',
  squash: 'Combines every commit into a single commit.',
  rebase: 'Replays every commit onto the base branch.'
}

/** Dialog to choose a merge method and merge a pull request. */
export function MergeDialog({
  repositoryId,
  number,
  title,
  headSha,
  headBranch,
  stack,
  allowedMergeMethods,
  open,
  onOpenChange,
  onMerged,
  restoreFocusTo,
  restoreFocusFallbackTo
}: MergeDialogProps) {
  const [method, setMethod] = useState<MergeMethod>(allowedMergeMethods[0] ?? 'merge')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settingOn = useSettingsStore((s) => s.settings.stackedPullRequests !== false)
  const ghState = useGhStackStore((s) => s.state)
  const stackView = mergeDialogStack(settingOn, ghState, stack)
  const expectedHeadShaRef = useRef(headSha)
  useEffect(() => {
    if (open) expectedHeadShaRef.current = headSha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const succeededRef = useRef(false)

  async function handleMerge(): Promise<void> {
    setSubmitting(true)
    setError(null)
    // Read at click time, not render time: the toggle or the extension may have changed since the dialog opened.
    const featureOn = stackFeatureOn(
      useSettingsStore.getState().settings.stackedPullRequests !== false,
      useGhStackStore.getState().state
    )
    const result = await window.refract.pullRequests.merge(
      repositoryId,
      number,
      mergeInputFor({ method, expectedHeadSha: expectedHeadShaRef.current, headBranch }, stack, featureOn)
    )
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    succeededRef.current = true
    onOpenChange(false)
    onMerged()
  }

  return (
    <ConfirmAlertDialog
      open={open}
      busy={submitting}
      size="md"
      title={`Merge ${title}?`}
      description="Choose a merge method, then confirm."
      confirmLabel={error ? 'Retry' : 'Merge'}
      busyLabel="Merging…"
      error={error}
      onCancel={() => {
        setError(null)
        onOpenChange(false)
      }}
      onConfirm={() => void handleMerge()}
      onCloseAutoFocus={() => {
        const button = restoreFocusTo.current
        if (succeededRef.current) {
          succeededRef.current = false
          restoreFocusFallbackTo.current?.focus()
          return
        }
        if (button && !button.disabled) button.focus()
        else restoreFocusFallbackTo.current?.focus()
      }}
    >
      <RadioGroup
        aria-label="Merge method"
        value={method}
        onValueChange={(value) => {
          if (submitting) return
          setMethod(value as MergeMethod)
          setError(null)
        }}
      >
        {allowedMergeMethods.map((candidate) => {
          const labelId = `merge-method-${candidate}-label`
          const descriptionId = `merge-method-${candidate}-description`
          return (
            <RadioGroupItem
              key={candidate}
              value={candidate}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-disabled={submitting}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <span aria-hidden className={RADIO_RING_CLASS}>
                  <RadioGroupIndicator />
                </span>
                <span id={labelId} className="min-w-0 flex-1 break-words">{METHOD_LABEL[candidate]}</span>
              </span>
              <span id={descriptionId} className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">
                {METHOD_DESCRIPTION[candidate]}
              </span>
            </RadioGroupItem>
          )
        })}
      </RadioGroup>
      {stackView === 'install' && <GhStackNotice layout="callout" />}
      {stackView === 'layers' && stack && (
        <p data-merge-layers className="text-xs text-muted-foreground">
          {mergeLayersText(stack)}
        </p>
      )}
    </ConfirmAlertDialog>
  )
}
