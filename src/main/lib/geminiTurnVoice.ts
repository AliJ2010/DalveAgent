import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai'
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
import * as steeringWheel from './steeringWheel'
import * as mcpClient from './mcpClient'
import { skillsStore as skillsDb, isRecording, startRecording, stopRecording, recordStep, SKILL_META_TOOLS } from './skillsStore'
import { createReminderTool, listRemindersTool, cancelReminderTool } from './scheduleStore'
import * as fileTools from './fileTools'
import type { AgentConfig, VoiceEvent } from '@shared/types'
import { DALVE_TONE_PROMPTS } from '@shared/types'

/**
 * A cascaded voice engine (Gemini's non-live generateContent for STT + reasoning, ElevenLabs for
 * speech) — an alternative to geminiLive.ts's true bidirectional streaming session, not a
 * replacement for it (kept selectable via settingsStore.voiceEngine so a problem with this
 * turn-based pipeline never leaves the user with no working voice option). This REPLACED an
 * earlier Groq-backed version of this same engine — real reported failure: Groq's free tier
 * rate-limited on essentially every turn, and a fix (skip re-attaching a screenshot on every
 * turn) wasn't enough to make it reliable. Gemini's own free tier is dramatically more generous
 * (hundreds of thousands of tokens/minute vs. Groq's flat 8,000), and reuses the SAME Gemini API
 * key already configured for Live — no new signup, no separate credential. Real, stated
 * limitation up front: this is a genuine record → transcribe+reason (one generateContent call,
 * since Gemini understands audio directly) → synthesize → play cascade, not a single live
 * bidirectional model the way Gemini Live is. Continuous listening and barge-in (the user talking
 * over DALVE mid-reply) are both real here, just built on top of that cascade: this module runs
 * its own voice-activity detection (RMS energy over the same continuous mic stream
 * audioCapture.ts already sends) to find utterance boundaries, and keeps monitoring that same
 * stream while DALVE's own reply is playing to detect the user cutting in.
 */

// Re-check https://ai.google.dev/gemini-api/docs/models before shipping — Google rotates these.
const CHAT_MODEL = 'gemini-3.6-flash'
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
      id: `geminiTurns_${Date.now()}_${actionLogCounter++}`,
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
// Gemini's Content history — role 'user'|'model', each with `parts`. Distinct from geminiLive.ts
// (a true live session with no client-held history) and from the old Groq engine's OpenAI-shaped
// ChatCompletionMessageParam[] — this is Gemini's own multi-turn function-calling shape.
let history: Content[] = []
let systemPromptText = ''

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

function getClient(): GoogleGenAI {
  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) throw new Error('Add your Gemini API key in Settings first.')
  return new GoogleGenAI({ apiKey })
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
  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) throw new Error('Add your Gemini API key in Settings first.')

  const agent = agentId ? (agentStore.get(agentId) ?? null) : null
  if (agentId && !agent) throw new Error('That agent no longer exists.')

  activeAgentId = agentId
  systemPromptText = buildSystemPrompt(agent)
  history = []
  audioBuffer = []
  speechStartedAt = null
  silenceStartedAt = null
  lastScreenshotAttachedAt = 0
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
  lastScreenshotAttachedAt = 0
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
      log.info('[geminiTurnVoice] barge-in detected, interrupting playback')
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

/** 44-byte canonical WAV header wrapping raw 16kHz mono PCM16 — Gemini's audio understanding
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
    // A separate, cheap, tools-free call just to get plain text — keeps the main tool-calling
    // turn's history as clean text rather than re-sending raw audio in every subsequent request
    // for the rest of the conversation.
    const result = await client.models.generateContent({
      model: CHAT_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
            { text: 'Transcribe exactly what is said in this audio. Output ONLY the transcription text, nothing else — no quotes, no preamble.' }
          ]
        }
      ]
    })
    const text = (result.text ?? '').trim()
    if (!text) {
      phase = 'listening'
      emit({ type: 'state', state: 'listening' })
      return
    }
    emit({ type: 'inputTranscript', text, finished: true })
    await runTurn(text)
  } catch (err) {
    log.error('[geminiTurnVoice] utterance handling failed:', err instanceof Error ? err.stack : err)
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    phase = 'listening'
    emit({ type: 'state', state: 'listening' })
  }
}

const SYSTEM_PROMPT = `You are DALVE, a voice-first AI operating system, talking with the user through voice (a turn-based Gemini + ElevenLabs pipeline). Speak naturally and conversationally, concise since this is spoken. Get straight to doing what's asked — never repeat the instruction back before acting. You have standing authorization to click/type/control the screen and browser once asked; no separate permission tool needed. The only hard limit: never type a password, payment card number, or other credential yourself.

Real targeting priority, strongest to weakest: (1) A direct integration tool (Composio/MCP) if one exists. (2) browser_* tools for anything web-based — real DOM lookup, not a coordinate guess. (3) click_element for native desktop apps with a visible label. (4) click_mouse/move_mouse from the screenshot you're given — last resort, for non-textual content only. Only spatial AR objects and continuous unattended screen-watching (the live video feed itself, not a one-off screenshot) aren't available on this engine specifically — if asked for either, say so and suggest switching to the Gemini Live engine in Settings.

Never describe a physical action before actually calling the tool, and never describe an outcome (a message sent, a piece moved) until the result confirms it actually happened. Same for state: if the user says something is off/broken and you say you fixed or restarted it, that's only true if you called the real tool for it in this exact reply — a past tool call is never evidence for a claim you're making now.

A single instruction often spans multiple applications — "read the price in this email, put it into Excel, work out the margin, send the result on WhatsApp" is ONE task. Switching which app you're acting in partway through is not a stopping point — carry whatever value you just read forward into the next app yourself, across as many tool-call rounds as it takes, and keep going until the whole chain is actually done.

IMPORTANT structural limit to understand about yourself: this engine only ever takes a turn when the user just spoke — there is no continuous screen watching here at all, unlike a fully live session. Nothing "wakes you up" on its own when a new WhatsApp message arrives while the user isn't talking to you. That is exactly what start_autonomous_task is for — a separate background loop that actively re-checks the screen every ~20 seconds and can act with nobody present. Whenever what's being asked amounts to "keep doing this without me talking to you" — monitoring a chat (WhatsApp especially) and replying to new messages as they come in is the single most common real case — you MUST call start_autonomous_task, every time. Give it a clear one-sentence goal; it keeps going until the goal is done, the user stops it, or you call stop_autonomous_task.`

/** Builds the ACTUAL system prompt for a session — real per-agent memory + DALVE's own memory
 *  both get read back here (a bug in an earlier version of this engine's predecessor read the
 *  wrong one; fixed and mirrored across every engine now, see geminiLive.ts's equivalent). */
function buildSystemPrompt(agent: AgentConfig | null): string {
  const base = agent ? agent.systemPrompt : SYSTEM_PROMPT
  const memory = agent ? agent.memory : settingsStore.getDalveMemory()
  // Framed as binding, not a passive fact list — a plain "things to remember" bullet was shown
  // live to lose out to a model's own default conversational habits (e.g. a saved note to stop
  // asking a trailing question kept getting ignored). Mirrors the same fix in geminiLive.ts.
  const memoryNote = memory
    ? `\n\nBINDING instructions and facts saved from earlier conversations — these override your own default habits:\n${memory}`
    : ''
  // Tone applies to DALVE herself only, not sub-agents — an agent's own systemPrompt is already
  // an authored persona the user opted into when creating it, matching geminiLive.ts's reasoning.
  const tone = settingsStore.getDalveTone()
  const toneNote = !agent && tone !== 'default' ? `\n\n${DALVE_TONE_PROMPTS[tone]}` : ''
  return base + toneNote + memoryNote
}

// Gemini's free tier is dramatically more generous than Groq's old flat 8,000 tokens/minute, but
// a screenshot is still real, non-zero cost resent on every turn for no reason most turns don't
// need it — same cooldown discipline as before, now a comfort margin rather than a hard survival
// requirement.
const SCREENSHOT_MAX_WIDTH = 1024
const SCREENSHOT_QUALITY = 65
const SCREENSHOT_COOLDOWN_MS = 20_000
let lastScreenshotAttachedAt = 0
const MAX_HISTORY_MESSAGES = 16

/** Keeps only the most recent screenshot in the whole conversation — every earlier one becomes a
 *  short text stand-in instead of being resent (and re-billed) on every subsequent turn. */
function stripOldImages(contents: Content[]): void {
  let sawImage = false
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]
    if (c.role !== 'user' || !c.parts?.some((p) => p.inlineData?.mimeType?.startsWith('image/'))) continue
    if (sawImage) {
      c.parts = [
        ...(c.parts ?? []).filter((p) => !p.inlineData?.mimeType?.startsWith('image/')),
        { text: '[earlier screenshot omitted]' }
      ]
    } else {
      sawImage = true
    }
  }
}

/** Keeps only the most recent exchanges — otherwise token usage grows unbounded turn after turn. */
function trimHistory(): void {
  if (history.length <= MAX_HISTORY_MESSAGES) return
  history = history.slice(-MAX_HISTORY_MESSAGES)
}

function friendlyTurnError(raw: string): string {
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('rate limit') || raw.includes('429')) {
    return "Gemini's rate limit was hit for that reply — wait a few seconds and try again."
  }
  return raw
}

async function runTurn(userText: string): Promise<void> {
  try {
    const client = getClient()
    const now = Date.now()
    const needsScreenshot = now - lastScreenshotAttachedAt > SCREENSHOT_COOLDOWN_MS
    const screenshot = needsScreenshot ? await screenControl.captureScreenshotOnce(SCREENSHOT_QUALITY, SCREENSHOT_MAX_WIDTH) : null
    const parts: Part[] = [{ text: `${userText}\n\n[Current date/time: ${new Date().toString()}]` }]
    if (screenshot) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshot } })
      lastScreenshotAttachedAt = now
    }
    history.push({ role: 'user', parts })
    stripOldImages(history)
    trimHistory()

    const tools = await buildTools()
    emit({ type: 'toolActivity', active: false })

    // A real cross-app task (read a value in one app, switch to another, act on it, switch again)
    // can easily need more tool-call rounds than a single-app action.
    const MAX_ROUNDS = 16
    let exhausted = true
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.models.generateContent({
        model: CHAT_MODEL,
        contents: history,
        config: {
          systemInstruction: { parts: [{ text: systemPromptText }] },
          tools: [{ functionDeclarations: tools }],
          maxOutputTokens: 1024
        }
      })

      const calls = response.functionCalls
      // The model's OWN turn straight from the API, not a reconstruction from the `.functionCalls`
      // convenience getter — the real Content can mix text and function calls in one turn, and
      // this is guaranteed to match exactly what the model actually produced either way.
      const modelTurn: Content = response.candidates?.[0]?.content ?? { role: 'model', parts: calls?.map((c) => ({ functionCall: c })) ?? [{ text: response.text ?? '' }] }
      // Persisted before executing tools so the follow-up functionResponse turn lines up with
      // real prior model output — Gemini's generateContent has no server-held history the way a
      // live session does, so every turn has to be threaded through `history` by hand.
      history.push(modelTurn)

      if (!calls || calls.length === 0) {
        const text = response.text ?? ''
        if (text) await speak(text)
        exhausted = false
        break
      }

      emit({ type: 'toolActivity', active: true, label: calls[0]?.name })
      const responseParts: Part[] = []
      for (const call of calls) {
        const name = call.name ?? ''
        const args = (call.args ?? {}) as Record<string, unknown>
        let result: Record<string, unknown>
        try {
          result = await executeVoiceTool(name, args)
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
        }
        emitActionLog(name, result)
        if (isRecording() && !SKILL_META_TOOLS.has(name) && typeof result.error !== 'string' && result.status !== 'FAILED') {
          recordStep(name, args)
        }
        // Gemini 3 models always return a unique `id` on every functionCall and expect that
        // exact id echoed back on the matching functionResponse — without it, the model can't
        // reliably map a result back to the right call once more than one tool runs in the same
        // turn (confirmed against Gemini's own function-calling docs, not just inferred).
        responseParts.push({ functionResponse: { id: call.id, name, response: result } })
      }
      history.push({ role: 'user', parts: responseParts })
      emit({ type: 'toolActivity', active: false })
    }

    // Same honest "ran out of room" acknowledgment autonomousTask.ts already gives on its own
    // round cap — silence here would look exactly like a "stuck" symptom from a different limit.
    if (exhausted) await speak("I've made progress on that but hit my step limit for one reply — tell me to continue and I'll keep going from here.")
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    log.error('[geminiTurnVoice] turn failed:', err instanceof Error ? err.stack : err)
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
    log.info('[geminiTurnVoice] no ElevenLabs key/voice configured — replying as text only')
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
    log.error('[geminiTurnVoice] ElevenLabs TTS failed:', err instanceof Error ? err.stack : err)
    emit({
      type: 'error',
      message: isTimeout ? 'ElevenLabs took too long to respond — try again.' : err instanceof Error ? err.message : String(err)
    })
  }
}

// --- Tool declarations (Gemini function-calling shape) ---

function tool(name: string, description: string, parameters: Record<string, unknown>): FunctionDeclaration {
  return { name, description, parametersJsonSchema: parameters }
}

const SPEED_ENUM = { type: 'string', enum: ['instant', 'visible'] }
const BUTTON_ENUM = { type: 'string', enum: ['left', 'right', 'middle'] }

// Kept deliberately small and terse — this whole tools array is resent on every single request
// regardless of conversation content, same discipline as the engine this replaced even though
// Gemini's free tier has far more headroom. Niche tools below still live on Gemini Live only.
const STATIC_TOOLS: FunctionDeclaration[] = [
  tool('open_url', "Open a URL in the user's browser.", { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }),
  tool('open_application', 'Opens a native app by name.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('activate_application', 'Brings a running app to the front by name.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('fullscreen_window', 'Toggles fullscreen on the frontmost window.', { type: 'object', properties: {} }),
  tool('create_agent', 'Creates a new companion/bot agent.', {
    type: 'object',
    properties: { name: { type: 'string' }, type: { type: 'string', enum: ['companion', 'bot'] }, description: { type: 'string' } },
    required: ['name']
  }),
  tool('list_agents', 'Lists existing agents.', { type: 'object', properties: {} }),
  tool('remember_fact', 'Saves a fact to permanent memory.', { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] }),
  tool('move_mouse', 'Moves the mouse to a pixel position, no click.', {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, speed: SPEED_ENUM },
    required: ['x', 'y']
  }),
  tool('click_mouse', 'Clicks a pixel position. Last resort vs. browser_click/click_element.', {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['x', 'y']
  }),
  tool('browser_open', "Opens a URL in DALVE's own automation browser (real DOM control).", { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }),
  tool('browser_click', 'Clicks an element in the automation browser by visible text.', { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] }),
  tool('browser_type', 'Clicks a field by label then types into it (automation browser).', {
    type: 'object',
    properties: { fieldDescription: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
    required: ['fieldDescription', 'text']
  }),
  tool('browser_read_text', 'Real visible text of the automation browser page.', { type: 'object', properties: {} }),
  tool('browser_press_key', 'Presses a key in the automation browser.', { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }),
  tool('find_elements', 'Lists accessible UI elements on screen (native apps).', { type: 'object', properties: {} }),
  tool('click_element', 'Clicks a native-app element by accessibility name (OCR fallback).', {
    type: 'object',
    properties: { name: { type: 'string' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['name']
  }),
  tool('read_screen_text', 'Real OCR text of everything on screen.', { type: 'object', properties: {} }),
  tool('click_text', 'Clicks text found via OCR anywhere on screen.', {
    type: 'object',
    properties: { text: { type: 'string' }, button: BUTTON_ENUM, double: { type: 'boolean' }, speed: SPEED_ENUM },
    required: ['text']
  }),
  tool('type_text', 'Types literal text at the current focus.', { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
  tool('press_key', 'Presses one OS key, optionally with modifiers.', {
    type: 'object',
    properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } },
    required: ['key']
  }),
  tool('scroll', 'Scrolls at the current mouse position.', { type: 'object', properties: { deltaX: { type: 'number' }, deltaY: { type: 'number' } } }),
  tool('take_screenshot', 'Saves a real screenshot as a PNG file the user can open later.', { type: 'object', properties: {} }),
  // These were cut on the old Groq-backed version of this engine specifically to fit its harsh
  // flat 8,000-tokens/minute free-tier cap — Gemini's own free tier has no comparable constraint,
  // so there's no reason to keep them off this engine; their handlers already existed either way.
  tool('open_trading_setup', 'Sets up the trading workspace across monitors (TradingView + Discord + Tradovate). Windows only.', { type: 'object', properties: {} }),
  tool('drag_mouse', 'A real press-move-release drag — for a chess piece, a slider, a reorderable item. Two clicks will NOT do a drag.', {
    type: 'object',
    properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, speed: SPEED_ENUM },
    required: ['fromX', 'fromY', 'toX', 'toY']
  }),
  tool('click_price_level', "Clicks an EXACT price on a trading chart via OCR-calibrated price-scale reading, not a guessed coordinate. Use for any specific-price action.", {
    type: 'object',
    properties: { price: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, x: { type: 'number' } },
    required: ['price']
  }),
  tool('start_hand_tracking', "Turns on the webcam, tracks the user's hand as a real cursor (index finger moves it, thumb+index pinch clicks).", { type: 'object', properties: {} }),
  tool('stop_hand_tracking', 'Turns off hand tracking and releases the webcam.', { type: 'object', properties: {} }),
  tool('start_steering_wheel_tracking', 'Turns on the webcam and tracks BOTH hands as a virtual steering wheel for keyboard-controlled games: grip both hands like holding a wheel, turn to steer (A/D), raise/lower to go forward/reverse (W/S), snap hard to one side and hold the turn to drift that direction (Space+A/D). Starting this stops plain cursor tracking, and vice versa.', { type: 'object', properties: {} }),
  tool('stop_steering_wheel_tracking', 'Turns off steering-wheel tracking and releases the webcam.', { type: 'object', properties: {} }),
  tool('define_grid', 'Registers the pixel boundary of a grid/board (chess, sudoku, spreadsheet) with no readable labels, for click_grid_cell to target precisely.', {
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
  tool('click_grid_cell', 'Clicks one exact cell of a previously-defined grid (see define_grid) by row/col, 0-indexed from top-left as currently visible.', {
    type: 'object',
    properties: {
      label: { type: 'string' },
      row: { type: 'number' },
      col: { type: 'number' },
      button: BUTTON_ENUM,
      double: { type: 'boolean' },
      speed: SPEED_ENUM
    },
    required: ['label', 'row', 'col']
  }),
  tool('undo_last_typed_text', "Sends Ctrl+Z to undo the last text DALVE typed with type_text/press_key — only works before a click/send happened since.", { type: 'object', properties: {} }),
  tool('start_recording_skill', 'Starts recording every action DALVE takes from now on, until stop_recording_skill is called.', { type: 'object', properties: {} }),
  tool('stop_recording_skill', 'Stops recording and saves everything done since start_recording_skill as a named skill.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('run_skill', 'Replays a previously recorded skill by name, step by step.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
  tool('list_skills', 'Lists every recorded skill by name.', { type: 'object', properties: {} }),
  tool('create_reminder', 'Schedules a reminder/message. Compute dueAtIso as real ISO 8601 from the given current date/time. type "message" performs `instruction` when due.', {
    type: 'object',
    properties: {
      title: { type: 'string' },
      dueAtIso: { type: 'string' },
      recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] },
      type: { type: 'string', enum: ['reminder', 'message'] },
      instruction: { type: 'string' }
    },
    required: ['title', 'dueAtIso', 'recurrence', 'type']
  }),
  tool('list_reminders', 'Lists every upcoming reminder and scheduled message.', { type: 'object', properties: {} }),
  tool('cancel_reminder', 'Cancels a reminder or scheduled message by its exact title.', { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }),
  tool('list_common_folders', "Returns the user's real Home/Desktop/Documents/Downloads/Pictures paths.", { type: 'object', properties: {} }),
  tool('list_directory', 'Lists files and subfolders in a real directory path.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('read_text_file', 'Reads a plain text/code/markdown/csv/json file. For PDFs or images use read_document instead.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('write_text_file', 'Writes/appends a plain text file.', {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
    required: ['path', 'content']
  }),
  tool('delete_file', 'Moves a file to the Recycle Bin (recoverable, not a permanent delete).', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('move_file', 'Moves or renames a file from one path to another.', { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }),
  tool('search_files', 'Searches for files by partial, case-insensitive filename under a directory, recursively.', { type: 'object', properties: { directory: { type: 'string' }, query: { type: 'string' } }, required: ['directory', 'query'] }),
  tool('read_document', 'Reads a file by path — text/code/csv/json directly, PDFs via text extraction, images as vision content. No .docx yet.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  tool('read_clipboard', "Reads the user's OS clipboard text.", { type: 'object', properties: {} }),
  tool('write_clipboard', "Sets the user's OS clipboard text.", { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
  tool('start_autonomous_task', 'Background loop that keeps acting after this conversation ends.', { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] }),
  tool('stop_autonomous_task', 'Stops the background autonomous task.', { type: 'object', properties: {} })
]

async function buildTools(): Promise<FunctionDeclaration[]> {
  const tools = [...STATIC_TOOLS]

  const composioConnections = settingsStore.getState().composioConnections.filter((c) => c.connected)
  if (composioConnections.length > 0) {
    try {
      const composioTools = await composio.getToolsForApps(composioConnections.map((c) => c.appKey))
      tools.push(...composioTools.map((t) => tool(t.name ?? '', t.description ?? '', (t.parametersJsonSchema as Record<string, unknown>) ?? {})))
    } catch (err) {
      log.error('[geminiTurnVoice] failed to load Composio tools:', err)
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
    case 'start_steering_wheel_tracking': {
      const { status, message } = steeringWheel.start()
      return { status, result: message }
    }
    case 'stop_steering_wheel_tracking': {
      const { status, message } = steeringWheel.stop()
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
          parts: [{ inlineData: { mimeType: doc.mimeType ?? 'image/png', data: doc.imageBase64 } }]
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
