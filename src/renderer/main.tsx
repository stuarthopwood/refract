import './styles/globals.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ScaffoldCheckResult } from '../preload/api'

function App() {
  const [result, setResult] = useState<ScaffoldCheckResult | null>(null)

  useEffect(() => {
    setResult(window.pinionScaffoldCheck.ping())
  }, [])

  return (
    <main>
      <h1>Pinion</h1>
      <p>Preload sandbox check: {result ? JSON.stringify(result) : 'pending…'}</p>
    </main>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
