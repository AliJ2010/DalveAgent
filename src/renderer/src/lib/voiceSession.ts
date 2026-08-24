import { useVoiceStore } from '../state/voiceStore'
import { startAudioCapture, type AudioCaptureHandle } from './audioCapture'
import { AudioPlayer } from './audioPlayback'

let captureHandle: AudioCaptureHandle | null = null
let player: AudioPlayer | null = null
let bridgeInitialized = false

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function isSessionRunning(): boolean {
  const state = useVoiceStore.getState().sessionState
  return state !== 'idle' && state !== 'error'
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

  window.dalve.voice.onEvent((event) => {
    const store = useVoiceStore.getState()
    switch (event.type) {
      case 'state':
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
    }
  })
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
      captureHandle = await startAudioCapture((chunk) => window.dalve.voice.sendAudioChunk(chunk))
    }
  } catch (err) {
    useVoiceStore.getState().setSessionState('error')
    useVoiceStore.getState().addEntry({ speaker: 'system', text: errorMessage(err) })
  }
}

export async function stopVoiceSession(): Promise<void> {
  captureHandle?.stop()
  captureHandle = null
  await window.dalve.voice.stop()
  useVoiceStore.getState().setSessionState('idle')
}

export async function toggleVoiceSession(): Promise<void> {
  if (isSessionRunning()) {
    await stopVoiceSession()
  } else {
    await startVoiceSession(useVoiceStore.getState().activeAgentId)
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
