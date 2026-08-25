import {
  GoogleGenAI,
  createUserContent,
  createModelContent,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromBase64,
  type Content,
  type FunctionDeclaration,
  type Part
} from '@google/genai'
import type { BrowserWindow } from 'electron'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import type { AutonomousTaskEvent } from '@shared/types'

// A fast, cheap multimodal model for periodic polling — deliberately NOT the Live model, since
// this runs on a timer independent of any live voice session. gemini-2.5-flash was retired by
// Google (confirmed live via a 404 pointing here) — re-check availability periodically, same
// caveat as LIVE_MODEL in geminiLive.ts: Google rotates these ids.
const POLL_MODEL = 'gemini-3.6-flash'
const CHECK_INTERVAL_MS = 20_000
const MAX_HISTORY = 10
// Safety valve, not a normal ceiling: a real "click field, type, press enter" sequence takes
// 3-4 rounds. This exists so a confused model can't loop forever burning API calls within a
// single check instead of just calling finish_cycle and waiting for the next real observation.
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

// --- Tool declarations ---
// Deliberately mirrors the equivalent tools in geminiLive.ts (same names/shapes, kept in sync by
// hand) so an autonomous task gets the exact same real targeting the live voice session does —
// this used to be a completely separate, much more primitive path (a single hardcoded
// click/type/key decision per 20-second tick, always coordinate-guessed, never re-verified
// against what actually happened) which is what was producing double-typed messages and needing
// a human to nudge it every single step.
const SPEED_SCHEMA = { type: 'string', enum: ['instant', 'visible'] } as const

const CLICK_ELEMENT_TOOL: FunctionDeclaration = {
  name: 'click_element',
  description:
    'Clicks something by its real name/label. Tries OS accessibility data first, then real OCR on the pixels automatically before failing — call this for anything with a visible label. Prefer this over click_mouse.',
  parametersJsonSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, speed: SPEED_SCHEMA },
    required: ['name']
  }
}

const CLICK_TEXT_TOOL: FunctionDeclaration = {
  name: 'click_text',
  description: 'Clicks a piece of text found via real OCR — use when you specifically want rendered pixel text, skipping accessibility lookup.',
  parametersJsonSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, speed: SPEED_SCHEMA },
    required: ['text']
  }
}

const CLICK_MOUSE_TOOL: FunctionDeclaration = {
  name: 'click_mouse',
  description: 'Clicks a raw pixel coordinate. Last resort only — use click_element or click_text first for anything with a visible label.',
  parametersJsonSchema: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, speed: SPEED_SCHEMA },
    required: ['x', 'y']
  }
}

const TYPE_TEXT_TOOL: FunctionDeclaration = {
  name: 'type_text',
  description: 'Types literal text at the current cursor/focus position. Click the right field first so it actually has focus.',
  parametersJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

const PRESS_KEY_TOOL: FunctionDeclaration = {
  name: 'press_key',
  description: 'Presses a single key, e.g. "enter" to send a typed message.',
  parametersJsonSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
}

const DEFINE_GRID_TOOL: FunctionDeclaration = {
  name: 'define_grid',
  description: "Registers a grid/board's pixel boundary (chess board, spreadsheet, etc.) once, so click_grid_cell can click exact cells afterward instead of guessing each one.",
  parametersJsonSchema: {
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
  }
}

const CLICK_GRID_CELL_TOOL: FunctionDeclaration = {
  name: 'click_grid_cell',
  description: 'Clicks one exact cell of a previously-defined grid by row/col (0-indexed from top-left as currently visible).',
  parametersJsonSchema: {
    type: 'object',
    properties: { label: { type: 'string' }, row: { type: 'number' }, col: { type: 'number' } },
    required: ['label', 'row', 'col']
  }
}

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

const AUTONOMOUS_TOOLS: FunctionDeclaration[] = [
  CLICK_ELEMENT_TOOL,
  CLICK_TEXT_TOOL,
  CLICK_MOUSE_TOOL,
  TYPE_TEXT_TOOL,
  PRESS_KEY_TOOL,
  DEFINE_GRID_TOOL,
  CLICK_GRID_CELL_TOOL,
  FINISH_CYCLE_TOOL,
  MARK_TASK_COMPLETE_TOOL
]

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
  gridTargeting.clearGrids()
  screenControl.setControlGranted(true)
  emit({ type: 'started', goal })

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

async function executeAutonomousTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'click_element') {
    const targetName = String(args.name ?? '').trim()
    const speed = (args.speed as 'instant' | 'visible') ?? 'visible'
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left'
    const uiResult = uiAutomation.isSupported() ? await uiAutomation.locateElement(targetName) : null
    if (uiResult?.found && uiResult.centerX !== undefined && uiResult.centerY !== undefined) {
      await screenControl.clickMouse(uiResult.centerX, uiResult.centerY, button, false, speed)
      return { status: 'SUCCESS', result: `Clicked "${uiResult.element?.name}" via accessibility data.` }
    }
    const ocrResult = await ocr.locateText(targetName)
    if (ocrResult.found && ocrResult.centerX !== undefined && ocrResult.centerY !== undefined) {
      await screenControl.clickMouse(ocrResult.centerX, ocrResult.centerY, button, false, speed)
      return { status: 'SUCCESS', result: `Clicked "${ocrResult.line?.text}" via OCR.` }
    }
    return { status: 'FAILED', error: `"${targetName}" wasn't found via accessibility data or OCR.` }
  }
  if (name === 'click_text') {
    const targetText = String(args.text ?? '').trim()
    const located = await ocr.locateText(targetText)
    if (!located.found || located.centerX === undefined || located.centerY === undefined) {
      return { status: 'FAILED', error: `OCR didn't find "${targetText}".` }
    }
    await screenControl.clickMouse(
      located.centerX,
      located.centerY,
      (args.button as 'left' | 'right' | 'middle') ?? 'left',
      false,
      (args.speed as 'instant' | 'visible') ?? 'visible'
    )
    return { status: 'SUCCESS', result: `Clicked text "${located.line?.text}".` }
  }
  if (name === 'click_mouse') {
    await screenControl.clickMouse(Number(args.x), Number(args.y), 'left', false, (args.speed as 'instant' | 'visible') ?? 'visible')
    return { status: 'SUCCESS', result: 'Clicked.' }
  }
  if (name === 'type_text') {
    screenControl.typeText(String(args.text ?? ''))
    return { status: 'SUCCESS', result: 'Typed.' }
  }
  if (name === 'press_key') {
    screenControl.pressKey(String(args.key ?? ''))
    return { status: 'SUCCESS', result: 'Pressed.' }
  }
  if (name === 'define_grid') {
    const label = String(args.label ?? '').trim()
    gridTargeting.defineGrid(label, {
      x: Number(args.x),
      y: Number(args.y),
      width: Number(args.width),
      height: Number(args.height),
      rows: Math.max(1, Math.round(Number(args.rows))),
      cols: Math.max(1, Math.round(Number(args.cols)))
    })
    return { result: `Registered grid "${label}".` }
  }
  if (name === 'click_grid_cell') {
    const label = String(args.label ?? '').trim()
    const cell = gridTargeting.cellCenter(label, Math.round(Number(args.row)), Math.round(Number(args.col)))
    if (!cell.found || cell.centerX === undefined || cell.centerY === undefined) {
      return { status: 'FAILED', error: cell.error ?? 'Cell not found.' }
    }
    await screenControl.clickMouse(cell.centerX, cell.centerY, 'left', false, 'visible')
    return { status: 'SUCCESS', result: `Clicked row ${args.row}, col ${args.col}.` }
  }
  return { error: `Unknown tool "${name}".` }
}

/**
 * One scheduled check (every ~20s) — but internally runs a bounded multi-step tool-calling loop
 * so a whole sequence (click a field, type a reply, press enter) completes in ONE check instead
 * of being spread across several 20-second-apart cycles with no memory of what already
 * happened in between. Each round re-captures the screen before deciding the next step, so the
 * model can actually see "I already typed this, I just need to send it" instead of re-guessing
 * blind — that blindness between steps was the direct cause of the double-typed-message bug.
 */
async function tick(goal: string): Promise<void> {
  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) {
    stopAutonomousTask('no Gemini API key configured')
    return
  }
  const ai = new GoogleGenAI({ apiKey })

  const systemText = `You are DALVE, running a background task the user explicitly asked you to handle without them present: "${goal}". You have standing permission to act (click/type/press keys) on this specific task without asking for confirmation each time — but be conservative: never enter passwords/payment details/other credentials.

You can take SEVERAL actions in a row right now before this check ends — finish a whole sequence (e.g. click the message field, type your reply, press enter to send) rather than doing one micro-step and stopping. After every action you take, you'll see a fresh screenshot before your next decision — actually look at it to confirm the action did what you expected (the text really appears in the field, the message really sent) before moving on or claiming it worked. Call finish_cycle once there's genuinely nothing further to do until the next automatic check (e.g. you sent something and are waiting on a reply) — never call it mid-sequence. Call mark_task_complete only once the ENTIRE goal is fully done, not just this check.

Recent history of this task:\n${history.length > 0 ? history.join('\n') : '(nothing yet)'}`

  const firstShot = await screenControl.captureScreenshotOnce(80)
  if (!firstShot) return

  const contents: Content[] = [createUserContent([{ text: systemText }, createPartFromBase64(firstShot, 'image/jpeg')])]

  for (let round = 0; round < MAX_ROUNDS_PER_TICK; round++) {
    const response = await ai.models.generateContent({
      model: POLL_MODEL,
      contents,
      config: { tools: [{ functionDeclarations: AUTONOMOUS_TOOLS }] }
    })

    const calls = response.functionCalls
    if (!calls || calls.length === 0) {
      // No tool call at all — treat any text as a narration and end this check rather than
      // looping on nothing.
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

      let result: Record<string, unknown>
      try {
        result = await executeAutonomousTool(callName, callArgs)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
      }
      pushHistory(`${callName}(${JSON.stringify(callArgs)}) -> ${JSON.stringify(result)}`)
      responseParts.push(createPartFromFunctionResponse(call.id ?? callName, callName, result))
    }

    if (shouldEndTask) {
      stopAutonomousTask('task completed')
      return
    }
    if (shouldEndCycle) return

    // Fresh screenshot before the next round so the model verifies what just actually happened,
    // rather than deciding its next move blind.
    const nextShot = await screenControl.captureScreenshotOnce(80)
    contents.push(createUserContent(nextShot ? [...responseParts, createPartFromBase64(nextShot, 'image/jpeg')] : responseParts))
  }

  pushHistory('Hit the per-check action limit — pausing until the next automatic check.')
}
