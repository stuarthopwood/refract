import { BookPlusIcon, ClipboardPasteIcon, ClipboardTypeIcon, CopyIcon, ScissorsIcon, SpellCheckIcon, TextSelectIcon } from 'lucide-react'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { chordText, findAction, isActionEnabled } from './actionRegistry'

export type MenuKind = 'context' | 'dropdown'

interface ActionMenuItemOptions {
  kind?: MenuKind
  /** Overrides the registry label for this menu. */
  label?: string
  /** Runs the action; defaults to `action.run`. A menu that must defer it until close passes its own. */
  onSelect?: () => void
}

/** A separator for the given menu kind. */
export function menuSeparator(kind: MenuKind = 'context') {
  return kind === 'dropdown' ? <DropdownMenuSeparator /> : <ContextMenuSeparator />
}

/** A menu item for a registered action: label, icon, chord hint, disabled from `when`, runs on select. Null for an unknown id. */
export function actionMenuItem(id: string, options: ActionMenuItemOptions = {}) {
  const action = findAction(id)
  if (!action) return null
  const { kind = 'context', label = action.label, onSelect = action.run } = options
  const disabled = !isActionEnabled(action)
  const hint = action.chord ? chordText(action.chord) : undefined
  if (kind === 'dropdown') {
    return (
      <DropdownMenuItem key={id} icon={action.icon} disabled={disabled} onSelect={onSelect}>
        {label}
        {hint && <DropdownMenuShortcut>{hint}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    )
  }
  return (
    <ContextMenuItem key={id} icon={action.icon} disabled={disabled} onSelect={onSelect}>
      {label}
      {hint && <ContextMenuShortcut>{hint}</ContextMenuShortcut>}
    </ContextMenuItem>
  )
}

/** Spelling suggestions for the word at the caret (#1431) plus "Add to dictionary", shown above the text-edit items. A misspelt word with no suggestions still offers Add. */
export function spellingItems({ misspelt, suggestions, word, onReplace, onAdd }: { misspelt: boolean; suggestions: string[]; word: string; onReplace: (text: string) => void; onAdd: () => void }) {
  if (!misspelt) return null
  return (
    <>
      {suggestions.length === 0 && (
        <ContextMenuItem aria-disabled inset onSelect={(event) => event.preventDefault()}>
          <span className="opacity-50">No suggestions</span>
        </ContextMenuItem>
      )}
      {suggestions.map((suggestion) => (
        <ContextMenuItem key={suggestion} icon={SpellCheckIcon} onSelect={() => onReplace(suggestion)}>
          {suggestion}
        </ContextMenuItem>
      ))}
      <ContextMenuItem icon={BookPlusIcon} onSelect={onAdd}>
        Add “{word}” to dictionary
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  )
}

export type TextEditAction = 'cut' | 'copy' | 'paste' | 'paste-text' | 'select-all'

interface TextEditItemsOptions {
  editable: boolean
  hasSelection: boolean
  hasText: boolean
  onSelect: (action: TextEditAction) => void
}

/** The text-field items, defined once: Cut, Copy, Paste, Paste as plain text, then Select all. */
export function textEditItems({ editable, hasSelection, hasText, onSelect }: TextEditItemsOptions) {
  return (
    <>
      <ContextMenuItem icon={ScissorsIcon} disabled={!editable || !hasSelection} onSelect={() => onSelect('cut')}>
        Cut
        <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem icon={CopyIcon} disabled={!hasSelection} onSelect={() => onSelect('copy')}>
        Copy
        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem icon={ClipboardPasteIcon} disabled={!editable} onSelect={() => onSelect('paste')}>
        Paste
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem icon={ClipboardTypeIcon} disabled={!editable} onSelect={() => onSelect('paste-text')}>
        Paste as plain text
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={TextSelectIcon} disabled={!hasText} onSelect={() => onSelect('select-all')}>
        Select all
        <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  )
}
