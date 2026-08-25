import {
  GoogleGenAI,
  Environment,
  createUserContent,
  createModelContent,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromBase64,
  type Content,
  type FunctionDeclaration,
  type Part
} from '@google/genai'
import { shell, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import type { AutonomousTaskEvent } from '@shared/types'

// A fast, cheap multimodal model for periodic polling — deliberately NOT the Live model, since
// this runs on a timer independent of any live voice session. gemini-2.5-flash was retired by
// Google (confirmed live via a 404 pointing here) — re-check availability periodically, same
// caveat as LIVE_MODEL in geminiLive.ts: Google rotates these ids.
//
// Uses Gemini's `computer_use` built-in tool rather than a hand-defined click/type/key schema —
// this is a real, purpose-trained action mode Google ships specifically for GUI screenshot
// interaction (not a bigger general model), and it includes a genuine drag-and-drop gesture that
// nothing in this codebase had before. Confirmed live and repeatedly that hand-guessed coordinates
// from a general-purpose model were producing wrong-square/wrong-chat clicks no amount of tool
// engineering on top could fix; this swaps the underlying decision-maker for one built for exactly
// this job instead of continuing to patch the guessing itself.
const POLL_MODEL = 'gemini-3.7-flash'
const CHECK_INTERVAL_MS = 20_000
const MAX_HISTORY = 10
// Safety valve, not a normal ceiling: a real "click field, type, press enter" sequence takes
// only a few rounds. This exists so a confused model can't loop forever burning API calls within
// a single check instead of just calling finish_cycle and waiting for the next real observation.
const MAX_ROUNDS_PER_TICK = 8

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: AutonomousTaskEvent): void {
  win?.webContents.send('autonomousTask:event', event)
}

let timer: ReturnType<typeof setInterval> | null = null
let currentGoal: string | null = null
let history: string[] = []

export function isActive(): boolean {
  return timer !== null
}

export function getGoal(): string | null {
  return currentGoal
}

// The only two signals computer_use's own predefined action set has no equivalent for — it
// covers physical actions, not "are we done for now" / "is the whole goal complete."
const FINISH_CYCLE_TOOL: FunctionDeclaration = {
  name: 'finish_cycle',
  description:
    'Call this when there is nothing further to do RIGHT NOW — e.g. you just sent a message and are waiting on a reply, or the screen genuinely has not changed since your last check. Ends this check only; the next automatic check runs in about 20 seconds. Do NOT call this mid-sequence (e.g. right after typing but before sending) — finish the whole sequence first.',
  parametersJsonSchema: { type: 'object', properties: { narration: { type: 'string' } }, required: ['narration'] }
}

const MARK_TASK_COMPLETE_TOOL: FunctionDeclaration = {
  name: 'mark_task_complete',
  description: 'Call this once the ENTIRE goal has been fully accomplished — stops the background task completely, not just this check.',
  parametersJsonSchema: { type: 'object', properties: { narration: { type: 'string' } }, required: ['narration'] }
}

/**
 * Starts a background loop that watches the screen and acts on its own timer, independent of
 * any live voice session — the user explicitly opted into this running without per-action
 * confirmation for THIS goal specifically (see request_permission's normal per-live-session
 * gate, which this deliberately bypasses via screenControl.setControlGranted).
 */
export function startAutonomousTask(goal: string): void {
  if (timer) stopAutonomousTask('replaced by a new task')
  currentGoal = goal
  history = []
  screenControl.setControlGranted(true)
  emit({ type: 'started', goal })
  log.info(`[autonomousTask] started, goal="${goal}", log file: ${log.transports.file.getFile().path}`)

  const runCycle = async (): Promise<void> => {
    try {
      await tick(goal)
    } catch (err) {
      console.error('[autonomousTask] cycle failed:', err)
      emit({
        type: 'log',
        text: `Hit an error and will retry next cycle: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  void runCycle()
  timer = setInterval(() => void runCycle(), CHECK_INTERVAL_MS)
}

export function stopAutonomousTask(reason = 'stopped by user'): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (currentGoal) emit({ type: 'stopped', reason })
  currentGoal = null
  screenControl.setControlGranted(false)
}

function pushHistory(narration: string): void {
  if (!narration) return
  history.push(narration)
  if (history.length > MAX_HISTORY) history.shift()
  emit({ type: 'log', text: narration })
}

/** computer_use reports coordinates normalized to a 0-999 space regardless of actual screen
 *  resolution — this is what converts them into the same real pixel space every other tool in
 *  this app already uses. */
function denormalize(n: number, dimension: number): number {
  return Math.round((n / 999) * dimension)
}

async function executeComputerUseAction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { width, height } = screenControl.getFrameSize()
  const px = (v: unknown): number => denormalize(Number(v), width)
  const py = (v: unknown): number => denormalize(Number(v), height)

  switch (name) {
    case 'click':
      await screenControl.clickMouse(px(args.x), py(args.y), 'left', false, 'visible')
      return { result: 'clicked' }
    case 'double_click':
      await screenControl.clickMouse(px(args.x), py(args.y), 'left', true, 'visible')
      return { result: 'double-clicked' }
    case 'triple_click':
      // No native triple-click — three quick clicks at the same point is the standard fallback
      // (used for e.g. "select whole line" in text fields).
      for (let i = 0; i < 3; i++) await screenControl.clickMouse(px(args.x), py(args.y), 'left', false, 'instant')
      return { result: 'triple-clicked' }
    case 'middle_click':
      await screenControl.clickMouse(px(args.x), py(args.y), 'middle', false, 'visible')
      return { result: 'middle-clicked' }
    case 'right_click':
      await screenControl.clickMouse(px(args.x), py(args.y), 'right', false, 'visible')
      return { result: 'right-clicked' }
    case 'move':
      await screenControl.moveMouse(px(args.x), py(args.y), 'visible')
      return { result: 'moved' }
    case 'type':
      screenControl.typeText(String(args.text ?? ''))
      if (args.press_enter) screenControl.pressKey('enter')
      return { result: 'typed' }
    case 'drag_and_drop':
      await screenControl.dragMouse(px(args.start_x), py(args.start_y), px(args.end_x), py(args.end_y), 'visible')
      return { result: 'dragged' }
    case 'wait': {
      const seconds = Math.min(5, Math.max(0, Number(args.seconds) || 1))
      await new Promise((r) => setTimeout(r, seconds * 1000))
      return { result: `waited ${seconds}s` }
    }
    case 'press_key':
      screenControl.pressKey(String(args.key ?? ''))
      return { result: 'pressed' }
    case 'hotkey': {
      const keys = Array.isArray(args.keys) ? (args.keys as string[]) : []
      if (keys.length === 0) return { error: 'no keys given' }
      screenControl.pressKey(keys[keys.length - 1], keys.slice(0, -1))
      return { result: 'pressed hotkey' }
    }
    case 'take_screenshot':
      // A fresh screenshot is already captured every round automatically — nothing extra to do.
      return { result: 'ok' }
    case 'scroll': {
      const direction = String(args.direction ?? 'down')
      const magnitude = Number(args.magnitude_in_pixels) || 200
      const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
      const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
      screenControl.scroll(deltaX, deltaY)
      return { result: 'scrolled' }
    }
    case 'navigate':
      await shell.openExternal(String(args.url ?? ''))
      return { result: 'navigated' }
    case 'go_back':
    case 'go_forward':
      return { error: `"${name}" isn't available outside a dedicated browser-automation environment — use press_key with "alt" navigation keys, or click a visible back/forward button instead.` }
    default:
      return { error: `Unrecognized action "${name}".` }
  }
}

/**
 * One scheduled check (every ~20s) — but internally runs a bounded multi-step action loop so a
 * whole sequence (click a field, type a reply, press enter) completes in ONE check instead of
 * being spread across several 20-second-apart cycles with no memory of what already happened in
 * between. Each round re-captures the screen before deciding the next step, so the model can
 * actually see "I already typed this, I just need to send it" instead of re-guessing blind.
 */
async function tick(goal: string): Promise<void> {
  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) {
    stopAutonomousTask('no Gemini API key configured')
    return
  }
  const ai = new GoogleGenAI({ apiKey })

  const systemText = `You are DALVE, running a background task the user explicitly asked you to handle without them present: "${goal}". You have standing permission to act (click/type/press keys) on this specific task without asking for confirmation each time — but be conservative: never enter passwords/payment details/other credentials.

You can take SEVERAL actions in a row right now before this check ends — finish a whole sequence (e.g. click the message field, type your reply, press enter to send) rather than doing one micro-step and stopping. After every action you take, you'll see a fresh screenshot before your next decision — actually look at it to confirm the action did what you expected (the text really appears in the field, the message really sent, the piece really moved) before moving on or claiming it worked. Call finish_cycle once there's genuinely nothing further to do until the next automatic check (e.g. you sent something and are waiting on a reply) — never call it mid-sequence. Call mark_task_complete only once the ENTIRE goal is fully done, not just this check.

For anything drag-based (a chess/checkers piece, a slider, a reorderable list item) use the drag_and_drop action — a real press-move-release gesture — rather than two separate clicks, which does nothing on sites that only respond to an actual drag.

Recent history of this task:\n${history.length > 0 ? history.join('\n') : '(nothing yet)'}`

  const firstShot = await screenControl.captureScreenshotOnce(80)
  if (!firstShot) return

  const contents: Content[] = [createUserContent([{ text: systemText }, createPartFromBase64(firstShot, 'image/jpeg')])]

  for (let round = 0; round < MAX_ROUNDS_PER_TICK; round++) {
    log.info(`[autonomousTask] round ${round}: calling ${POLL_MODEL} with computer_use tool`)
    let response
    try {
      response = await ai.models.generateContent({
        model: POLL_MODEL,
        contents,
        config: {
          tools: [
            { computerUse: { environment: Environment.ENVIRONMENT_DESKTOP } },
            { functionDeclarations: [FINISH_CYCLE_TOOL, MARK_TASK_COMPLETE_TOOL] }
          ]
        }
      })
    } catch (err) {
      // Deliberately dumping every own property, not just .message — SDK/API errors often carry
      // the actual rejection reason (e.g. "these tools cannot be combined") in a nested field
      // that .message alone won't show, and guessing at the cause instead of reading it is
      // exactly the trap this logging exists to avoid.
      log.error('[autonomousTask] generateContent threw:', err instanceof Error ? err.stack : err)
      try {
        log.error('[autonomousTask] full error object:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
      } catch {
        // some error shapes don't survive JSON.stringify — the .stack log above already covers it
      }
      throw err
    }

    const calls = response.functionCalls
    log.info(
      `[autonomousTask] round ${round} response: functionCalls=${calls ? calls.length : 0}` +
        (calls?.length ? ` names=[${calls.map((c) => c.name).join(', ')}]` : '') +
        (response.text ? ` text="${response.text.slice(0, 300)}"` : '') +
        (response.candidates?.[0]?.finishReason ? ` finishReason=${response.candidates[0].finishReason}` : '')
    )

    if (!calls || calls.length === 0) {
      if (response.text) pushHistory(response.text.trim())
      return
    }

    contents.push(createModelContent(calls.map((c) => createPartFromFunctionCall(c.name ?? '', c.args ?? {}))))

    let shouldEndCycle = false
    let shouldEndTask = false
    const responseParts: Part[] = []
    for (const call of calls) {
      const callName = call.name ?? ''
      const callArgs = (call.args ?? {}) as Record<string, unknown>

      if (callName === 'finish_cycle' || callName === 'mark_task_complete') {
        pushHistory(String(callArgs.narration ?? callName))
        if (callName === 'mark_task_complete') shouldEndTask = true
        shouldEndCycle = true
        responseParts.push(createPartFromFunctionResponse(call.id ?? callName, callName, { result: 'acknowledged' }))
        continue
      }

      log.info(`[autonomousTask] executing ${callName} args=${JSON.stringify(callArgs)}`)
      let result: Record<string, unknown>
      try {
        result = await executeComputerUseAction(callName, callArgs)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
        log.error(`[autonomousTask] ${callName} threw:`, err)
      }
      log.info(`[autonomousTask] ${callName} result=${JSON.stringify(result)}`)
      const intent = typeof callArgs.intent === 'string' ? callArgs.intent : ''
      pushHistory(`${callName}${intent ? ` (${intent})` : ''} -> ${JSON.stringify(result)}`)
      responseParts.push(createPartFromFunctionResponse(call.id ?? callName, callName, result))
    }

    if (shouldEndTask) {
      stopAutonomousTask('task completed')
      return
    }
    if (shouldEndCycle) return

    const nextShot = await screenControl.captureScreenshotOnce(80)
    contents.push(createUserContent(nextShot ? [...responseParts, createPartFromBase64(nextShot, 'image/jpeg')] : responseParts))
  }

  pushHistory('Hit the per-check action limit — pausing until the next automatic check.')
}
