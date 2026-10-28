import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import { Player } from './components/player/Player'
import './styles/globals.css'
import './styles/player.css'
import './styles/appearance.css'
import { bootstrapAppearance } from './theme/appearance'

bootstrapAppearance(true)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user"><Player /></MotionConfig>
  </React.StrictMode>,
)
