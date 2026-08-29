import Groq, { toFile } from 'groq-sdk'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionContentPart
} from 'groq-sdk/resources/chat/completions'
import type { BrowserWindow } from 'electron'
import { shell } from 'electron'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import { agentStore } from './agentStore'
import * as composio from './composio'
import * as screenControl from './screenControl'
import * as appControl from './appControl'
import * as windowLayout from './windowLayout'
import * as priceAxis from './priceAxis'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
import * as autonomousTask from './autonomousTask'
import * as handTracking from './handTracking'
import * as mcpClient from './mcpClient'
import { skillsStore as skillsDb, isRecording, startRecording, stopRecording, recordStep, SKILL_META_TOOLS } from './skillsStore'
import { createReminderTool, listRemindersTool, cancelReminderTool } from './scheduleStore'
import * as fileTools from './fileTools'
import type { AgentConfig, VoiceEvent } from '@shared/types'
import { DALVE_TONE_PROMPTS } from '@shared/types'

/**
 * A cascaded voice engine (Groq for STT + reasoning, ElevenLabs for speech) — an alternative to
 * geminiLive.ts, not a replacement for it (kept selectable via settingsStore.voiceEngine so a
 * problem with this newer, more moving-parts pipeline never leaves the user with no working
 * voice option). Real, stated limitation up front: neither Groq nor ElevenLabs offers a single
 * live bidirectional speech-to-speech model the way Gemini Live does — this is a genuine
 * record → transcribe → reason → synthesize → play cascade. Continuous listening and barge-in
 * (the user talking over DALVE mid-reply) are both real here, just built on top of that cascade
 * rather than provided natively: this module runs its own voice-activity detection (RMS energy
 * over the same continuous mic stream audioCapture.ts already sends) to find utterance
 * boundaries, and keeps monitoring that same stream while DALVE's own reply is playing to detect
 * the user cutting in.
 */

const CHAT_MODEL = 'qwen/qwen3.8-27b' // Groq's own docs mark this "Preview" — re-check availability if this starts 404ing
const STT_MODEL = 'whisper-large-v3-turbo'
const ELEVENLABS_MODEL = 'eleven_flash_v2_5' // lowest-latency ElevenLabs model, meant for real-time use
const SAMPLE_RATE = 16000 // matches audioCapture.ts's fixed capture rate

// Voice-activity detection: RMS-energy-based, not a proper ML VAD — a reasonable first pass
// given no live mic to tune thresholds against (same caveat as the hand-tracking constants).
// SILENCE_MS of continuous below-floor energy after real speech was heard ends the utterance.
const VAD_NOISE_FLOOR = 0.02
const VAD_SILENCE_MS = 900
const VAD_MIN_SPEECH_MS = 250
// While DALVE is speaking, the bar for "the user is interrupting" is deliberately higher than
// the normal listening floor — otherwise DALVE's own audio bleeding into the mic (no real
// hardware echo cancellation guarantee) could false-trigger a self-interruption loop.
const BARGE_IN_FLOOR = 0.06
const BARGE_IN_MS = 200

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: VoiceEvent): void {
  win?.webContents.send('voice:event', event)
}

let actionLogCounter = 0

/** Feeds the Action Timeline — reuses the tool call's OWN real result/error text rather than a
 *  synthesized description, so the timeline can never claim a step happened that didn't. */
function emitActionLog(label: string, result: Record<string, unknown>): void {
  const detail = typeof result.error === 'string' ? result.error : typeof result.result === 'string' ? result.result : undefined
  emit({
    type: 'actionLog',
    entry: {
      id: `groq_${Date.now()}_${actionLogCounter++}`,
      label,
      status: typeof result.error === 'string' ? 'error' : 'success',
      detail: detail?.slice(0, 200),
      timestamp: Date.now()
    }
  })
}

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'
let phase: Phase = 'idle'
let activeAgentId: string | null = null
let history: ChatCompletionMessageParam[] = []

// Utterance buffering + VAD state
let audioBuffer: Buffer[] = []
let speechStartedAt: number | null = null
let silenceStartedAt: number | null = null
// Barge-in watch state (active only while phase === 'speaking')
let bargeInAboveFloorSince: number | null = null

export function isSessionActive(): boolean {
  return phase !== 'idle'
}

export function getActiveAgentId(): string | null {
  return activeAgentId
}

function getClient(): Groq {
  const apiKey = settingsStore.getGroqApiKey()
  if (!apiKey) throw new Error('Add your Groq API key in Settings first.')
  // The SDK's own default (60s timeout, retried) could otherwise leave a live voice turn silently
  // "connecting" for minutes on a genuine network hang — a bounded, fast failure here means a bad
  // connection surfaces as a spoken error almost immediately instead.
  return new Groq({ apiKey, timeout: 20000, maxRetries: 1 })
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function startVoiceSession(agentId: string | null = null): Promise<void> {
  if (phase !== 'idle') return
  const apiKey = settingsStore.getGroqApiKey()
  if (!apiKey) throw new Error('Add your Groq API key in Settings first.')

  const agent = agentId ? (agentStore.get(agentId) ?? null) : null
  if (agentId && !agent) throw new Error('That agent no longer exists.')

  activeAgentId = agentId
  history = [{ role: 'system', content: buildSystemPrompt(agent) }]
  audioBuffer = []
  speechStartedAt = null
  silenceStartedAt = null
  gridTargeting.clearGrids()
  screenControl.setControlGranted(true)

  emit({ type: 'activeAgentChanged', agentId })
  phase = 'listening'
  emit({ type: 'state', state: 'listening' })
}

export function stopVoiceSession(): void {
  if (phase === 'idle') return
  phase = 'idle'
  activeAgentId = null
  history = []
  audioBuffer = []
  screenControl.stopAll()
  emit({ type: 'state', state: 'idle' })
}

export function sendText(text: string): void {
  if (phase === 'idle') return
  void runTurn(text)
}

/** Called continuously (every ~256ms chunk) for the whole session, regardless of phase — the
 *  same continuous stream both finds utterance boundaries while listening AND watches for
 *  barge-in while DALVE is speaking. */
export function sendAudioChunk(base64Pcm16: string): void {
  if (phase === 'idle') return
  const buf = Buffer.from(base64Pcm16, 'base64')
  const rms = computeRms(buf)

  if (phase === 'speaking') {
    checkBargeIn(rms)
    return
  }
  if (phase !== 'listening') return // 'thinking' — a reply is already in flight, ignore mic input

  audioBuffer.push(buf)
  const now = Date.now()
  if (rms > VAD_NOISE_FLOOR) {
    if (speechStartedAt === null) speechStartedAt = now
    silenceStartedAt = null
  } else if (speechStartedAt !== null) {
    if (silenceStartedAt === null) silenceStartedAt = now
    else if (now - silenceStartedAt > VAD_SILENCE_MS && now - speechStartedAt > VAD_MIN_SPEECH_MS) {
      const finished = Buffer.concat(audioBuffer)
      audioBuffer = []
      speechStartedAt = null
      silenceStartedAt = null
      phase = 'thinking'
      emit({ type: 'state', state: 'connecting' })
      void handleUtterance(finished)
    }
  }
}

function computeRms(pcm16: Buffer): number {
  const samples = pcm16.length / 2
  if (samples === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples; i++) {
    const s = pcm16.readInt16LE(i * 2) / 0x8000
    sumSquares += s * s
  }
  return Math.sqrt(sumSquares / samples)
}

function checkBargeIn(rms: number): void {
  const now = Date.now()
  if (rms > BARGE_IN_FLOOR) {
    if (bargeInAboveFloorSince === null) bargeInAboveFloorSince = now
    else if (now - bargeInAboveFloorSince > BARGE_IN_MS) {
      bargeInAboveFloorSince = null
      log.info('[groqVoice] barge-in detected, interrupting playback')
      emit({ type: 'interrupted' })
      phase = 'listening'
      emit({ type: 'state', state: 'listening' })
      audioBuffer = []
      speechStartedAt = Date.now() // the interrupting speech has already started
      silenceStartedAt = null
    }
  } else {
    bargeInAboveFloorSince = null
  }
}

/** 44-byte canonical WAV header wrapping raw 16kHz mono PCM16 — Groq's transcription endpoint
 *  wants a real container format, not bare PCM bytes. */
function wrapWav(pcm16: Buffer): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = SAMPLE_RATE * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm16.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm16.length, 40)
  return Buffer.concat([header, pcm16])
}

async function handleUtterance(pcm16: Buffer): Promise<void> {
  try {
    const client = getClient()
    const wav = wrapWav(pcm16)
    const transcription = await client.audio.transcriptions.create({
      model: STT_MODEL,
      file: await toFile(wav, 'utterance.wav', { type: 'audio/wav' })
    })
    const text = transcription.text.trim()
    if (!text) {
      phase = 'listening'
      emit({ type: 'state', state: 'listening' })
      return
    }
    emit({ type: 'inputTranscript', text, finished: true })
    await runTurn(text)
  } catch (err) {
    log.error('[groqVoice] utterance handling failed:', err instanceof Error ? err.stack : err)
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    phase = 'listening'
    emit({ type: 'state', state: 'listening' })
  }
}

const SYSTEM_PROMPT = `You are DALVE, a voice-first AI operating system, talking with the user through voice (Groq + ElevenLabs pipeline). Speak naturally and conversationally, concise since this is spoken. Get straight to doing what's asked — never repeat the instruction back before acting. You have standing authorization to click/type/control the screen and browser once asked; no separate permission tool needed. The only hard limit: never type a password, payment card number, or other credential yourself.

Real targeting priority, strongest to weakest: (1) A direct integration tool (Composio/MCP) if one exists. (2) browser_* tools for anything web-based — real DOM lookup, not a coordinate guess. (3) click_element for native desktop apps with a visible label. (4) click_mouse/move_mouse from the screenshot you're given — last resort, for non-textual content only. For an exact price on a trading chart, always use click_price_level, never click_mouse. For grid/board content (chess, spreadsheets), use define_grid + click_grid_cell.

Never describe a physical action before actually calling the tool, and never describe an outcome (a message sent, a piece moved) until the result confirms it actually happened.

A single instruction often spans multiple applications — "read the price in this email, put it into Excel, work out the margin, send the result on WhatsApp" is ONE task. Switching which app you're acting in partway through is not a stopping point — carry whatever value you just read forward into the next app yourself, across as many tool-call rounds as it takes, and keep going until the whole chain is actually done.

IMPORTANT structural limit to understand about yourself: this engine only ever takes a turn when the user just spoke — there is no continuous screen watching here at all, unlike a fully live session. Nothing "wakes you up" on its own when a new WhatsApp message arrives while the user isn't talking to you. That is exactly what start_autonomous_task is for — a separate background loop that actively re-checks the screen every ~20 seconds and can act with nobody present. Whenever what's being asked amounts to "keep doing this without me talking to you" — monitoring a chat (WhatsApp especially) and replying to new messages as they come in is the single most common real case — you MUST call start_autonomous_task, every time. Give it a clear one-sentence goal; it keeps going until the goal is done, the user stops it, or you call stop_autonomous_task.`

/** Builds the ACTUAL system prompt for a session — a real bug existed here before: this engine
 *  always used the generic SYSTEM_PROMPT below regardless of which agent was active, and never
 *  read back either DALVE's own saved memory or an agent's memory, so remember_fact genuinely
 *  persisted facts (see the 'remember_fact' case below) that this engine then never saw again —
 *  "it says it has memory... but it doesn't look like it" was real, not imagined. Mirrors
 *  geminiLive.ts's equivalent construction so both engines behave the same way here. */
function buildSystemPrompt(agent: AgentConfig | null): string {
  const base = agent ? agent.systemPrompt : SYSTEM_PROMPT
  const memory = agent ? agent.memory : settingsStore.getDalveMemory()
  const memoryNote = memory ? `\n\nThings you've saved to remember from earlier conversations:\n${memory}` : ''
  // Tone applies to DALVE herself only, not sub-agents — an agent's own systemPrompt is already
  // an authored persona the user opted into when creating it, matching geminiLive.ts's reasoning.
  const tone = settingsStore.getDalveTone()
  const toneNote = !agent && tone !== 'default' ? `\n\n${DALVE_TONE_PROMPTS[tone]}` : ''
  return base + toneNote + memoryNote
}

// Groq's free tier caps this model at 8,000 tokens/minute AND 3 images per request — confirmed
// live from real logs showing repeated 413 "tokens per minute" and 400 "too many images" errors.
// A full-resolution screenshot resent on every turn (history kept every prior one, unbounded)
// blew past both limits within a handful of exchanges. maxWidth shrinks each screenshot before
// it's ever added; stripOldImages/trimHistory keep old ones from piling up turn after turn.
const SCREENSHOT_MAX_WIDTH = 1024
const SCREENSHOT_QUALITY = 65
const MAX_HISTORY_MESSAGES = 12

/** Keeps only the most recent screenshot in the whole conversation — every earlier one becomes a
 *  short text stand-in instead of being resent (and re-billed) on every subsequent turn. */
function stripOldImages(msgs: ChatCompletionMessageParam[]): void {
  let sawImage = false
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    if (!msg.content.some((p) => p.type === 'image_url')) continue
    if (sawImage) {
      msg.content = [
        ...msg.content.filter((p) => p.type !== 'image_url'),
        { type: 'text', text: '[earlier screenshot omitted]' }
      ]
    } else {
      sawImage = true
    }
  }
}

/** Keeps the system prompt plus only the most recent exchanges — otherwise token usage grows
 *  unbounded turn after turn regardless of images, and reliably blows the 8K TPM limit by itself. */
function trimHistory(): void {
  if (history.length <= MAX_HISTORY_MESSAGES) return
  const hasSystem = history[0]?.role === 'system'
  const system = hasSystem ? [history[0]] : []
  history = [...system, ...history.slice(-(MAX_HISTORY_MESSAGES - system.length))]
}

function friendlyTurnError(raw: string): string {
  if (raw.includes('rate_limit_exceeded')) {
    return "Groq's free-tier rate limit was hit for that reply — wait a few seconds and try again, or ask something shorter."
  }
  if (raw.includes('Too many images')) {
    return 'That request carried too many images for this model — try again, it should self-correct now.'
  }
  return raw
}

async function runTurn(userText: string): Promise<void> {
  try {
    const client = getClient()
    const screenshot = await screenControl.captureScreenshotOnce(SCREENSHOT_QUALITY, SCREENSHOT_MAX_WIDTH)
    // Appended per-turn (not baked into the cached system message) so it's always accurate even
    // in a session that's been open for hours — needed for create_reminder to resolve relative
    // times ("tomorrow", "in an hour") correctly regardless of how long the session's been running.
    const content: ChatCompletionContentPart[] = [{ type: 'text', text: `${userText}\n\n[Current date/time: ${new Date().toString()}]` }]
    if (screenshot) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } })
    }
    // Defensive fallback only — startVoiceSession always seeds this now; kept in case this is
    // ever reached with no active session.
    if (history.length === 0) {
      const agent = activeAgentId ? (agentStore.get(activeAgentId) ?? null) : null
      history.push({ role: 'system', content: buildSystemPrompt(agent) })
    }
    history.push({ role: 'user', content })
    stripOldImages(history)
    trimHistory()

    const tools = await buildTools()
    emit({ type: 'toolActivity', active: false })

    // Raised from 8 — a real cross-app task (read a value in one app, switch to another, act on
    // it, switch again) can easily need more tool-call rounds than a single-app action, and the
    // old cap silently dropped the turn with zero explanation if it ran out mid-chain.
    const MAX_ROUNDS = 16
    let exhausted = true
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: history,
        tools,
        max_tokens: 1024
      })
      const message = response.choices[0]?.message
      if (!message) break
      history.push(message)

      if (!message.tool_calls || message.tool_calls.length === 0) {
        const text = message.content ?? ''
        if (text) await speak(text)
        exhausted = false
        break
      }

      emit({ type: 'toolActivity', active: true, label: message.tool_calls[0]?.function?.name })
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {
          // malformed args — executeVoiceTool below will just see an empty object
        }
        let result: Record<string, unknown>
        try {
          result = await executeVoiceTool(call.function.name, args)
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
        }
        emitActionLog(call.function.name, result)
        if (isRecording() && !SKILL_META_TOOLS.has(call.function.name) && typeof result.error !== 'string' && result.status !== 'FAILED') {
          recordStep(call.function.name, args)
        }
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
      }
      emit({ type: 'toolActivity', active: false })
    }

    // Same honest "ran out of room" acknowledgment autonomousTask.ts already gives on its own
    // round cap — silence here would look exactly like the "stuck" symptom this session already
    // root-caused once tonight, just from a different limit.
    if (exhausted) await speak("I've made progress on that but hit my step limit for one reply — tell me to continue and I'll keep going from here.")
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    log.error('[groqVoice] turn failed:', err instanceof Error ? err.stack : err)
    emit({ type: 'error', message: friendlyTurnError(raw) })
  } finally {
    if (phase !== 'idle') {
      phase = 'listening'
      emit({ type: 'state', state: 'listening' })
      emit({ type: 'turnComplete' })
    }
  }
}

async function speak(text: string): Promise<void> {
  emit({ type: 'outputTranscript', text, finished: true })
  const apiKey = settingsStore.getElevenLabsApiKey()
  // A per-agent voice (set in that agent's Voice tab) wins over the global default — otherwise
  // every agent sounds identical under this engine, which defeats the point of having several.
  const agentVoiceId = activeAgentId ? agentStore.get(activeAgentId)?.elevenLabsVoiceId : undefined
  const voiceId = agentVoiceId ?? settingsStore.getState().elevenLabsVoiceId
  if (!apiKey || !voiceId) {
    log.info('[groqVoice] no ElevenLabs key/voice configured — replying as text only')
    return
  }

  phase = 'speaking'
  emit({ type: 'state', state: 'speaking' })
  bargeInAboveFloorSince = null

  try {
    const res = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL })
      },
      20000
    )
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`)
    const audioBytes = Buffer.from(await res.arrayBuffer())

    // Chunked, not sent as one giant base64 blob — matches the same streaming-friendly shape
    // the renderer's AudioPlayer already expects from geminiLive.ts (many small `audio` events
    // scheduled back-to-back), and lets barge-in interrupt mid-utterance rather than only
    // between whole replies.
    const CHUNK_BYTES = 24000 // 0.5s of 24kHz mono PCM16
    for (let offset = 0; offset < audioBytes.length; offset += CHUNK_BYTES) {
      if (phase !== 'speaking') return // interrupted mid-stream
      const chunk = audioBytes.subarray(offset, offset + CHUNK_BYTES)
      emit({ type: 'audio', data: chunk.toString('base64') })
    }
  } catch (err) {
    // speak() is only ever called from inside runTurn()'s try block, whose `finally` resets
    // phase/state back to listening once this returns — no reset needed here either way.
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    log.error('[groqVoice] ElevenLabs TTS failed:', err instanceof Error ? err.stack : err)
    emit({
      type: 'error',
      message: isTimeout ? 'ElevenLabs took too long to respond — try again.' : err instanceof Error ? err.message : String(err)
    })
  }
}

// --- Tool declarations (OpenAI/Groq function-calling shape) ---

function tool(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionTool {
  return { type: 'function', function: { name, description, parameters } }
}

const SPEED_ENUM = { type: 'string', enum: ['instant', 'visible'] }
const BUTTON_ENUM = { type: 'string', enum: ['left', 'right', 'middle'] }

const STATIC_TOOLS: ChatCompletionTool[] = [
  tool('open_url', "Open a website in the user's default browser.", {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }),
  tool('open_application', 'Opens a native application by name using the OS launch mechanism. Always prefer this over hunting through the Start Menu visually.', {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  }),
  tool('activate_application', 'Brings an already-running application to the front by name.', {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  }),
  tool('fullscreen_window', 'Toggles native fullscreen/maximize on the current frontmost window.', { type: 'object', properties: {} }),
  tool('open_trading_setup', "Sets up the user's trading workspace across monitors (TradingView + Discord + Tradovate). Windows only.", { type: 'object', properties: {} }),
  tool('start_hand_tracking', "Turns on the webcam and tracks the user's hand as a real cursor (pinch to click).", { type: 'object', properties: {} }),
  tool('stop_hand_tracking', 'Turns off hand tracking and releases the webcam.', { type: 'object', properties: {} }),
  tool('create_agent', 'Create a new companion or bot agent for the user.', {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['companion', 'bot'] },
      description: { type: 'string' }
    },
    required: ['name']
  }),
  tool('list_agents', 'Lists every agent that currently exists.', { type: 'object', properties: {} }),
  tool('remember_fact', 'Saves a fact for later — permanent memory.', {
    type: 'object',
    properties: { fact: { type: 'string' } },
    required: ['fact']
  }),
  tool('move_mouse', 'Moves the mouse to a pixel position on screen (from the screenshot you were given) without clicking.', {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, speed: SPEED_ENUM },
    required: ['x', 'y']
  }),
  tool('click_mouse', 'Moves to and clicks a pixel position on screen. Last resort — prefer browser_click/click_element first.', {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['x', 'y']
  }),
  tool('drag_mouse', 'A real press-move-release drag gesture.', {
    type: 'object',
    properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, speed: SPEED_ENUM },
    required: ['fromX', 'fromY', 'toX', 'toY']
  }),
  tool('click_price_level', 'Clicks/right-clicks an EXACT price on a trading chart — reads the real price scale instead of guessing a coordinate. Always use this over click_mouse for anything price-specific.', {
    type: 'object',
    properties: { price: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, x: { type: 'number' } },
    required: ['price']
  }),
  tool('browser_open', "Opens a URL in DALVE's own dedicated automation browser — real DOM control, not coordinate guessing. Strongly prefer this for anything web-based.", {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }),
  tool('browser_click', 'Clicks a real element in the automation browser by its actual visible text/label.', {
    type: 'object',
    properties: { description: { type: 'string' } },
    required: ['description']
  }),
  tool('browser_type', 'Clicks a field in the automation browser by label/placeholder then types into it.', {
    type: 'object',
    properties: { fieldDescription: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
    required: ['fieldDescription', 'text']
  }),
  tool('browser_read_text', 'Real visible text of the automation browser page right now.', { type: 'object', properties: {} }),
  tool('browser_press_key', 'Presses a key in the automation browser.', {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key']
  }),
  tool('find_elements', 'Lists every real accessible UI element currently on screen (native desktop apps).', { type: 'object', properties: {} }),
  tool('click_element', 'Clicks something in a native desktop app by its real OS accessibility name (falls back to OCR).', {
    type: 'object',
    properties: { name: { type: 'string' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['name']
  }),
  tool('read_screen_text', 'Real OCR text of everything currently visible on screen.', { type: 'object', properties: {} }),
  tool('click_text', 'Clicks text found via OCR anywhere on screen.', {
    type: 'object',
    properties: { text: { type: 'string' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['text']
  }),
  tool('define_grid', "Registers a non-web grid/board's pixel boundary (chess, spreadsheets) so click_grid_cell can click exact cells.", {
    type: 'object',
    properties: {
      label: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      rows: { type: 'number' },
      cols: { type: 'number' }
    },
    required: ['label', 'x', 'y', 'width', 'height', 'rows', 'cols']
  }),
  tool('click_grid_cell', 'Clicks one exact cell of a previously-defined grid by row/col.', {
    type: 'object',
    properties: { label: { type: 'string' }, row: { type: 'number' }, col: { type: 'number' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['label', 'row', 'col']
  }),
  tool('type_text', 'Types literal text at the current OS-level focus.', {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  }),
  tool('press_key', 'Presses a single OS-level key, optionally with modifiers.', {
    type: 'object',
    properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } },
    required: ['key']
  }),
  tool('scroll', 'Scrolls at the current mouse position.', {
    type: 'object',
    properties: { deltaX: { type: 'number' }, deltaY: { type: 'number' } }
  }),
  tool('take_screenshot', "Saves a real screenshot of the user's screen as a PNG file they can open later — distinct from the automatic vision context DALVE already sees every turn.", { type: 'object', properties: {} }),
  tool('undo_last_typed_text', "Sends the active app's own undo (Ctrl+Z) to revert the last text DALVE typed. Only works immediately after typing, before a click/drag/Enter/send happened since — honestly refuses otherwise rather than pretending a click or sent message can be undone this way.", { type: 'object', properties: {} }),
  tool('start_recording_skill', "Starts recording every action DALVE takes from now on, until stop_recording_skill is called. Use when the user asks to teach/show DALVE how to do something so it can repeat it later — they'll walk through the steps live by voice as usual.", { type: 'object', properties: {} }),
  tool('stop_recording_skill', 'Stops recording and saves everything done since start_recording_skill as a named, replayable skill.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('run_skill', 'Replays a previously recorded skill by name, step by step.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('list_skills', 'Lists every recorded skill by name.', { type: 'object', properties: {} }),
  tool('create_reminder', 'Schedules a reminder or recurring action for a future time, shown on the Calendar tab. Compute dueAtIso yourself as a real ISO 8601 datetime from what the user said, using the current date/time given to you each turn. type "reminder" just notifies at the time; type "message" actually performs `instruction` when due (e.g. "Send Ali on WhatsApp: don\'t forget the meeting").', {
    type: 'object',
    properties: {
      title: { type: 'string' },
      dueAtIso: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-08-29T15:00:00' },
      recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] },
      type: { type: 'string', enum: ['reminder', 'message'] },
      instruction: { type: 'string', description: 'Required for type "message" — the action to perform when due.' }
    },
    required: ['title', 'dueAtIso', 'recurrence', 'type']
  }),
  tool('list_reminders', 'Lists every upcoming reminder and scheduled message.', { type: 'object', properties: {} }),
  tool('cancel_reminder', 'Cancels a reminder or scheduled message by its exact title.', { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }),
  tool('list_common_folders', "Returns the user's real Home/Desktop/Documents/Downloads/Pictures folder paths — use this to build real file paths instead of guessing them.", { type: 'object', properties: {} }),
  tool('list_directory', 'Lists files and subfolders in a real directory path.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('read_text_file', 'Reads a plain text/code/markdown/csv/json file. For PDFs or images use read_document instead.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('write_text_file', 'Writes (or appends to) a plain text file, creating it if it does not exist.', {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
    required: ['path', 'content']
  }),
  tool('delete_file', 'Moves a file to the Recycle Bin (recoverable, not a permanent delete).', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('move_file', 'Moves or renames a file from one path to another.', { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }),
  tool('search_files', 'Searches for files by (partial, case-insensitive) filename under a directory, recursively.', { type: 'object', properties: { directory: { type: 'string' }, query: { type: 'string' } }, required: ['directory', 'query'] }),
  tool('read_document', 'Reads a document by real file path — text/code/markdown/csv/json directly, PDFs via real text extraction, images attached as vision content for you to actually see. .docx and other office formats are not supported yet.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('read_clipboard', "Reads the current text on the user's OS clipboard.", { type: 'object', properties: {} }),
  tool('write_clipboard', "Sets the user's OS clipboard to the given text.", { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
  tool('start_autonomous_task', 'Hands off a task to a background loop that keeps watching the screen and acting even after this conversation ends.', {
    type: 'object',
    properties: { goal: { type: 'string' } },
    required: ['goal']
  }),
  tool('stop_autonomous_task', 'Stops the background autonomous task.', { type: 'object', properties: {} })
]

async function buildTools(): Promise<ChatCompletionTool[]> {
  const tools = [...STATIC_TOOLS]

  const composioConnections = settingsStore.getState().composioConnections.filter((c) => c.connected)
  if (composioConnections.length > 0) {
    try {
      const composioTools = await composio.getToolsForApps(composioConnections.map((c) => c.appKey))
      tools.push(...composioTools.map((t) => tool(t.name ?? '', t.description ?? '', (t.parametersJsonSchema as Record<string, unknown>) ?? {})))
    } catch (err) {
      log.error('[groqVoice] failed to load Composio tools:', err)
    }
  }

  for (const decl of mcpClient.listToolDeclarations()) {
    tools.push(tool(decl.name, decl.description ?? '', decl.parametersJsonSchema))
  }

  return tools
}

async function executeVoiceTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'open_url': {
      const url = String(args.url ?? '')
      await shell.openExternal(url)
      return { result: `Opened ${url}` }
    }
    case 'open_application': {
      const { result, message } = await appControl.openApplication(String(args.name ?? ''))
      return { status: result, result: message }
    }
    case 'activate_application': {
      const { result, message } = await appControl.activateApplication(String(args.name ?? ''))
      return { status: result, result: message }
    }
    case 'fullscreen_window': {
      const { result, message } = await appControl.fullscreenFrontmostWindow()
      return { status: result, result: message }
    }
    case 'open_trading_setup': {
      const { status, message } = await windowLayout.openTradingSetup()
      return { status, result: message }
    }
    case 'start_hand_tracking': {
      const { status, message } = handTracking.start()
      return { status, result: message }
    }
    case 'stop_hand_tracking': {
      const { status, message } = handTracking.stop()
      return { status, result: message }
    }
    case 'create_agent': {
      const type = args.type === 'bot' ? 'bot' : 'companion'
      const agent = agentStore.create({
        name: String(args.name ?? 'New Agent'),
        type,
        parentId: null,
        systemPrompt: String(args.description ?? ''),
        color: '#d4af37'
      })
      return { result: `Created ${agent.type} "${agent.name}".` }
    }
    case 'list_agents': {
      const agents = agentStore.list().filter((a: AgentConfig) => !a.archived)
      return { result: agents.length === 0 ? 'No other agents exist yet.' : agents.map((a) => `- ${a.name} (${a.type})`).join('\n') }
    }
    case 'remember_fact': {
      const fact = String(args.fact ?? '').trim()
      if (!fact) return { error: 'No fact given.' }
      if (activeAgentId) {
        const agent = agentStore.get(activeAgentId)
        if (agent) agentStore.update(agent.id, { memory: agent.memory ? `${agent.memory}\n- ${fact}` : `- ${fact}` })
      } else {
        settingsStore.appendDalveMemory(fact)
      }
      return { result: 'Saved.' }
    }
    case 'move_mouse':
      await screenControl.moveMouse(Number(args.x), Number(args.y), (args.speed as 'instant' | 'visible') ?? 'visible')
      return { result: 'Moved.' }
    case 'click_mouse':
      await screenControl.clickMouse(
        Number(args.x),
        Number(args.y),
        (args.button as 'left' | 'right' | 'middle') ?? 'left',
        Boolean(args.double),
        (args.speed as 'instant' | 'visible') ?? 'visible'
      )
      return { result: 'Clicked.' }
    case 'drag_mouse':
      await screenControl.dragMouse(Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY), (args.speed as 'instant' | 'visible') ?? 'visible')
      return { result: 'Dragged.' }
    case 'click_price_level': {
      const price = Number(args.price)
      const located = await priceAxis.locatePriceY(price)
      if (!located.found || located.y === undefined) {
        return { status: 'FAILED', error: located.error ?? `Could not locate price ${price} on screen.` }
      }
      const frame = screenControl.getFrameSize()
      const targetX = args.x !== undefined ? Number(args.x) : Math.round(frame.width * 0.6)
      await screenControl.clickMouse(targetX, located.y, (args.button as 'left' | 'right') ?? 'left', false, 'visible')
      return { status: 'SUCCESS', result: `Clicked at price ${price} (y=${located.y}, calibrated from ${located.samples} price labels).` }
    }
    case 'browser_open': {
      const info = await browserControl.openUrl(String(args.url ?? ''))
      return { result: `Opened. title="${info.title}" url=${info.url}` }
    }
    case 'browser_click':
      return await browserControl.clickByDescription(String(args.description ?? ''))
    case 'browser_type':
      return await browserControl.typeIntoField(String(args.fieldDescription ?? ''), String(args.text ?? ''), Boolean(args.pressEnter))
    case 'browser_read_text':
      return { result: await browserControl.getVisibleText() }
    case 'browser_press_key':
      await browserControl.pressKey(String(args.key ?? ''))
      return { result: 'Pressed.' }
    case 'find_elements': {
      if (!uiAutomation.isSupported()) return { error: 'UI element reading is not implemented on this platform.' }
      const elements = await uiAutomation.findElementsReliable()
      return { result: elements.slice(0, 80).map((e) => `${e.name} (${e.controlType}${e.isEnabled ? '' : ', disabled'})`).join('\n') }
    }
    case 'click_element': {
      const targetName = String(args.name ?? '').trim()
      const button = (args.button as 'left' | 'right' | 'middle') ?? 'left'
      const double = Boolean(args.double)
      const speed = (args.speed as 'instant' | 'visible') ?? 'visible'
      if (!targetName) return { error: 'No element name given.' }
      const uiResult = uiAutomation.isSupported() ? await uiAutomation.locateElement(targetName) : null
      if (uiResult?.found && uiResult.centerX !== undefined && uiResult.centerY !== undefined) {
        await screenControl.clickMouse(uiResult.centerX, uiResult.centerY, button, double, speed)
        return { status: 'SUCCESS', result: `Clicked "${uiResult.element?.name}" via accessibility data.` }
      }
      const ocrResult = await ocr.locateText(targetName)
      if (ocrResult.found && ocrResult.centerX !== undefined && ocrResult.centerY !== undefined) {
        await screenControl.clickMouse(ocrResult.centerX, ocrResult.centerY, button, double, speed)
        return { status: 'SUCCESS', result: `Clicked "${ocrResult.line?.text}" via OCR.` }
      }
      return { status: 'FAILED', error: `"${targetName}" wasn't found via accessibility data or OCR.` }
    }
    case 'read_screen_text': {
      const lines = await ocr.readScreenText()
      return { result: lines.length ? lines.map((l) => l.text).join('\n') : 'No text recognized on screen right now.' }
    }
    case 'click_text': {
      const targetText = String(args.text ?? '').trim()
      if (!targetText) return { error: 'No text given.' }
      const located = await ocr.locateText(targetText)
      if (!located.found || located.centerX === undefined || located.centerY === undefined) {
        return { status: 'FAILED', error: `OCR didn't find text matching "${targetText}".` }
      }
      await screenControl.clickMouse(located.centerX, located.centerY, (args.button as 'left' | 'right' | 'middle') ?? 'left', Boolean(args.double), (args.speed as 'instant' | 'visible') ?? 'visible')
      return { status: 'SUCCESS', result: `Clicked text "${located.line?.text}".` }
    }
    case 'define_grid':
      gridTargeting.defineGrid(String(args.label ?? '').trim(), {
        x: Number(args.x),
        y: Number(args.y),
        width: Number(args.width),
        height: Number(args.height),
        rows: Math.max(1, Math.round(Number(args.rows))),
        cols: Math.max(1, Math.round(Number(args.cols)))
      })
      return { result: 'Grid registered.' }
    case 'click_grid_cell': {
      const cell = gridTargeting.cellCenter(String(args.label ?? '').trim(), Math.round(Number(args.row)), Math.round(Number(args.col)))
      if (!cell.found || cell.centerX === undefined || cell.centerY === undefined) return { status: 'FAILED', error: cell.error ?? 'Cell not found.' }
      await screenControl.clickMouse(cell.centerX, cell.centerY, (args.button as 'left' | 'right' | 'middle') ?? 'left', Boolean(args.double), (args.speed as 'instant' | 'visible') ?? 'visible')
      return { status: 'SUCCESS', result: `Clicked row ${args.row}, col ${args.col}.` }
    }
    case 'type_text':
      screenControl.typeText(String(args.text ?? ''))
      return { result: 'Typed.' }
    case 'press_key':
      screenControl.pressKey(String(args.key ?? ''), (args.modifiers as string[]) ?? [])
      return { result: 'Pressed.' }
    case 'scroll':
      screenControl.scroll(Number(args.deltaX ?? 0), Number(args.deltaY ?? 0))
      return { result: 'Scrolled.' }
    case 'take_screenshot': {
      const { status, path, message } = await screenControl.saveScreenshot()
      return { status, path, result: message }
    }
    case 'undo_last_typed_text': {
      const { status, message } = screenControl.undoLastTypedText()
      return { status, result: message }
    }
    case 'start_recording_skill':
      startRecording()
      return { result: "Recording started — I'll save everything I do from now on once you tell me to stop." }
    case 'stop_recording_skill': {
      const name = String(args.name ?? '').trim()
      if (!name) return { error: 'Need a name to save this skill as.' }
      const skill = stopRecording(name)
      if (!skill) return { error: 'Nothing was recorded — start_recording_skill needs to be called first, and at least one action needs to happen.' }
      return { status: 'SUCCESS', result: `Saved "${name}" as a skill with ${skill.steps.length} step(s).` }
    }
    case 'run_skill': {
      const name = String(args.name ?? '').trim()
      const skill = skillsDb.get(name)
      if (!skill) return { status: 'FAILED', error: `No skill named "${name}".` }
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i]
        let stepResult: Record<string, unknown>
        try {
          stepResult = await executeVoiceTool(step.tool, step.args)
        } catch (err) {
          stepResult = { error: err instanceof Error ? err.message : String(err) }
        }
        emitActionLog(`${step.tool} (skill: ${name})`, stepResult)
        if (typeof stepResult.error === 'string' || stepResult.status === 'FAILED') {
          return {
            status: 'FAILED',
            error: `Skill "${name}" stopped at step ${i + 1}/${skill.steps.length} (${step.tool}): ${stepResult.error ?? stepResult.result}`
          }
        }
      }
      return { status: 'SUCCESS', result: `Replayed all ${skill.steps.length} step(s) of "${name}".` }
    }
    case 'list_skills': {
      const skills = skillsDb.list()
      return { result: skills.length === 0 ? 'No skills recorded yet.' : skills.map((s) => `- ${s.name} (${s.steps.length} steps)`).join('\n') }
    }
    case 'create_reminder':
      return createReminderTool(args)
    case 'list_reminders':
      return { result: listRemindersTool() }
    case 'cancel_reminder':
      return cancelReminderTool(String(args.title ?? ''))
    case 'list_common_folders':
      return { result: JSON.stringify(fileTools.listCommonFolders()) }
    case 'list_directory':
      return await fileTools.listDirectory(String(args.path ?? ''))
    case 'read_text_file':
      return await fileTools.readTextFile(String(args.path ?? ''))
    case 'write_text_file':
      return await fileTools.writeTextFile(String(args.path ?? ''), String(args.content ?? ''), Boolean(args.append))
    case 'delete_file':
      return await fileTools.deleteFile(String(args.path ?? ''))
    case 'move_file':
      return await fileTools.moveFile(String(args.from ?? ''), String(args.to ?? ''))
    case 'search_files':
      return await fileTools.searchFiles(String(args.directory ?? ''), String(args.query ?? ''))
    case 'read_document': {
      const doc = await fileTools.readDocument(String(args.path ?? ''))
      if (doc.imageBase64) {
        // Attached directly onto history (not just returned as a tool result) so the model
        // actually sees it as vision content on the next round — the same mechanism already used
        // for screenshots. stripOldImages() on the next utterance demotes this once superseded.
        history.push({
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:${doc.mimeType};base64,${doc.imageBase64}` } }]
        })
        return { status: 'SUCCESS', result: 'Image attached above — look at it directly.' }
      }
      return { status: doc.status, result: doc.text, error: doc.error }
    }
    case 'read_clipboard':
      return { result: fileTools.readClipboardText() }
    case 'write_clipboard':
      fileTools.writeClipboardText(String(args.text ?? ''))
      return { result: 'Clipboard set.' }
    case 'start_autonomous_task': {
      const goal = String(args.goal ?? '').trim()
      if (!goal) return { error: 'No goal given.' }
      autonomousTask.startAutonomousTask(goal)
      return { result: `Started — I'll keep handling "${goal}" in the background.` }
    }
    case 'stop_autonomous_task':
      autonomousTask.stopAutonomousTask('stopped by DALVE')
      return { result: 'Stopped the background task.' }
    default:
      if (mcpClient.isMcpTool(name)) return await mcpClient.callMcpTool(name, args)
      return { result: await composio.executeComposioTool(name, args) }
  }
}
