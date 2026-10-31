import './styles/globals.css'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { AppContextMenu } from './features/menus/AppContextMenu'
import { Toaster } from './components/ui/sonner'
import { initStores, initThemeStore, useViewStore } from './state'
import { toast } from 'sonner'
import { initTypographyStore } from './state/typography-store'

const bootstrap = window.refract.themeBootstrap()
initThemeStore(bootstrap.theme, bootstrap.customTheme)
initTypographyStore(bootstrap.typography)

initStores()

// Sibling effects run in order, so rendering this after <Toaster /> fires once the Toaster has subscribed.
function BootstrapNotice() {
  useEffect(() => {
    if (!notice) return
    toast.warning(
      notice === 'reset'
        ? 'Custom theme disabled because of --reset-theme. Refract is using your built-in theme.'
        : 'Your custom theme file is missing or invalid, so Refract is using a built-in theme.',
      { id: 'theme-bootstrap-notice', duration: Infinity, closeButton: true, action: { label: 'Appearance settings', onClick: () => useViewStore.getState().openSettings('appearance') } }
    )
  }, [])
  return null
}

const notice = bootstrap.customThemeNotice
const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <AppContextMenu />
      <Toaster />
      <BootstrapNotice />
    </TooltipProvider>
  </StrictMode>
)
