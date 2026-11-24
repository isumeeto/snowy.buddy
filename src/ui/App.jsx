import { useCallback, useEffect, useRef, useState } from 'react'
import { createVoiceSession } from '../voice/index.js'
import PixelCanvas from './PixelCanvas.jsx'
import { getPixelCanvasSnapshot, setCompanionState, setCompactMode, setConnectionState, setDialogueText, setTheme } from './pixelCanvasController.js'

function friendlyError(error) {
  const message = error instanceof Error ? error.message : 'Something went wrong.'
  if (message.includes('NotAllowedError') || message.includes('Permission denied')) return 'MICROPHONE ACCESS NEEDED.'
  if (message.includes('401') || message.includes('API_KEY_INVALID') || message.includes('API key not valid')) return 'GEMINI KEY WAS NOT ACCEPTED.'
  return message.toUpperCase()
}

const EXPRESSION_STATES = {
  angry: 'ANGRY', surprised: 'SURPRISED', sidelook: 'CURIOUS', wink: 'WINK',
  happy: 'HAPPY', sad: 'SAD', curious: 'CURIOUS', calm: 'CALM',
  excited: 'EXCITED', love: 'LOVE', sleepy: 'SLEEPY', worried: 'WORRIED', confused: 'CONFUSED',
  laughing: 'LAUGHING', bashful: 'BASHFUL', skeptical: 'SKEPTICAL',
}

const EXPRESSION_WORDS = [
  ['angry', /\b(angry|anger|mad|annoyed)\b/],
  ['surprised', /\b(surprised|surprise|shocked)\b/],
  ['happy', /\b(happy|happiness|smile|joyful)\b/],
  ['sad', /\b(sad|sadness|crying|unhappy)\b/],
  ['curious', /\b(curious|curiosity|sidelook)\b/],
  ['confused', /\b(confused|confusion|puzzled)\b/],
  ['worried', /\b(worried|worry|nervous)\b/],
  ['sleepy', /\b(sleepy|sleeping|tired|sleep)\b/],
  ['love', /\b(love|loving|heart eyes)\b/],
  ['excited', /\b(excited|excitement|thrilled)\b/],
  ['wink', /\b(wink|winking)\b/],
  ['calm', /\b(calm|relaxed)\b/],
  ['laughing', /\b(laugh|laughing|giggle|giggling)\b/],
  ['bashful', /\b(bashful|shy|embarrassed)\b/],
  ['skeptical', /\b(skeptical|sceptical|doubtful|unimpressed)\b/],
]

function requestedExpression(transcript) {
  const text = String(transcript || '').toLowerCase()
  if (!/\b(show|display|make|change|switch|look|be|give me)\b/.test(text)) return null
  return EXPRESSION_WORDS.find(([, pattern]) => pattern.test(text))?.[0] || null
}

export default function App() {
  const [status, setStatus] = useState('connecting')
  const [emotionOverride, setEmotionOverride] = useState(null)
  const [idleGlance, setIdleGlance] = useState(false)
  const [debugMenuOpen, setDebugMenuOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [compactApplied, setCompactApplied] = useState(false)
  const [sleepFolding, setSleepFolding] = useState(false)
  const [activityVersion, setActivityVersion] = useState(0)
  const [draft, setDraft] = useState('')
  const [sendingText, setSendingText] = useState(false)
  const [researchSources, setResearchSources] = useState([])
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const sessionRef = useRef(null)
  const connectPromiseRef = useRef(null)
  const heldRef = useRef(false)
  const recordingRef = useRef(false)
  const pressStartedRef = useRef(0)
  const startupGreetingRef = useRef(false)
  const wakeRecognitionRef = useRef(null)
  const wakeCooldownRef = useRef(0)

  const noteActivity = useCallback(() => {
    setCompact(false)
    setActivityVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    if (compact || ['connecting', 'listening', 'thinking', 'speaking'].includes(status)) return undefined
    const timer = window.setTimeout(() => {
      setDebugMenuOpen(false)
      setCompact(true)
    }, 10000)
    return () => window.clearTimeout(timer)
  }, [compact, activityVersion, status])

  useEffect(() => {
    let cancelled = false
    let foldTimer
    const applyWindowMode = async () => {
      if (compact) {
        setSleepFolding(true)
        await new Promise((resolve) => { foldTimer = window.setTimeout(resolve, 560) })
        if (cancelled) return
      } else {
        setSleepFolding(false)
      }
      try {
        await window.companion?.setCompact?.(compact)
      } catch { /* Keep the renderer usable if the optional Electron bridge is unavailable. */ }
      if (!cancelled) {
        setCompactMode(compact)
        setCompactApplied(compact)
        setSleepFolding(false)
      }
    }
    applyWindowMode()
    return () => {
      cancelled = true
      window.clearTimeout(foldTimer)
    }
  }, [compact])

  useEffect(() => () => {
    sessionRef.current?.close()
    sessionRef.current = null
  }, [])

  const handleVoiceEvent = useCallback((event) => {
    if (['transcription.interim', 'conversation.item.input_audio_transcription.completed', 'expression', 'response.created', 'response.output_audio_transcript.delta', 'response.done'].includes(event.type)) {
      noteActivity()
    }
    if (event.type === 'expression') {
      setEmotionOverride(event.expression)
    } else if (event.type === 'research.sources') {
      const safeSources = (Array.isArray(event.sources) ? event.sources : []).filter((source) => {
        try { return new URL(source.url).protocol === 'https:' } catch { return false }
      })
      setResearchSources(safeSources)
      setSourcesOpen(false)
    } else if (event.type === 'connected') {
      setConnectionState(true)
      setStatus((current) => current === 'connecting' ? 'ready' : current)
    } else if (event.type === 'context-reset') {
      setConnectionState(true)
      setStatus('ready')
      setDialogueText('VOICE RECONNECTED. RECENT SESSION CONTEXT WAS NOT RESTORED.')
    } else if (event.type === 'transcription.interim' && event.transcript) {
      setDialogueText(event.transcript)
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
      setDialogueText(event.transcript)
      const requested = requestedExpression(event.transcript)
      if (requested) setEmotionOverride(requested)
    } else if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
      const currentText = getPixelCanvasSnapshot().dialogueText
      setDialogueText(currentText + event.delta)
    } else if (event.type === 'response.created') {
      setStatus('speaking')
      setDialogueText('')
    } else if (event.type === 'response.done') {
      setStatus(heldRef.current && recordingRef.current ? 'listening' : 'ready')
    } else if (event.type === 'reconnecting') {
      setConnectionState(false)
      setStatus('connecting')
      const reason = String(event.reason || '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 96)
      setDialogueText(`CONNECTION LOST ${event.code}${reason ? `: ${reason}` : ''}. RECONNECTING ${event.attempt} OF 5.`)
    } else if (event.type === 'error') {
      setConnectionState(false)
      setDialogueText(friendlyError(event.error))
      setStatus('idle')
      sessionRef.current?.close()
      sessionRef.current = null
    }
  }, [noteActivity])

  const ensureSession = useCallback(async () => {
    if (sessionRef.current) return sessionRef.current
    if (!connectPromiseRef.current) {
      connectPromiseRef.current = createVoiceSession(handleVoiceEvent)
        .then((session) => {
          sessionRef.current = session
          setConnectionState(true)
          setStatus('ready')
          return session
        })
        .catch((err) => {
          sessionRef.current = null
          throw err
        })
        .finally(() => { connectPromiseRef.current = null })
    }
    return connectPromiseRef.current
  }, [handleVoiceEvent])

  useEffect(() => {
    const announce = async (kind, item) => {
      const message = String(item?.message || '').trim()
      if (!message) return
      noteActivity()
      if (kind === 'automation' && Array.isArray(item.sources)) {
        setResearchSources(item.sources.filter((source) => source?.url?.startsWith('https://')).slice(0, 8))
        setSourcesOpen(true)
      }
      setDialogueText(kind === 'whatsapp'
        ? `WHATSAPP FROM ${String(item.sender || 'CONTACT').toUpperCase()}: ${message}`
        : kind === 'automation' ? `AUTOMATION: ${message}` : `REMINDER: ${message}`)
      try {
        const voice = sessionRef.current || await ensureSession()
        voice.announceNotice(kind, { sender: item.sender || '', message })
      } catch (reason) {
        setDialogueText(friendlyError(reason))
      }
    }
    const stopWhatsApp = window.companion?.onWhatsAppNotification?.((item) => announce('whatsapp', item))
    const stopReminder = window.companion?.onReminderDue?.((item) => announce('reminder', item))
    const stopAutomation = window.companion?.onAutomationDue?.((item) => announce('automation', item))
    return () => { stopWhatsApp?.(); stopReminder?.(); stopAutomation?.() }
  }, [ensureSession, noteActivity])

  // Snowy greets automatically after its voice connection is ready.
  useEffect(() => {
    if (startupGreetingRef.current || sessionStorage.getItem('snowy-startup-greeting-sent') === '1') return
    startupGreetingRef.current = true
    sessionStorage.setItem('snowy-startup-greeting-sent', '1')
    setDialogueText('STARTING SNOWY...')
    ensureSession()
      .then((voice) => voice.greet())
      .catch(async (reason) => {
        setStatus('idle')
        setConnectionState(false)
        const reasonText = reason instanceof Error ? reason.message : String(reason || '')
        const isOffline = !navigator.onLine || /could not connect|timed out|network|websocket|connection (?:failed|closed|lost)/i.test(reasonText)
        if (isOffline) {
          setDialogueText('OFFLINE. CONNECT TO THE INTERNET FOR MORE HELP.')
          try { await window.companion?.speakOfflineGreeting?.() } catch { /* Keep the offline greeting visible if Windows speech is unavailable. */ }
          return
        }
        setDialogueText(friendlyError(reason))
      })
  }, [ensureSession])

  useEffect(() => {
    if (status !== 'idle' || emotionOverride) {
      setIdleGlance(false)
      return undefined
    }
    let glanceTimer
    let revertTimer
    const schedule = () => {
      glanceTimer = window.setTimeout(() => {
        setIdleGlance(true)
        revertTimer = window.setTimeout(() => { setIdleGlance(false); schedule() }, 4200)
      }, 10000 + Math.random() * 5000)
    }
    schedule()
    return () => { window.clearTimeout(glanceTimer); window.clearTimeout(revertTimer) }
  }, [status, emotionOverride])

  useEffect(() => {
    const voiceIsActive = ['listening', 'thinking', 'speaking', 'connecting'].includes(status)
    const expressionState = EXPRESSION_STATES[emotionOverride]
    const state = voiceIsActive
      ? ({ listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', connecting: 'THINKING' }[status])
      : expressionState || (idleGlance ? 'CURIOUS' : 'IDLE')
    setCompanionState(state)
  }, [status, emotionOverride, idleGlance])

  const beginTalking = async () => {
    setEmotionOverride(null)
    setIdleGlance(false)
    if (heldRef.current) return
    heldRef.current = true
    recordingRef.current = false
    pressStartedRef.current = Date.now()
    setStatus('connecting')
    try {
      const voice = await ensureSession()
      if (heldRef.current) {
        await voice.startTalking()
        if (heldRef.current) {
          recordingRef.current = true
          setStatus('listening')
        } else {
          voice.discardTalking()
        }
      }
    } catch (reason) {
      heldRef.current = false
      recordingRef.current = false
      setStatus('idle')
      setConnectionState(false)
      setDialogueText(friendlyError(reason))
    }
  }

  const finishTalking = () => {
    if (!heldRef.current) return
    heldRef.current = false
    if (!recordingRef.current) {
      setStatus(sessionRef.current ? 'ready' : 'idle')
      return
    }
    recordingRef.current = false
    if (Date.now() - pressStartedRef.current < 350) {
      sessionRef.current?.discardTalking()
      setStatus('ready')
      setDialogueText('HOLD A LITTLE LONGER SO I CAN HEAR YOU.')
      return
    }
    sessionRef.current?.stopTalking()
    setStatus('thinking')
  }

  const sendTypedText = async (event) => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || sendingText) return
    noteActivity()
    setSendingText(true)
    setDialogueText(message)
    setStatus('thinking')
    try {
      const voice = await ensureSession()
      voice.sendText(message)
      setDraft('')
    } catch (reason) {
      setStatus('idle')
      setDialogueText(friendlyError(reason))
    } finally {
      setSendingText(false)
    }
  }

  const handleWakePhrase = useCallback(async (transcript) => {
    const match = String(transcript || '').match(/\bhey\s+snowy\b[\s,!.?;:-]*(?:wake\s+up)?/i)
    if (!match || Date.now() - wakeCooldownRef.current < 4000) return
    wakeCooldownRef.current = Date.now()
    noteActivity()
    setEmotionOverride(null)
    setDialogueText('I’M HERE, SUMEET SIR.')
    setStatus(sessionRef.current ? 'thinking' : 'connecting')
    try {
      const voice = await ensureSession()
      const request = transcript.slice(match[0].length).trim().replace(/^[,!.?;:-]+/, '').trim()
      voice.sendText(request || 'Hey Snowy, wake up.')
    } catch (reason) {
      setStatus('idle')
      setDialogueText(friendlyError(reason))
    }
  }, [ensureSession, noteActivity])

  // Keep a local speech recognizer ready while Snowy is open. Only the wake
  // phrase is acted on; ordinary background speech is discarded.
  useEffect(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) return undefined
    const recognition = new Recognition()
    wakeRecognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || ''
        if (/\bhey\s+snowy\b/i.test(transcript)) handleWakePhrase(transcript)
      }
    }
    recognition.onend = () => {
      if (wakeRecognitionRef.current === recognition) {
        try { recognition.start() } catch { /* Chromium may still be closing the previous recognition request. */ }
      }
    }
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setDialogueText('ALLOW MICROPHONE ACCESS FOR “HEY SNOWY” WAKE-UP. SPACEBAR STILL WORKS.')
      }
    }
    try { recognition.start() } catch { /* Unsupported or permission-blocked recognizer. */ }
    return () => {
      wakeRecognitionRef.current = null
      recognition.onend = null
      recognition.stop()
    }
  }, [handleWakePhrase])

  useEffect(() => {
    const isEditing = (target) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    const onKeyDown = (event) => {
      if (event.code === 'Space' && !isEditing(event.target) && !event.repeat) noteActivity()
      if (event.code === 'Space' && !isEditing(event.target) && !event.repeat) {
        event.preventDefault()
        beginTalking()
        return
      }
      if (isEditing(event.target)) return
      if (event.key.toLowerCase() === 'h') { noteActivity(); setDebugMenuOpen((open) => !open) }
      if (event.key === '1') { noteActivity(); setTheme('garden'); setDialogueText('CHESTNUT AND CREAM THEME.') }
      if (event.key === '2') { noteActivity(); setTheme('fern'); setDialogueText('COCOA AND CREAM THEME.') }
      if (event.key === '3') { noteActivity(); setTheme('moss'); setDialogueText('WALNUT AND CREAM THEME.') }
      if (event.key === 'Escape') window.companion?.close?.()
    }
    const onKeyUp = (event) => {
      if (event.code === 'Space') { event.preventDefault(); finishTalking() }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [noteActivity])

  return (
    <main className={`pixel-app ${sleepFolding ? 'is-folding' : ''} ${compactApplied ? 'is-compact' : ''}`}>
      <PixelCanvas
        debugOpen={debugMenuOpen}
        onTalkStart={beginTalking}
        onTalkEnd={finishTalking}
        onClose={() => window.companion?.close?.()}
        onActivity={noteActivity}
        onExpand={noteActivity}
      />
      {!compact && sourcesOpen && researchSources.length > 0 && (
        <section className="research-source-panel" aria-label="Web research sources">
          <header>
            <span>WEB SOURCES</span>
            <button type="button" aria-label="Close sources" onClick={() => setSourcesOpen(false)}>×</button>
          </header>
          <ol>
            {researchSources.map((source) => (
              <li key={source.url}>
                <button
                  type="button"
                  title={source.title}
                  onClick={() => window.companion.openExternalUrl(source.url).catch((error) => setDialogueText(friendlyError(error)))}
                >
                  {source.title}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {!compact && (
        <form className="typing-box" onSubmit={sendTypedText}>
          <input
            className="typing-input"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); noteActivity() }}
            onPointerDown={noteActivity}
            onFocus={noteActivity}
            maxLength={2000}
            placeholder="Type to Snowy..."
            aria-label="Type a message to Snowy"
          />
          {researchSources.length > 0 && <button className="typing-sources" type="button" onClick={() => { setSourcesOpen((open) => !open); noteActivity() }}>SRC</button>}
          <button className="typing-send" type="submit" disabled={!draft.trim() || sendingText}>SEND</button>
        </form>
      )}
      <span className="sr-only">Hold Space to talk or type a message below. Snowy becomes a roaming desktop cat after ten seconds of inactivity. Click it to open, hover to play, or drag to pick it up.</span>
    </main>
  )
}
