import React from 'react'
import ReactDOM from 'react-dom/client'
import { Player } from './components/player/Player'
import './styles/globals.css'
import './styles/player.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Player />
  </React.StrictMode>,
)
