import { forwardRef } from 'react'
import type { ComponentProps } from 'react'
import { BotIcon, UserIcon } from 'lucide-react'
import { Virtuoso, type ItemProps } from 'react-virtuoso'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'
import { MATCH_CAP } from './findMatcher'
import type { FlatMatch } from './useChatFind'

const ROW_HEIGHT_PX = 48
const MAX_LIST_HEIGHT_PX = 192

const ResultsList = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function ResultsList(props, ref) {
  return <div ref={ref} role="list" aria-label="Search results" {...props} />
})

function ResultsItem({ item: _item, ...rest }: ItemProps<FlatMatch>) {
  return <div role="listitem" {...rest} />
}

const LIST_COMPONENTS = { List: ResultsList, Item: ResultsItem }

export function FindResultsList({ matches, cursor, capped, onSelect }: { matches: readonly FlatMatch[]; cursor: number; capped: boolean; onSelect(index: number): void }) {
  if (matches.length === 0) return null
  return (
    <div className="border-t">
      <Virtuoso
        style={{ height: Math.min(matches.length * ROW_HEIGHT_PX, MAX_LIST_HEIGHT_PX) }}
        className="max-h-[max(3rem,calc(100dvh-32rem))]"
        data={matches as FlatMatch[]}
        fixedItemHeight={ROW_HEIGHT_PX}
        components={LIST_COMPONENTS}
        computeItemKey={(index, match) => `${match.id}#${match.ordinal}`}
        itemContent={(index, match) => {
          const current = index === cursor
          const Icon = match.kind === 'user' ? UserIcon : BotIcon
          return (
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              onClick={() => onSelect(index)}
              className={cn(
                'flex h-12 w-full flex-col items-start justify-center gap-1 border-s-2 border-transparent px-2 text-start text-compact hover:bg-muted',
                current && 'border-ring bg-muted',
                COMPOSER_BUTTON_FOCUS_CLASS
              )}
            >
              <span className="flex items-center gap-1 text-muted-foreground">
                <Icon className="size-3" aria-hidden />
                {match.kind === 'user' ? 'You' : 'Agent'}
                <span aria-hidden>·</span>
                Turn {match.turnIndex + 1}
              </span>
              <span className="w-full truncate">
                {match.snippet.before}
                <mark className="bg-find-match rounded-sm font-semibold text-inherit underline decoration-1 underline-offset-2">{match.snippet.match}</mark>
                {match.snippet.after}
              </span>
            </button>
          )
        }}
      />
      {capped && (
        <p className="border-t px-2 py-1 text-compact text-muted-foreground">
          More than {MATCH_CAP} matches, narrow the search
        </p>
      )}
    </div>
  )
}
