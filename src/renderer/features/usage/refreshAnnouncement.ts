/** What the polite status says when a refresh of loaded figures starts or ends; null while nothing changed. The overlay card is decorative, so this is the only cue for a screen-reader user. */
export function refreshAnnouncement(wasUpdating: boolean, updating: boolean): string | null {
  if (!wasUpdating && updating) return 'Updating usage'
  if (wasUpdating && !updating) return 'Usage updated'
  return null
}
