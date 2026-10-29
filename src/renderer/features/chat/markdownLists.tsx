import * as React from 'react'
import type { ExtraProps } from 'react-markdown'
import { cn } from '@/lib/utils'

// Named (rather than inline arrows) so the `li` task-list-item renderer in Markdown.tsx can recognize a
// direct child as "a nested paragraph wrapper (loose lists)" / "a nested sub-list" / "the
// checkbox itself" by function identity -- the only reliable signal available once react-markdown
// has already turned those nodes into opaque React elements typed by these very components.
export function Paragraph({ className, ...props }: React.ComponentProps<'p'> & ExtraProps) {
  return <p className={className} {...props} />
}
// `contains-task-list` (added by remark-gfm's tasklist handling) drops the bullet marker and
// tightens spacing so the checkbox sits where the bullet would; an ordinary list keeps the
// existing disc/decimal marker.
export function UnorderedList({ className, ...props }: React.ComponentProps<'ul'> & ExtraProps) {
  return (
    <ul
      className={cn(
        typeof className === 'string' && className.includes('contains-task-list')
          ? 'list-none space-y-1 pl-0'
          : 'list-disc pl-4',
        className
      )}
      {...props}
    />
  )
}
export function OrderedList({ className, ...props }: React.ComponentProps<'ol'> & ExtraProps) {
  return <ol className={cn('list-decimal pl-4', className)} {...props} />
}
// Task-list checkboxes (GFM): rehype-sanitize's default (GitHub-style) schema already allows
// `input[type=checkbox][disabled]` and `li.task-list-item` (hast-util-sanitize
// lib/schema.js), so no schema extension was needed for T065; this only themes the checkbox.
export function TaskCheckbox({ className, ...props }: React.ComponentProps<'input'> & ExtraProps) {
  return <input className={cn('mr-1 align-middle accent-primary', className)} {...props} />
}

// Clones the task-list-item's checkbox (always its first real child, per remark-gfm) with
// `aria-labelledby`, and wraps everything after it in an id'd <span> so that id has something to
// point at -- giving the checkbox an accessible name without a <label> wrapper (see `li` in Markdown.tsx).
function labelTaskCheckbox(children: React.ReactNode, labelId: string): React.ReactNode[] {
  const nodes = React.Children.toArray(children)
  const checkboxIndex = nodes.findIndex((node) => React.isValidElement(node) && node.type === TaskCheckbox)
  if (checkboxIndex === -1) return nodes
  const checkbox = nodes[checkboxIndex] as React.ReactElement<{ 'aria-labelledby'?: string }>
  return [
    ...nodes.slice(0, checkboxIndex),
    React.cloneElement(checkbox, { 'aria-labelledby': labelId }),
    <span key="task-list-item-label" id={labelId}>
      {nodes.slice(checkboxIndex + 1)}
    </span>
  ]
}

// Labels only a `task-list-item` <li>'s OWN leading content (its checkbox + its own text), never
// its subtree: a loose list wraps that own content in a <p> (handled by recursing into just that
// paragraph's children), and either loose or tight, a sub-task-list nested under this item is its
// own sequence of `task-list-item` <li>s that will each run through this same renderer again, with
// their own id. Excluding both is required for valid HTML -- <label>'s content model is phrasing
// content only, so a wrapping <label> around a nested <p> or <ul> was already invalid before
// nesting is even considered -- and for a correct accessible name -- a parent checkbox's name must
// not swallow every descendant item's text too.
export function renderTaskListItemChildren(children: React.ReactNode, labelId: string): React.ReactNode {
  const nodes = React.Children.toArray(children)
  const looseIndex = nodes.findIndex((node) => React.isValidElement(node) && node.type === Paragraph)
  if (looseIndex !== -1) {
    const paragraph = nodes[looseIndex] as React.ReactElement<{ children?: React.ReactNode }>
    const relabelled = <Paragraph key={paragraph.key ?? 'p'}>{labelTaskCheckbox(paragraph.props.children, labelId)}</Paragraph>
    return [...nodes.slice(0, looseIndex), relabelled, ...nodes.slice(looseIndex + 1)]
  }
  const blockIndex = nodes.findIndex(
    (node) => React.isValidElement(node) && (node.type === UnorderedList || node.type === OrderedList)
  )
  if (blockIndex === -1) return labelTaskCheckbox(nodes, labelId)
  return [...labelTaskCheckbox(nodes.slice(0, blockIndex), labelId), ...nodes.slice(blockIndex)]
}
