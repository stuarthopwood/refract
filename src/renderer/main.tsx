import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { AppContextMenu } from './features/menus/AppContextMenu'
import { Toaster } from './components/ui/sonner'
import { initStores, initThemeStore } from './state'
import { initTypographyStore } from './state/typography-store'

const bootstrap = window.refract.themeBootstrap()
initThemeStore(bootstrap.theme)
initTypographyStore(bootstrap.typography)

initStores()

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
