import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/sonner'
import { initStores } from './state'

// Refract is dark-only (docs/DESIGN.md "Look and feel"); spec 007 will replace this hardcoded
// class with a bootstrap-derived one once real theme presets ship (research.md decision 4).
document.documentElement.classList.add('dark')

initStores()

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </StrictMode>
)
