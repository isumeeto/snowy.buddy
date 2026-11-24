import { useEffect, useRef, useSyncExternalStore } from 'react'
import { PixelCanvasRenderer } from './PixelCanvasRenderer.js'
import {
  cycleTheme,
  getPixelCanvasSnapshot,
  setCompanionState,
  setConnectionState,
  setDialogueText,
  setMoodLevel,
  setTheme,
  subscribePixelCanvas,
} from './pixelCanvasController.js'

const PREVIEW_STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'HAPPY', 'SLEEPING', 'ANGRY', 'SAD', 'SURPRISED', 'CURIOUS', 'LOVE', 'EXCITED', 'LAUGHING', 'BASHFUL', 'SKEPTICAL']
const PREVIEW_LINES = {
  IDLE: 'READY WHEN YOU ARE, SIR.',
  LISTENING: 'IM LISTENING, SUMEET SIR.',
  THINKING: 'GIVE ME A MOMENT...',
  SPEAKING: 'HERE IS WHAT I FOUND.',
  HAPPY: 'PIXEL PREVIEW: HAPPY FACE.',
  SLEEPING: 'REST MODE. SAY MY NAME.',
  ANGRY: 'PIXEL PREVIEW: ANGRY FACE.',
  SAD: 'PIXEL PREVIEW: SAD FACE.',
  SURPRISED: 'PIXEL PREVIEW: SURPRISED.',
  CURIOUS: 'PIXEL PREVIEW: CURIOUS.',
  LOVE: 'PIXEL PREVIEW: HEART EYES.',
  EXCITED: 'PIXEL PREVIEW: EXCITED.',
  LAUGHING: 'PIXEL PREVIEW: LAUGHING.',
  BASHFUL: 'PIXEL PREVIEW: SHY FACE.',
  SKEPTICAL: 'PIXEL PREVIEW: SKEPTICAL.',
}

export default function PixelCanvas({ debugOpen, onTalkStart, onTalkEnd, onClose, onActivity, onExpand }) {
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const model = useSyncExternalStore(subscribePixelCanvas, getPixelCanvasSnapshot, getPixelCanvasSnapshot)

  useEffect(() => {
    const renderer = new PixelCanvasRenderer(canvasRef.current)
    rendererRef.current = renderer
    renderer.setModel(model)
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => rendererRef.current?.setModel(model), [model])

  useEffect(() => {
    const colors = {
      garden: ['#65402F', '#F5F1E6'],
      fern: ['#795238', '#F4EADF'],
      moss: ['#594434', '#F7F0E1'],
    }
    const [foreground, background] = colors[model.theme] || colors.garden
    document.documentElement.style.setProperty('--debug-fg', foreground)
    document.documentElement.style.setProperty('--debug-bg', background)
  }, [model.theme])

  // Optional local event bridge for a FastAPI/WebSocket companion controller.
  useEffect(() => {
    const applyUpdate = (data) => {
      if (!data || typeof data !== 'object') return
      if (data.state) setCompanionState(data.state)
      if (typeof data.dialogueText === 'string') setDialogueText(data.dialogueText)
      if (Number.isFinite(Number(data.moodLevel))) setMoodLevel(data.moodLevel)
      if (data.theme) setTheme(String(data.theme).toLowerCase())
    }
    const onCustomEvent = (event) => applyUpdate(event.detail)
    window.addEventListener('snowy:pixel-update', onCustomEvent)

    const socketUrl = new URLSearchParams(window.location.search).get('pixelSocket')
    let socket
    if (socketUrl && /^wss?:\/\//i.test(socketUrl)) {
      try {
        socket = new WebSocket(socketUrl)
        socket.addEventListener('open', () => setConnectionState(true))
        socket.addEventListener('close', () => setConnectionState(false))
        socket.addEventListener('message', (event) => {
          try { applyUpdate(JSON.parse(event.data)) } catch { /* Ignore non-JSON backend messages. */ }
        })
      } catch { /* The optional local bridge must not block Snowy's voice UI. */ }
    }
    return () => {
      window.removeEventListener('snowy:pixel-update', onCustomEvent)
      socket?.close()
    }
  }, [])

  const holdPointer = (event) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) * 160 / rect.width
    const y = (event.clientY - rect.top) * 90 / rect.height
    if (x >= 132 && y <= 16) {
      onClose()
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    onActivity()
    onTalkStart()
  }

  return (
    <>
      <div className={`pixel-display ${model.compact ? 'is-compact' : ''}`} aria-label="Snowy pixel companion display">
        <div className="window-drag-handle" aria-label="Drag to move Snowy" title="Drag to move Snowy"><span /></div>
        {model.compact && (
          <svg
            className="idle-cat"
            viewBox="0 0 100 120"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Snowy the resting cat. Click to wake Snowy."
            onClick={onActivity}
            onPointerEnter={() => window.companion?.setPetHover(true)}
            onPointerLeave={() => window.companion?.setPetHover(false)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <defs>
              <linearGradient id="cat-glass" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fff4e7" stopOpacity=".98" />
                <stop offset=".48" stopColor="#eebc9d" stopOpacity=".92" />
                <stop offset="1" stopColor="#a86d63" stopOpacity=".96" />
              </linearGradient>
              <linearGradient id="cat-ear" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#e5a5a0" />
                <stop offset="1" stopColor="#c27675" />
              </linearGradient>
              <radialGradient id="cat-shine" cx=".35" cy=".2" r=".8">
                <stop stopColor="#fff" stopOpacity=".7" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </radialGradient>
              <filter id="cat-shadow" x="-30%" y="-30%" width="160%" height="170%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                <feOffset dy="3" />
                <feComponentTransfer><feFuncA type="linear" slope=".24" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <g className="cat-direction">
            <g className="cat-bob" filter="url(#cat-shadow)">
              <path className="cat-tail" d="M72 91c12-3 21-9 18-17-1-5-6-6-9-2" fill="none" stroke="#cf947e" strokeWidth="5" strokeLinecap="round" />
              <path className="cat-leg cat-leg-1" d="M33 91q-4 9-2 18 4 4 9 0l3-13" fill="url(#cat-ear)" stroke="#fff8ef" strokeOpacity=".65" strokeWidth="1.2" />
              <path className="cat-leg cat-leg-4" d="M66 92q4 8 2 17-4 4-9 0l-2-12" fill="url(#cat-ear)" stroke="#fff8ef" strokeOpacity=".65" strokeWidth="1.2" />
              <path d="M30 78c-10 9-10 23-3 29 5 4 12 2 18-2l10 1c7 4 17 4 22-2 5-8 1-20-8-28Z" fill="url(#cat-glass)" stroke="#fff8ef" strokeOpacity=".72" strokeWidth="1.6" />
              <path className="cat-leg cat-leg-2" d="M42 96q-6 9-3 16 5 4 10 0l3-10" fill="url(#cat-ear)" stroke="#fff8ef" strokeOpacity=".65" strokeWidth="1.2" />
              <path className="cat-leg cat-leg-3" d="M57 97q-2 9 3 15 6 3 10-1 1-6-5-12" fill="url(#cat-ear)" stroke="#fff8ef" strokeOpacity=".65" strokeWidth="1.2" />
              <path d="M37 87q13 7 27 0" fill="none" stroke="#a86d63" strokeWidth="3" strokeLinecap="round" />
              <circle cx="51" cy="91" r="2.2" fill="#f4d49d" stroke="#8f634a" strokeWidth=".7" />
              <path d="M14 35 10 9q0-4 4-1l18 16a37 37 0 0 1 36 0L86 8q4-3 4 2l-4 27q7 17-3 30Q72 80 50 80T17 67Q7 53 14 35Z" fill="url(#cat-glass)" stroke="#fff8ef" strokeOpacity=".72" strokeWidth="1.6" />
              <path d="m19 32-4-17 14 13a37 37 0 0 0-10 4Zm62 0 4-17-14 13a37 37 0 0 1 10 4Z" fill="url(#cat-ear)" opacity=".9" />
              <path d="M18 37q8-16 29-16t35 17Q68 28 51 30T18 37Z" fill="url(#cat-shine)" opacity=".8" />
              <path d="M29 48q7-7 14 0M57 48q7-7 14 0" fill="none" stroke="#553b3a" strokeWidth="3.2" strokeLinecap="round" className="cat-eye" />
              <ellipse cx="36" cy="48" rx="2" ry="3.2" fill="#533938" className="cat-pupil" />
              <ellipse cx="64" cy="48" rx="2" ry="3.2" fill="#533938" className="cat-pupil" />
              <path d="m46 56 4-3 4 3-4 3Z" fill="#985c66" />
              <path d="M50 59q-4 5-8 2m8-2q4 5 8 2" fill="none" stroke="#654442" strokeWidth="1.8" strokeLinecap="round" />
              <path d="m35 57-20-3m21 7-19 3m48-7 20-3m-21 7 19 3" fill="none" stroke="#805b55" strokeWidth="1.2" strokeLinecap="round" opacity=".75" />
              <path d="M28 58q5-5 11 0m22 0q6-5 11 0" fill="none" stroke="#f6d7c8" strokeWidth="4" strokeLinecap="round" opacity=".9" />
            </g>
            </g>
          </svg>
        )}
        <canvas
            ref={canvasRef}
            width="160"
            height="90"
            className={`pixel-canvas ${model.compact ? 'is-hidden' : ''}`}
            role="img"
            aria-label={`Snowy: ${model.companionState}. ${model.dialogueText}`}
            onPointerDown={holdPointer}
            onPointerUp={onTalkEnd}
            onPointerCancel={onTalkEnd}
            onContextMenu={(event) => event.preventDefault()}
        />
        {!model.compact && <button className="pixel-close" type="button" aria-label="Close Snowy" onPointerDown={(event) => event.stopPropagation()} onClick={onClose}>×</button>}
        <span className="sr-only">{model.companionState}. {model.dialogueText}</span>
      </div>
      {debugOpen && (
        <aside className="pixel-debug" aria-label="Snowy display preview controls">
          <div className="pixel-debug-states">
            {PREVIEW_STATES.map((state) => (
              <button
                key={state}
                className={model.companionState === state ? 'is-active' : ''}
                onClick={() => { setCompanionState(state); setDialogueText(PREVIEW_LINES[state]) }}
              >{state}</button>
            ))}
            <button onClick={() => { cycleTheme(); setDialogueText('COLOR THEME CHANGED.') }}>THEME</button>
            <button onClick={() => { setMoodLevel((model.moodLevel + 1) % 6); setDialogueText('MOOD METER PREVIEW.') }}>MOOD +</button>
            <button className="pixel-debug-close" onClick={() => window.companion?.close?.()}>EXIT</button>
          </div>
          <div className="pixel-debug-themes">
            <button onClick={() => setTheme('garden')}>1 CHESTNUT</button>
            <button onClick={() => setTheme('fern')}>2 COCOA</button>
            <button onClick={() => setTheme('moss')}>3 WALNUT</button>
          </div>
        </aside>
      )}
    </>
  )
}
