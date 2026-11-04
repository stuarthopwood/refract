import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ClampedContent } from '@/components/ClampedContent'
import { ShimmerText } from '@/components/ShimmerText'

/** Left padding that aligns row content under the label column. */
export const LABEL_COLUMN_CONTENT_CLASS = 'pl-8'

/** Props for {@link CollapsedLine}. */
export interface CollapsedLineProps {
  labelShimmer?: boolean
  /** Optional decoration rendered before the icon slot (an advisory row's `SourceTag`, #1041). */
  leading?: React.ReactNode
  icon: React.ReactNode
  iconTooltip?: string
  label?: React.ReactNode
  /** One-line summary that truncates with an ellipsis; omit for a line with nothing to summarise. */
  summary?: React.ReactNode
  /** Right-aligned status/duration slot. */
  meta?: React.ReactNode
  metaClassName?: string
  /** Overrides the summary's default `text-muted-foreground` (e.g. a notice tinted by level). */
  summaryClassName?: string
  summaryFixedWidth?: boolean
  labelClassName?: string
  summaryWrap?: boolean
  wrapWhenOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  triggerAriaLabel?: string
  action?: React.ReactNode
  detail?: React.ReactNode
  hideDetailWhenOpen?: boolean
  children?: React.ReactNode
  id?: string
  className?: string
  contentClassName?: string
  /** Extra classes for the header trigger button, e.g. to drop its hover fill inside a card. */
  triggerClassName?: string
  clampLines?: number
}

/** Single-line transcript row that expands to show its detail. */
export const CollapsedLine = React.forwardRef<HTMLElement, CollapsedLineProps>(function CollapsedLine(
  {
    leading,
    labelShimmer,
    icon,
    iconTooltip,
    label,
    summary,
    meta,
    metaClassName,
    summaryClassName,
    summaryFixedWidth,
    labelClassName,
    summaryWrap,
    wrapWhenOpen,
    open,
    onOpenChange,
    defaultOpen,
    triggerAriaLabel,
    action,
    detail,
    hideDetailWhenOpen,
    children,
    className,
    contentClassName,
    triggerClassName,
    clampLines,
    id
  },
  ref
) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const actualOpen = isControlled ? open : uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const detailId = React.useId()
  const detailMounted = detail !== undefined
  const detailVisuallyHidden = hideDetailWhenOpen && actualOpen
  const showDetail = detailMounted && !detailVisuallyHidden
  const inlineWrap = summary !== undefined && !summaryFixedWidth && (summaryWrap || (wrapWhenOpen && actualOpen))
  const [tooltipHovered, setTooltipHovered] = React.useState(false)
  const [rowFocusVisible, setRowFocusVisible] = React.useState(false)
  const [tooltipDismissed, setTooltipDismissed] = React.useState(false)
  const [tooltipArmed, setTooltipArmed] = React.useState(false)
  const tooltipOpen = iconTooltip !== undefined && !tooltipDismissed && (tooltipHovered || rowFocusVisible)
  const focusHandlers =
    iconTooltip === undefined
      ? undefined
      : {
          onFocus: (e: React.FocusEvent<HTMLElement>) => {
            if (e.target !== e.currentTarget) return
            setTooltipArmed(true)
            setTooltipDismissed(false)
            setRowFocusVisible(e.currentTarget.matches(':focus-visible'))
          },
          onBlur: (e: React.FocusEvent<HTMLElement>) => {
            if (e.target === e.currentTarget) setRowFocusVisible(false)
          }
        }

  const row = (
    <>
      {leading !== undefined && <span className="flex h-5 shrink-0 items-center">{leading}</span>}
      {iconTooltip === undefined ? (
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      ) : !tooltipArmed ? (
        <span
          aria-hidden="true"
          className="flex h-5 w-4 shrink-0 items-center justify-center"
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') return
            setTooltipArmed(true)
            setTooltipDismissed(false)
            setTooltipHovered(true)
          }}
        >
          {icon}
        </span>
      ) : (
        <Tooltip
          open={tooltipOpen}
          onOpenChange={(next) => {
            if (next) setTooltipDismissed(false)
            setTooltipHovered(next)
          }}
        >
          <TooltipTrigger asChild>
            <span aria-hidden="true" className="flex h-5 w-4 shrink-0 items-center justify-center">
              {icon}
            </span>
          </TooltipTrigger>
          <TooltipContent
            onEscapeKeyDown={() => {
              setTooltipDismissed(true)
              setTooltipHovered(false)
            }}
          >
            {iconTooltip}
          </TooltipContent>
        </Tooltip>
      )}
      {inlineWrap ? (
        // Label and summary flow as one paragraph so wrapped lines restart at the label's left edge.
        <span data-summary-wrap="" className="group/summary min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
          {label !== undefined && (
            <span data-slot="collapsed-line-label" className={cn('mr-2 text-foreground', labelClassName)}>
              {labelShimmer ? <ShimmerText active>{label}</ShimmerText> : label}
            </span>
          )}
          <span className={summaryClassName ?? 'text-muted-foreground'}>{summary}</span>
        </span>
      ) : (
        <>
          {label !== undefined && (
            <span data-slot="collapsed-line-label" className={cn('min-w-0 max-w-full truncate text-foreground', labelClassName)} title={typeof label === 'string' ? label : undefined}>
              {labelShimmer ? <ShimmerText active>{label}</ShimmerText> : label}
            </span>
          )}
          {summary !== undefined ? (
            <>
              <span
                className={cn(
                  'group/summary',
                  summaryFixedWidth ? 'min-w-0 shrink max-w-[40%] truncate' : 'min-w-0 flex-1',
                  summaryWrap || (wrapWhenOpen && actualOpen) ? '[overflow-wrap:anywhere] whitespace-normal' : 'truncate',
                  summaryClassName ?? 'text-muted-foreground'
                )}
                title={summaryFixedWidth && typeof summary === 'string' ? summary : undefined}
              >
                {summary}
              </span>
              {summaryFixedWidth && (
                <span className="min-w-0 flex-1" />
              )}
            </>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
        </>
      )}
      {meta !== undefined && (
        <span className={cn('shrink-0 text-xs leading-5 text-muted-foreground tabular-nums', metaClassName)}>
          <span className="sr-only">, </span>
          {meta}
        </span>
      )}
    </>
  )

  if (children === undefined) {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        id={id}
        tabIndex={-1}
        {...focusHandlers}
        className={cn('-ml-2 flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring', className)}
      >
        {row}
      </div>
    )
  }

  return (
    <Collapsible open={actualOpen} onOpenChange={setOpen} className={cn('-ml-2', className)}>
      <div className="flex items-start gap-1">
        <CollapsibleTrigger
          ref={ref as React.Ref<HTMLButtonElement>}
          id={id}
          aria-label={triggerAriaLabel}
          aria-describedby={showDetail ? detailId : undefined}
          {...focusHandlers}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
            triggerClassName
          )}
        >
          {row}
          <span className="flex h-5 shrink-0 items-center">
            <ChevronRightIcon className={cn('size-4 text-muted-foreground transition-transform', actualOpen && 'rotate-90')} />
          </span>
        </CollapsibleTrigger>
        {action}
      </div>
      {detailMounted && (
        <p
          id={detailId}
          dir="auto"
          hidden={detailVisuallyHidden}
          className={cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2 line-clamp-2 text-left text-xs text-severity-error [overflow-wrap:anywhere]')}
        >
          {detail}
        </p>
      )}
      <CollapsibleContent className={cn('space-y-2 px-2 pb-2 pt-1', contentClassName)}>
        {clampLines !== undefined ? <ClampedContent maxHeight={`${clampLines}lh`} fade>{children}</ClampedContent> : children}
      </CollapsibleContent>
    </Collapsible>
  )
})
