export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "image/png" -> "PNG"; tolerates a missing type or one with no slash. */
export function imageTypeLabel(mimeType: string | undefined): string {
  if (!mimeType) return ''
  const slash = mimeType.indexOf('/')
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase()
}
