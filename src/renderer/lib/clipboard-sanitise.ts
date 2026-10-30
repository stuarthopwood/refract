// The visible transcript text is never touched -- this only sanitises what a Copy button's click handler actually writes to the OS clipboard.
export function sanitiseForClipboard(text: string): string {
  return text
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u206A-\u206F\uFFF9-\uFFFB]/g, "")
    .replace(
      /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,7}\u{E007F})|[\u{E0000}-\u{E007F}\uD800-\uDFFF]/gu,
      (_m, flag: string | undefined) => flag ?? "",
    )
}
