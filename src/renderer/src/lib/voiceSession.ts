import { useVoiceStore } from '../state/voiceStore'
import { useScreenControlStore } from '../state/screenControlStore'
import { useAutonomousTaskStore } from '../state/autonomousTaskStore'
import { useActionTimelineStore } from '../state/actionTimelineStore'
import { useSettingsStore } from '../state/settingsStore'
import { startAudioCapture, type AudioCaptureHandle } from './audioCapture'
import { startWakeWordCapture, type WakeWordCaptureHandle } from './wakeWordCapture'
import { AudioPlayer } from './audioPlayback'

let captureHandle: AudioCaptureHandle | null = null
let player: AudioPlayer | null = null
let bridgeInitialized = false
let screenControlBridgeInitialized = false
let autonomousTaskBridgeInitialized = false
let wakeTriggerBridgeInitialized = false
let wakeWordBridgeInitialized = false
let wakeWordCaptureHandle: WakeWordCaptureHandle | null = null
let wakeWordStarting = false

// Whisper detection: a real, unscaled RMS reading of the mic (see audioCapture.ts's onRawLevel,
// separate from the amplified onLevel used for the VU meter) collected while the user is actually
// talking. Decided once per turn, right as DALVE's reply starts playing, rather than adjusted
// continuously — a reply shouldn't change volume mid-sentence. Thresholds are a first pass with no
// live mic to tune against, same caveat as this session's other RMS-based heuristics (VAD,
// barge-in, hand-tracking pinch distances).
const WHISPER_SILENCE_FLOOR = 0.01
const WHISPER_CEILING = 0.045
const WHISPER_REPLY_VOLUME = 0.35
const NORMAL_REPLY_VOLUME = 1
let listeningLevels: number[] = []

function trackRawLevelForWhisper(rms: number): void {
  // Mic capture runs continuously regardless of session phase — gating on 'listening' here (not
  // just clearing the buffer when it starts) keeps ambient noise picked up while DALVE is
  // speaking/thinking from contaminating the next utterance's whisper classification.
  if (useVoiceStore.getState().sessionState !== 'listening') return
  if (rms > WHISPER_SILENCE_FLOOR) listeningLevels.push(rms)
}

/** Called right as a reply starts playing — looks at how loud the just-finished utterance was and
 *  sets the reply's playback volume accordingly, then clears the buffer for the next utterance. */
function applyWhisperVolumeForReply(): void {
  if (listeningLevels.length > 0) {
    const avg = listeningLevels.reduce((a, b) => a + b, 0) / listeningLevels.length
    player?.setVolume(avg < WHISPER_CEILING ? WHISPER_REPLY_VOLUME : NORMAL_REPLY_VOLUME)
  }
  listeningLevels = []
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function isSessionRunning(): boolean {
  const state = useVoiceStore.getState().sessionState
  return state !== 'idle' && state !== 'error'
}

/** autonomousTask.ts's log lines are raw `toolName(args) -> {result}` strings, not structured
 *  events — this pulls a real tool-name label and result detail out of that shape so the Action
 *  Timeline can show the same clean "label + detail" format as voice-session actionLog entries,
 *  falling back to the whole line for plain narration text that isn't a tool-call log at all. */
function summarizeAutonomousLog(text: string): { label: string; detail?: string; status: 'success' | 'error' | 'info' } {
  const parenIdx = text.indexOf('(')
  const arrowIdx = text.indexOf(' -> ')
  if (parenIdx > 0 && arrowIdx > parenIdx) {
    const detail = text.slice(arrowIdx + 4, arrowIdx + 204)
    return { label: text.slice(0, parenIdx), detail, status: detail.includes('"error"') ? 'error' : 'success' }
  }
  return { label: text.slice(0, 160), status: 'info' }
}

/**
 * Registers the main-process voice event bridge exactly once for the lifetime of the app.
 * Deliberately NOT torn down on effect cleanup: React StrictMode's mount→cleanup→remount
 * cycle would otherwise unsubscribe the real listener and leave it dead after the "remount"
 * (the guard would just return the already-unsubscribed function instead of re-registering).
 */
export function initVoiceBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true
  player = new AudioPlayer()
  player.onLevel = (level) => useVoiceStore.getState().setAudioLevel(level)

  window.dalve.voice.onEvent((event) => {
    const store = useVoiceStore.getState()
    switch (event.type) {
      case 'state':
        // Order matters: decide the reply's volume from what was JUST collected before either
        // resetting for a fresh listening phase or overwriting sessionState (which this checks
        // against to catch only the transition INTO speaking, not every 'speaking' event).
        if (event.state === 'speaking' && store.sessionState !== 'speaking') applyWhisperVolumeForReply()
        if (event.state === 'listening') listeningLevels = []
        store.setSessionState(event.state)
        break
      case 'inputTranscript':
        store.appendTranscript('user', event.text)
        break
      case 'outputTranscript':
        store.appendTranscript('dalve', event.text, useVoiceStore.getState().activeAgentId)
        break
      case 'audio':
        player?.enqueue(event.data)
        break
      case 'interrupted':
        player?.clear()
        break
      case 'turnComplete':
        store.commitTurn()
        break
      case 'error':
        store.addEntry({ speaker: 'system', text: event.message })
        break
      case 'activeAgentChanged':
        store.setActiveAgentId(event.agentId)
        break
      case 'toolActivity':
        store.setToolActive(event.active, event.label)
        break
      case 'actionLog':
        useActionTimelineStore.getState().addEntry({ ...event.entry, source: 'voice' })
        break
    }
  })
}

/** Registers the screen-control event bridge exactly once, same reasoning as initVoiceBridge. */
export function initScreenControlBridge(): void {
  if (screenControlBridgeInitialized) return
  screenControlBridgeInitialized = true

  window.dalve.screenControl.onEvent((event) => {
    useScreenControlStore.getState().setActive(event.active)
  })
}

/** Registers the autonomous-task event bridge exactly once, same reasoning as initVoiceBridge. */
export function initAutonomousTaskBridge(): void {
  if (autonomousTaskBridgeInitialized) return
  autonomousTaskBridgeInitialized = true

  window.dalve.autonomousTask.getState().then(({ active, goal }) => {
    useAutonomousTaskStore.getState().setActive(active, goal)
  })

  window.dalve.autonomousTask.onEvent((event) => {
    const store = useAutonomousTaskStore.getState()
    switch (event.type) {
      case 'started':
        store.setActive(true, event.goal)
        break
      case 'stopped':
        if (event.summary) store.setSummary(event.summary)
        store.setActive(false, null)
        break
      case 'subtasks':
        store.setSubtasks(event.subtasks)
        break
      case 'log': {
        store.addLog(event.text)
        const { label, detail, status } = summarizeAutonomousLog(event.text)
        useActionTimelineStore.getState().addEntry({
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          label,
          detail,
          status,
          timestamp: Date.now(),
          source: 'task'
        })
        break
      }
    }
  })
}

/**
 * Registers the wake-trigger bridge exactly once. Main fires 'wake:triggered' whenever it wants
 * a conversation to actually start (wake-word detection, the global hotkey) — bringing the
 * window forward alone doesn't put DALVE into a listening state, so this is the piece that
 * actually starts mic capture once the window is up.
 */
export function initWakeTriggerBridge(): void {
  if (wakeTriggerBridgeInitialized) return
  wakeTriggerBridgeInitialized = true

  window.dalve.wake.onTriggered(() => {
    void startVoiceSession(null)
  })
}

/** Starts (or leaves alone, if already running) the wake-word listener — only when it's actually
 *  configured/enabled AND no real voice session is using the mic right now. Safe to call
 *  liberally; every early-return is a genuine no-op. */
async function tryStartWakeWord(): Promise<void> {
  if (wakeWordCaptureHandle || wakeWordStarting) return
  const settings = useSettingsStore.getState().settings
  if (!settings?.wakeWordEnabled || !settings.picovoiceAccessKeySet) return
  if (useVoiceStore.getState().sessionState !== 'idle') return

  wakeWordStarting = true
  try {
    const result = await window.dalve.wakeWord.start()
    // Re-check: a real session may have started, or the feature may have been turned off, while
    // that IPC round-trip was in flight.
    if (result.status !== 'SUCCESS' || !result.frameLength || useVoiceStore.getState().sessionState !== 'idle') {
      if (result.status !== 'SUCCESS') console.error('[wakeWord] failed to start:', result.message)
      void window.dalve.wakeWord.stop()
      return
    }
    wakeWordCaptureHandle = await startWakeWordCapture(result.frameLength, (chunk) => window.dalve.wakeWord.sendAudioChunk(chunk))
  } catch (err) {
    console.error('[wakeWord] failed to start capture:', err)
  } finally {
    wakeWordStarting = false
  }
}

function stopWakeWordListening(): void {
  wakeWordCaptureHandle?.stop()
  wakeWordCaptureHandle = null
  void window.dalve.wakeWord.stop()
}

/** Reacts to both session-state changes (stop the instant a real session starts, resume once
 *  idle again) and settings changes (the feature being turned on/off, or a key just being added).
 *  Also makes one attempt at startup in case it's already configured and enabled. */
export function initWakeWordBridge(): void {
  if (wakeWordBridgeInitialized) return
  wakeWordBridgeInitialized = true

  useVoiceStore.subscribe((state, prev) => {
    if (state.sessionState === prev.sessionState) return
    if (state.sessionState === 'idle') void tryStartWakeWord()
    else stopWakeWordListening()
  })

  useSettingsStore.subscribe((state, prev) => {
    const wasOn = prev.settings?.wakeWordEnabled && prev.settings.picovoiceAccessKeySet
    const isOn = state.settings?.wakeWordEnabled && state.settings.picovoiceAccessKeySet
    if (wasOn === isOn) return
    if (isOn) void tryStartWakeWord()
    else stopWakeWordListening()
  })

  void tryStartWakeWord()
}

async function ensureSession(agentId: string | null): Promise<void> {
  const state = useVoiceStore.getState().sessionState
  if (state === 'idle' || state === 'error') {
    useVoiceStore.getState().setSessionState('connecting')
    await window.dalve.voice.start(agentId)
  }
}

export async function startVoiceSession(agentId: string | null = null): Promise<void> {
  try {
    await ensureSession(agentId)
    if (!captureHandle) {
      captureHandle = await startAudioCapture(
        (chunk) => window.dalve.voice.sendAudioChunk(chunk),
        (level) => useVoiceStore.getState().setAudioLevel(level),
        trackRawLevelForWhisper
      )
    }
  } catch (err) {
    useVoiceStore.getState().setSessionState('error')
    useVoiceStore.getState().addEntry({ speaker: 'system', text: errorMessage(err) })
  }
}

export async function stopVoiceSession(): Promise<void> {
  captureHandle?.stop()
  captureHandle = null
  listeningLevels = []
  player?.setVolume(NORMAL_REPLY_VOLUME)
  await window.dalve.voice.stop()
  useVoiceStore.getState().setSessionState('idle')
  useVoiceStore.getState().setAudioLevel(0)
}

let toggleInFlight = false

/** Guarded against re-entrancy: isSessionRunning() only flips once the IPC round-trip to the
 *  main process completes, so two calls fired close together (any double-trigger, not just the
 *  keyboard shortcut) would both read the same stale state and race a start against a stop. */
export async function toggleVoiceSession(): Promise<void> {
  if (toggleInFlight) return
  toggleInFlight = true
  try {
    if (isSessionRunning()) {
      await stopVoiceSession()
    } else {
      await startVoiceSession(useVoiceStore.getState().activeAgentId)
    }
  } finally {
    toggleInFlight = false
  }
}

/**
 * Switches who the live session is talking to. If a session is already running, this hands
 * off to the SAME main-process call that powers voice:start — it closes the old session and
 * opens a new one for the target agent in one atomic step, so there's no window where a stale
 * session could still be receiving audio under the wrong label. If idle, just changes the
 * pre-selected agent for the next time the user starts talking.
 */
export async function switchActiveAgent(agentId: string | null): Promise<void> {
  if (useVoiceStore.getState().activeAgentId === agentId) return

  if (!isSessionRunning()) {
    useVoiceStore.getState().setActiveAgentId(agentId)
    return
  }

  try {
    await window.dalve.voice.start(agentId)
  } catch (err) {
    useVoiceStore.getState().addEntry({ speaker: 'system', text: errorMessage(err) })
  }
}

export async function sendTypedMessage(text: string): Promise<void> {
  useVoiceStore.getState().addEntry({ speaker: 'user', text })
  try {
    await ensureSession(useVoiceStore.getState().activeAgentId)
    await window.dalve.voice.sendText(text)
  } catch (err) {
    useVoiceStore.getState().addEntry({ speaker: 'system', text: errorMessage(err) })
  }
}
