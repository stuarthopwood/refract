import { useEffect, useState } from 'react'
import { readSidebarRgb } from '@/lib/projectColor'

// The Session list background as RGB, re-read whenever the root element's theme class changes,
// so a custom Project colour is re-adjusted for the active theme.
export function useSidebarRgb(): [number, number, number] | null {
  const [rgb, setRgb] = useState(() => readSidebarRgb())
  useEffect(() => {
    const update = () => setRgb((previous) => {
      const next = readSidebarRgb()
      return previous && next && previous.every((v, i) => v === next[i]) ? previous : next
    })
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return rgb
}
