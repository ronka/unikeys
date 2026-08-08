import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyStoredTheme } from './lib/theme'

// Before the first render, so a window whose preference differs from the OS
// does not paint once in the wrong appearance and then correct itself.
applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
