/** The notes a submit sends: one per picked option that has a note, in pick order. A note on an unpicked option stays in the draft but is not sent. */
export function pickedNotes(selectedOptions: readonly string[], notes: Readonly<Record<string, string>>): { option: string; text: string }[] {
  return selectedOptions.flatMap((option) => {
    const text = notes[option]?.trim()
    return text ? [{ option, text }] : []
  })
}
