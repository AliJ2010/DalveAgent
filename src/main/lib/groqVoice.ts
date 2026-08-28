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
import type { AgentConfig, VoiceEvent } from '@shared/types'

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
  return new Groq({ apiKey })
}

export async function startVoiceSession(agentId: string | null = null): Promise<void> {
  if (phase !== 'idle') return
  const apiKey = settingsStore.getGroqApiKey()
  if (!apiKey) throw new Error('Add your Groq API key in Settings first.')

  const agent = agentId ? (agentStore.get(agentId) ?? null) : null
  if (agentId && !agent) throw new Error('That agent no longer exists.')

  activeAgentId = agentId
  history = []
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

Never describe a physical action before actually calling the tool, and never describe an outcome (a message sent, a piece moved) until the result confirms it actually happened.`

async function runTurn(userText: string): Promise<void> {
  try {
    const client = getClient()
    const screenshot = await screenControl.captureScreenshotOnce(80)
    const content: ChatCompletionContentPart[] = [{ type: 'text', text: userText }]
    if (screenshot) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } })
    }
    history.push({ role: 'user', content })
    if (history.length === 1) history.unshift({ role: 'system', content: SYSTEM_PROMPT })

    const tools = await buildTools()
    emit({ type: 'toolActivity', active: false })

    for (let round = 0; round < 8; round++) {
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
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
      }
      emit({ type: 'toolActivity', active: false })
    }
  } catch (err) {
    log.error('[groqVoice] turn failed:', err instanceof Error ? err.stack : err)
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
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
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL })
      }
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
    log.error('[groqVoice] ElevenLabs TTS failed:', err instanceof Error ? err.stack : err)
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
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
