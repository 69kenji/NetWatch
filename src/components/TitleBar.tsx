import { Expand, Minus, Xmark } from 'iconoir-react'

export function TitleBar() {
  return (
    <header className="nw-titlebar">
      <div className="nw-titlebar__drag" />

      <div className="nw-titlebar__identity" aria-label="NetWatch">
        <img className="nw-logo-mark" src="netwatch-icon.png" alt="" aria-hidden="true" draggable={false} />
        <span className="nw-titlebar__name">NetWatch</span>
      </div>


      <div className="nw-window-controls">
        <button onClick={() => window.electron?.window.minimize()} title="Minimize" aria-label="Minimize">
          <Minus width={15} height={15} />
        </button>
        <button onClick={() => window.electron?.window.maximize()} title="Maximize" aria-label="Maximize">
          <Expand width={14} height={14} />
        </button>
        <button className="is-close" onClick={() => window.electron?.window.close()} title="Close" aria-label="Close">
          <Xmark width={15} height={15} />
        </button>
      </div>
    </header>
  )
}
