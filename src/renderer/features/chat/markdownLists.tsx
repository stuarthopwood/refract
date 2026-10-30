import * as React from 'react'
import type { ExtraProps } from 'react-markdown'
import { cn } from '@/lib/utils'

// Named components (not inline arrows) so the `li` renderer in Markdown.tsx can identify children by function identity.
export function Paragraph({ className, ...props }: React.ComponentProps<'p'> & ExtraProps) {
  return <p className={className} {...props} />
}
// `contains-task-list` (remark-gfm) drops the bullet so the checkbox sits where it would be.
export function UnorderedList({ className, ...props }: React.ComponentProps<'ul'> & ExtraProps) {
  return (
    <ul
      className={cn(
        typeof className === 'string' && className.includes('contains-task-list')
          ? 'list-none space-y-1 pl-0'
          : 'list-disc pl-4 marker:text-md-marker',
        className
      )}
      {...props}
    />
  )
}
export function OrderedList({ className, ...props }: React.ComponentProps<'ol'> & ExtraProps) {
  return <ol className={cn('list-decimal pl-4 marker:text-md-marker', className)} {...props} />
}
export function TaskCheckbox({ className, ...props }: React.ComponentProps<'input'> & ExtraProps) {
  return <input className={cn('mr-1 align-middle accent-primary', className)} {...props} />
}

// Gives the checkbox `aria-labelledby` pointing at an id'd <span> wrapping its text, instead of a <label> wrapper.
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

// Labels only the item's own leading content, not nested sub-lists: <label> allows phrasing content only,
// and a parent's name must not swallow its descendants' text.
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
