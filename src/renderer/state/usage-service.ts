// The usage scan service is shared by the Usage view and the Session usage panel; only the last
// holder to release may stop it. Holders are a set so a repeated acquire or release is harmless.
const holders = new Set<string>()

export async function acquireUsageService(owner: string) {
  holders.add(owner)
  return window.refract.usage.start()
}

export function releaseUsageService(owner: string): void {
  if (!holders.delete(owner)) return
  if (holders.size === 0) void window.refract.usage.stop()
}
