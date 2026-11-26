/** The heading for a Stage's file list; never "Changed files", because the list is a rolling window and not a complete record. */
export const FILES_TOUCHED_LABEL = 'Files touched'

/** Empty-state wording: says nothing is known, not that nothing was touched. */
export const FILES_TOUCHED_EMPTY_TEXT = 'No file activity recorded yet'

/** What a surface shows for an agent's file list: the label, plus either the files or the honest empty state. */
export function filesTouchedDisplay(filesTouched: readonly string[] | undefined): { label: string; files: readonly string[]; emptyText?: string } {
  if (!filesTouched || filesTouched.length === 0) return { label: FILES_TOUCHED_LABEL, files: [], emptyText: FILES_TOUCHED_EMPTY_TEXT }
  return { label: FILES_TOUCHED_LABEL, files: filesTouched }
}
