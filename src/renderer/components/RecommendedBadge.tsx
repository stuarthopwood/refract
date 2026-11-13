import { StarIcon } from 'lucide-react'

/** The visible recommendation cue: an icon plus text, so it never relies on the row's tint; the screen-reader text is separate. */
export function RecommendedBadge() {
  return (
    <>
      <span className="sr-only">, Recommended</span>
      <span aria-hidden data-recommended-badge className="ml-2 inline-flex items-center gap-1 align-middle text-xs font-medium text-severity-success">
        <StarIcon className="size-3 fill-current" />
        Recommended
      </span>
    </>
  )
}
