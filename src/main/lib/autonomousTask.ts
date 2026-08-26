import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolResultBlockParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
import type { AutonomousTaskEvent } from '@shared/types'

// Claude, not Gemini — a real reasoning-engine swap (not just a bigger model within the same
// family), after Gemini's flash tier repeatedly showed the same "common sense"/stalling failures
// across three prior architectures using this exact tool set. Anthropic occasionally revises
// model ids; re-check availability if this starts 404ing.
const POLL_MODEL = 'claude-sonnet-5'
const MAX_OUTPUT_TOKENS = 4096
const CHECK_INTERVAL_MS = 20_000
const MAX_HISTORY = 10
// Safety valve, not a normal ceiling: a real "search, open chat, type, send" sequence takes only
// a handful of rounds. Exists so a confused model can't loop forever burning API calls within a
// single check instead of just calling finish_cycle and waiting for the next real observation.
const MAX_ROUNDS_PER_TICK = 10

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

// --- Tool declarations, in explicit priority order ---
// Real targeting priority, strongest to weakest — matches the same hierarchy given to the live
// voice session in geminiLive.ts. The model is instructed (below, in the per-tick prompt) to try
// them in this order rather than defaulting to the weakest one.
const SPEED_SCHEMA = { type: 'string', enum: ['instant', 'visible'] } as const

// Tier 2: real browser DOM control. Structurally cannot mis-click the browser's own toolbar/
// tabs/profile button — those aren't part of the page a Playwright Page can see at all, which is
// the exact, root-caused mechanism behind a real reported mistake (clicking Chrome's own account
// button because it happened to share a name with the intended WhatsApp chat).
const BROWSER_OPEN_TOOL: Tool = {
  name: 'browser_open',
  description:
    "Opens a URL in DALVE's dedicated automation browser (separate window, persists logins across runs — WhatsApp Web etc. only need login once). STRONGLY PREFER this over any screen/coordinate tool for anything that's a website.",
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
}
const BROWSER_CLICK_TOOL: Tool = {
  name: 'browser_click',
  description: 'Clicks a real element by its actual visible text/label — genuine DOM lookup, not a coordinate guess. Reports back explicitly if multiple things match rather than picking one blind.',
  input_schema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] }
}
const BROWSER_TYPE_TOOL: Tool = {
  name: 'browser_type',
  description: 'Clicks a field by its label/placeholder then types into it, so it actually has focus first.',
  input_schema: {
    type: 'object',
    properties: { fieldDescription: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
    required: ['fieldDescription', 'text']
  }
}
const BROWSER_READ_TEXT_TOOL: Tool = {
  name: 'browser_read_text',
  description: 'Real visible text of the current page (actual DOM, not OCR) — use to verify what really happened before deciding the next step.',
  input_schema: { type: 'object', properties: {} }
}
const BROWSER_EVALUATE_TOOL: Tool = {
  name: 'browser_evaluate',
  description:
    "Runs read-only JavaScript in the current page and returns the result — for content with no accessible text/role at all but a real inspectable DOM (e.g. a chess board's pieces, which carry their position in element class names even though nothing is readable via normal text). Escape hatch: prefer browser_click/browser_type for anything with real text. Example: document.querySelectorAll('[class*=\"square\"]') style queries to read exact positions instead of guessing them visually.",
  input_schema: { type: 'object', properties: { script: { type: 'string', description: 'A JS expression to evaluate, e.g. "document.title" or a querySelectorAll + map returning plain data.' } }, required: ['script'] }
}

// Tier 3: native desktop accessibility (already built + live-tested earlier).
const CLICK_ELEMENT_TOOL: Tool = {
  name: 'click_element',
  description: 'For native desktop apps (not websites): clicks something by its real OS accessibility name, trying real OCR automatically if that finds nothing.',
  input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
}

// Tier 4: last resort — coordinate guessing / grid math for genuinely non-textual content.
const CLICK_MOUSE_TOOL: Tool = {
  name: 'click_mouse',
  description: 'Clicks a raw pixel coordinate. Last resort only.',
  input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, speed: SPEED_SCHEMA }, required: ['x', 'y'] }
}
const DRAG_MOUSE_TOOL: Tool = {
  name: 'drag_mouse',
  description: 'A real press-move-release drag — for anything that needs an actual drag gesture, not two clicks (a chess piece on a canvas-rendered/non-web board, a slider).',
  input_schema: {
    type: 'object',
    properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, speed: SPEED_SCHEMA },
    required: ['fromX', 'fromY', 'toX', 'toY']
  }
}
const TYPE_TEXT_TOOL: Tool = {
  name: 'type_text',
  description: 'Types literal text at the current OS-level focus. Only for non-browser content — use browser_type for websites.',
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}
const PRESS_KEY_TOOL: Tool = {
  name: 'press_key',
  description: 'Presses a single OS-level key.',
  input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
}
const DEFINE_GRID_TOOL: Tool = {
  name: 'define_grid',
  description: "Registers a non-web grid/board's pixel boundary once so click_grid_cell can click exact cells afterward instead of guessing each one.",
  input_schema: {
    type: 'object',
    properties: { label: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, rows: { type: 'number' }, cols: { type: 'number' } },
    required: ['label', 'x', 'y', 'width', 'height', 'rows', 'cols']
  }
}
const CLICK_GRID_CELL_TOOL: Tool = {
  name: 'click_grid_cell',
  description: 'Clicks one exact cell of a previously-defined non-web grid by row/col (0-indexed from top-left as currently visible).',
  input_schema: { type: 'object', properties: { label: { type: 'string' }, row: { type: 'number' }, col: { type: 'number' } }, required: ['label', 'row', 'col'] }
}

// Control flow — the only two signals with no natural physical-action equivalent.
const FINISH_CYCLE_TOOL: Tool = {
  name: 'finish_cycle',
  description:
    'Call when there is nothing further to do RIGHT NOW (e.g. just sent a message, waiting on a reply). Ends this check only; the next automatic check runs in ~20s. Never call mid-sequence.',
  input_schema: { type: 'object', properties: { narration: { type: 'string' } }, required: ['narration'] }
}
const MARK_TASK_COMPLETE_TOOL: Tool = {
  name: 'mark_task_complete',
  description: 'Call once the ENTIRE goal is fully accomplished — stops the background task completely.',
  input_schema: { type: 'object', properties: { narration: { type: 'string' } }, required: ['narration'] }
}

const ALL_TOOLS: Tool[] = [
  BROWSER_OPEN_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_READ_TEXT_TOOL,
  BROWSER_EVALUATE_TOOL,
  CLICK_ELEMENT_TOOL,
  CLICK_MOUSE_TOOL,
  DRAG_MOUSE_TOOL,
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
  log.info(`[autonomousTask] started, goal="${goal}", log file: ${log.transports.file.getFile().path}`)

  const runCycle = async (): Promise<void> => {
    try {
      await tick(goal)
    } catch (err) {
      console.error('[autonomousTask] cycle failed:', err)
      log.error('[autonomousTask] cycle failed:', err instanceof Error ? err.stack : err)
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

async function executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
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
    case 'browser_evaluate': {
      const result = await browserControl.evaluateInPage(String(args.script ?? ''))
      return { result: JSON.stringify(result).slice(0, 4000) }
    }
    case 'click_element': {
      const targetName = String(args.name ?? '').trim()
      const uiResult = uiAutomation.isSupported() ? await uiAutomation.locateElement(targetName) : null
      if (uiResult?.found && uiResult.centerX !== undefined && uiResult.centerY !== undefined) {
        await screenControl.clickMouse(uiResult.centerX, uiResult.centerY, 'left', false, 'visible')
        return { status: 'SUCCESS', result: `Clicked "${uiResult.element?.name}" via accessibility data.` }
      }
      const ocrResult = await ocr.locateText(targetName)
      if (ocrResult.found && ocrResult.centerX !== undefined && ocrResult.centerY !== undefined) {
        await screenControl.clickMouse(ocrResult.centerX, ocrResult.centerY, 'left', false, 'visible')
        return { status: 'SUCCESS', result: `Clicked "${ocrResult.line?.text}" via OCR.` }
      }
      return { status: 'FAILED', error: `"${targetName}" wasn't found via accessibility data or OCR.` }
    }
    case 'click_mouse':
      await screenControl.clickMouse(Number(args.x), Number(args.y), 'left', false, (args.speed as 'instant' | 'visible') ?? 'visible')
      return { result: 'clicked' }
    case 'drag_mouse':
      await screenControl.dragMouse(Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY), (args.speed as 'instant' | 'visible') ?? 'visible')
      return { result: 'dragged' }
    case 'type_text':
      screenControl.typeText(String(args.text ?? ''))
      return { result: 'typed' }
    case 'press_key':
      screenControl.pressKey(String(args.key ?? ''))
      return { result: 'pressed' }
    case 'define_grid':
      gridTargeting.defineGrid(String(args.label ?? '').trim(), {
        x: Number(args.x),
        y: Number(args.y),
        width: Number(args.width),
        height: Number(args.height),
        rows: Math.max(1, Math.round(Number(args.rows))),
        cols: Math.max(1, Math.round(Number(args.cols)))
      })
      return { result: 'grid registered' }
    case 'click_grid_cell': {
      const cell = gridTargeting.cellCenter(String(args.label ?? '').trim(), Math.round(Number(args.row)), Math.round(Number(args.col)))
      if (!cell.found || cell.centerX === undefined || cell.centerY === undefined) {
        return { status: 'FAILED', error: cell.error ?? 'Cell not found.' }
      }
      await screenControl.clickMouse(cell.centerX, cell.centerY, 'left', false, 'visible')
      return { status: 'SUCCESS', result: `Clicked row ${args.row}, col ${args.col}.` }
    }
    default:
      return { error: `Unrecognized action "${name}".` }
  }
}

/**
 * One scheduled check (every ~20s) — but internally runs a bounded multi-step tool-calling loop
 * so a whole sequence (open the site, search, click a chat, type a reply, send) completes in ONE
 * check instead of being spread across several 20-second-apart cycles with no memory of what
 * already happened. Each round re-captures the screen (for whatever isn't already covered by a
 * browser_read_text call) before the next decision, so the model can verify what actually
 * happened instead of assuming.
 */
async function tick(goal: string): Promise<void> {
  const apiKey = settingsStore.getAnthropicApiKey()
  if (!apiKey) {
    stopAutonomousTask('no Claude API key configured')
    return
  }
  const anthropic = new Anthropic({ apiKey })

  const systemText = `You are DALVE, running a background task the user explicitly asked you to handle without them present: "${goal}". You have standing permission to act without asking for confirmation each time — but be conservative: never enter passwords/payment details/other credentials.

Real targeting priority, strongest to weakest — always use the strongest one that applies:
1. browser_open + browser_click/browser_type/browser_read_text/browser_evaluate for ANYTHING that's a website (WhatsApp Web included). This is real DOM lookup by actual text, not a coordinate guess, running in DALVE's own dedicated automation browser (separate from the screenshot below) — it cannot mis-click a browser's own toolbar/tabs/account button, since that browser has no visible chrome for it to ever address. If a site needs login (e.g. WhatsApp Web's QR code) the user needs to do that once in that window — say so plainly if you hit a login wall you can't get past yourself.
2. click_element for native desktop apps (not websites) with a visible label.
3. click_mouse/drag_mouse/define_grid+click_grid_cell from the screenshot below — last resort, for genuinely non-web, non-textual content only (a game, a drawing canvas).

You can take SEVERAL actions in a row right now before this check ends — finish a whole sequence rather than doing one micro-step and stopping. Actually check the result of each action (browser_read_text, or the next screenshot) before claiming something worked. Call finish_cycle once there's genuinely nothing further to do until the next check — never mid-sequence. Call mark_task_complete only once the ENTIRE goal is done.

Recent history of this task:\n${history.length > 0 ? history.join('\n') : '(nothing yet)'}`

  // Ground truth for "did anything change" must not depend on the model remembering to ask for
  // it — a flash-tier model reliably forgot to call browser_read_text on its own, so it kept
  // seeing a visually-unchanged screenshot and calling finish_cycle forever (the real cause of
  // "waits for the user to say answer"). Fetching it unconditionally here removes that failure
  // mode structurally instead of hoping the model's judgement improves.
  const browserText = (await browserControl.isOpen()) ? await browserControl.getVisibleText().catch(() => null) : null
  const browserNote = browserText
    ? `\n\nCurrent real text of the open browser page (ground truth — check this for anything you might be waiting on, like a reply, before assuming nothing changed):\n${browserText}`
    : ''

  const firstShot = await screenControl.captureScreenshotOnce(80)
  if (!firstShot) return

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: systemText + browserNote },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: firstShot } }
      ]
    }
  ]

  for (let round = 0; round < MAX_ROUNDS_PER_TICK; round++) {
    log.info(`[autonomousTask] round ${round}: calling ${POLL_MODEL}`)
    let response
    try {
      response = await anthropic.messages.create({
        model: POLL_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: ALL_TOOLS,
        messages
      })
    } catch (err) {
      log.error('[autonomousTask] messages.create threw:', err instanceof Error ? err.stack : err)
      throw err
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use')
    const textBlocks = response.content.filter((b) => b.type === 'text')
    log.info(
      `[autonomousTask] round ${round} response: toolUses=${toolUses.length}` +
        (toolUses.length ? ` names=[${toolUses.map((c) => c.name).join(', ')}]` : '') +
        (textBlocks.length ? ` text="${textBlocks.map((t) => t.text).join(' ').slice(0, 300)}"` : '')
    )

    if (toolUses.length === 0) {
      const text = textBlocks.map((t) => t.text).join(' ').trim()
      if (text) pushHistory(text)
      return
    }

    messages.push({ role: 'assistant', content: response.content })

    let shouldEndCycle = false
    let shouldEndTask = false
    const toolResults: ToolResultBlockParam[] = []
    for (const call of toolUses) {
      const callArgs = (call.input ?? {}) as Record<string, unknown>

      if (call.name === 'finish_cycle' || call.name === 'mark_task_complete') {
        pushHistory(String(callArgs.narration ?? call.name))
        if (call.name === 'mark_task_complete') shouldEndTask = true
        shouldEndCycle = true
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'acknowledged' })
        continue
      }

      log.info(`[autonomousTask] executing ${call.name} args=${JSON.stringify(callArgs)}`)
      let result: Record<string, unknown>
      try {
        result = await executeTool(call.name, callArgs)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
        log.error(`[autonomousTask] ${call.name} threw:`, err)
      }
      log.info(`[autonomousTask] ${call.name} result=${JSON.stringify(result).slice(0, 500)}`)
      pushHistory(`${call.name}(${JSON.stringify(callArgs).slice(0, 200)}) -> ${JSON.stringify(result).slice(0, 300)}`)
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
    }

    if (shouldEndTask) {
      stopAutonomousTask('task completed')
      return
    }
    if (shouldEndCycle) return

    const nextShot = await screenControl.captureScreenshotOnce(80)
    const nextContent: ContentBlockParam[] = [...toolResults]
    if (nextShot) nextContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: nextShot } })
    messages.push({ role: 'user', content: nextContent })
  }

  pushHistory('Hit the per-check action limit — pausing until the next automatic check.')
}
