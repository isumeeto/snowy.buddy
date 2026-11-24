const THEMES = ['garden', 'fern', 'moss']
const VALID_STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'HAPPY', 'SLEEPING', 'SLEEPY', 'ANGRY', 'SURPRISED', 'CURIOUS', 'CONFUSED', 'SAD', 'WORRIED', 'WINK', 'CALM', 'EXCITED', 'LOVE', 'LAUGHING', 'BASHFUL', 'SKEPTICAL']

let snapshot = {
  companionState: 'IDLE',
  dialogueText: 'HELLO, SUMEET SIR!',
  moodLevel: 4,
  theme: 'garden',
  connected: false,
  compact: false,
}
const listeners = new Set()

function update(patch) {
  if (Object.entries(patch).every(([key, value]) => snapshot[key] === value)) return
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

export const setCompanionState = (companionState) => {
  const next = String(companionState || '').toUpperCase()
  if (VALID_STATES.includes(next)) update({ companionState: next })
}
export const setDialogueText = (dialogueText) => update({ dialogueText: String(dialogueText || '') })
export const setMoodLevel = (moodLevel) => update({ moodLevel: Math.max(0, Math.min(5, Math.round(Number(moodLevel) || 0))) })
export const setTheme = (theme) => {
  if (THEMES.includes(theme)) update({ theme })
}
export const cycleTheme = () => update({ theme: THEMES[(THEMES.indexOf(snapshot.theme) + 1) % THEMES.length] })
export const setConnectionState = (connected) => update({ connected: Boolean(connected) })
export const setCompactMode = (compact) => update({ compact: Boolean(compact) })
export const getPixelCanvasSnapshot = () => snapshot
export const subscribePixelCanvas = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

