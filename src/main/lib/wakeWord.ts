import log from 'electron-log/main'
import { settingsStore } from './settingsStore'

/**
 * Real, always-listening wake-word detection via Picovoice Porcupine — the two offline engines
 * tried before this were dropped for not reliably recognizing the phrase; Porcupine is a
 * purpose-built, actively-maintained wake-word engine (not a general speech-to-text model
 * repurposed for keyword spotting), so worth a real second attempt. Ships as prebuilt native
 * libraries per platform (no node-gyp compile step, unlike robotjs), loaded lazily so a machine
 * without a configured AccessKey never even touches this code path.
 *
 * Honest, stated limitation: "Hey DALVE" specifically is NOT one of Porcupine's free built-in
 * keywords (those are generic words like "Jarvis", "Computer", "Alexa") — a genuinely custom
 * "Hey DALVE" keyword requires the user to train one (free, ~2 minutes) at
 * console.picovoice.ai and point Settings at the downloaded .ppn file. Until then, one of the
 * built-ins is the real, working default.
 *
 * Runs only while no voice session is active (see voiceSession.ts's wake-word bridge in the
 * renderer) — once a real conversation is happening, wake-word detection would be redundant and
 * the mic is better left to the actual session's own capture pipeline.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let porcupine: any = null

export function isConfigured(): boolean {
  return !!settingsStore.getPicovoiceAccessKey()
}

/** Loaded lazily via dynamic import — the package is real but this keeps it fully out of the
 *  startup path for the (currently default) case where wake word is off entirely. */
async function loadPorcupine(): Promise<{
  Porcupine: new (accessKey: string, keywordPaths: string[], sensitivities: number[]) => unknown
  getBuiltinKeywordPath: (keyword: string) => string
}> {
  const mod = await import('@picovoice/porcupine-node')
  return {
    Porcupine: mod.Porcupine as never,
    getBuiltinKeywordPath: mod.getBuiltinKeywordPath as never
  }
}

export function isActive(): boolean {
  return porcupine !== null
}

/** Returns the required frame length (samples) once started — the renderer's capture pipeline
 *  must chunk audio to exactly this size before sending it over. */
export function getFrameLength(): number {
  return porcupine?.frameLength ?? 0
}

export async function start(): Promise<{ status: 'SUCCESS' | 'FAILED'; message: string; frameLength?: number }> {
  if (porcupine) return { status: 'SUCCESS', message: 'Already listening.', frameLength: porcupine.frameLength }
  const accessKey = settingsStore.getPicovoiceAccessKey()
  if (!accessKey) {
    return { status: 'FAILED', message: 'Add a free Picovoice AccessKey in Settings first (console.picovoice.ai).' }
  }
  const { keyword, customPath } = settingsStore.getWakeWordConfig()

  try {
    const { Porcupine, getBuiltinKeywordPath } = await loadPorcupine()
    let keywordPath: string
    if (keyword === 'custom') {
      if (!customPath) return { status: 'FAILED', message: 'No custom wake-word file (.ppn) set in Settings.' }
      keywordPath = customPath
    } else {
      // BuiltinWakeWord's own values (jarvis/computer/porcupine/...) are exactly the enum's
      // string values Porcupine expects — no need to go through the enum object itself.
      keywordPath = getBuiltinKeywordPath(keyword)
    }
    porcupine = new Porcupine(accessKey, [keywordPath], [0.5])
    log.info(`[wakeWord] started, keyword="${keyword}", frameLength=${(porcupine as { frameLength: number }).frameLength}`)
    return { status: 'SUCCESS', message: 'Wake-word listening started.', frameLength: (porcupine as { frameLength: number }).frameLength }
  } catch (err) {
    log.error('[wakeWord] failed to start:', err instanceof Error ? err.stack : err)
    porcupine = null
    return { status: 'FAILED', message: err instanceof Error ? err.message : String(err) }
  }
}

export function stop(): void {
  if (porcupine) {
    try {
      ;(porcupine as { release: () => void }).release()
    } catch {
      // already released or never fully initialized — nothing more to clean up
    }
  }
  porcupine = null
}

/** One frame of 16-bit PCM audio, exactly `frameLength` samples at 16kHz mono — called
 *  continuously by the renderer's dedicated wake-word capture pipeline. Fires `onDetected` the
 *  instant the configured keyword is heard. */
export function processFrame(frame: Int16Array, onDetected: () => void): void {
  if (!porcupine) return
  try {
    const index = (porcupine as { process: (f: Int16Array) => number }).process(frame)
    if (index !== -1) {
      log.info('[wakeWord] keyword detected')
      onDetected()
    }
  } catch (err) {
    log.error('[wakeWord] process() failed:', err)
  }
}
