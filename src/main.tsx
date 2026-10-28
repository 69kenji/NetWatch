import React from 'react'
import ReactDOM from 'react-dom/client'
import { ProfileShell } from './components/ProfileShell'
import './styles/globals.css'
import './styles/player.css'
import './styles/appearance.css'
import { bootstrapAppearance } from './theme/appearance'

bootstrapAppearance()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ProfileShell />
  </React.StrictMode>,
)
