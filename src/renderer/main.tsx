import './styles/globals.css'
import { StrictMode } from 'react'
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

if (bootstrap.customThemeNotice) {
  toast.warning(
    bootstrap.customThemeNotice === 'reset'
      ? 'Started with the Dark theme because of --reset-theme.'
      : 'Your custom theme file is missing or invalid, so Refract is using a built-in theme.',
    { duration: Infinity, closeButton: true, action: { label: 'Appearance settings', onClick: () => useViewStore.getState().openSettings('appearance') } }
  )
}
const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <AppContextMenu />
      <Toaster />
    </TooltipProvider>
  </StrictMode>
)
