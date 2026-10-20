import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { UpdateToast } from './offline/UpdateToast.tsx'
import { startSync } from './offline/sync.ts'

startSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <UpdateToast />
    </BrowserRouter>
  </StrictMode>,
)
