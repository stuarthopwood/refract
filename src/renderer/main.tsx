import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/sonner'
import { OmpGuardDetailsDialog } from './components/OmpGuardDetailsDialog'
import { initStores, initThemeStore } from './state'

// Spec 007 (FR-012/SC-003, research.md decision 4): synchronous bootstrap read before React
// mounts and before any class is set on <html>, so a window never shows an unthemed or wrongly
// themed frame first -- confirmed live at ~0.6ms round trip (docs/spike/FINDINGS.md item 42).
// `initThemeStore` both seeds `theme-store.ts`'s state from this one real bootstrap value (the
// only call anywhere that makes the actual IPC round trip -- quality-gate remediation: the store
// used to ALSO call `themeBootstrap()` itself at module-import time, doubling this blocking call
// for no benefit) and applies the matching `<html>` class immediately via that same module's
// subscription, so the window is never shown with a mismatched or unthemed class on its very
// first paint. The literal `dark` class that subscription also applies is kept alongside the
// per-theme class, never replaced by it: every built-in theme is dark-toned (research.md
// decision 1), and globals.css's own `@custom-variant dark (&:is(.dark *))` drives every shadcn
// component's `dark:` utility classes off that literal class name, not off the per-theme one --
// dropping it would silently revert every one of those components (Button, Badge, Switch,
// Textarea, ...) to their light-mode styling.
initThemeStore(window.refract.themeBootstrap().theme)

initStores()

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster />
      <OmpGuardDetailsDialog />
    </TooltipProvider>
  </StrictMode>
)
