/** Last path segment of a POSIX-`/`-separated relative path; never split on the OS separator. */
export function fileName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/** The header shows the name prominently and the folder it sits in muted; a root file has no folder. */
export function splitDocumentPath(path: string): { name: string; directory: string } {
  const index = path.lastIndexOf('/')
  return index === -1 ? { name: path, directory: '' } : { name: path.slice(index + 1), directory: path.slice(0, index) }
}
