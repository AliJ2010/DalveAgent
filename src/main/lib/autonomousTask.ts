import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolResultBlockParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
import { SHARED_TOOLS, VERIFIABLE_ACTIONS, executeTool } from './agentTools'
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

let timer: ReturnType<typeof setTimeout> | null = null
let currentGoal: string | null = null
let history: string[] = []

export function isActive(): boolean {
  return currentGoal !== null
}

export function getGoal(): string | null {
  return currentGoal
}

// Control flow — the only two signals with no natural physical-action equivalent. The physical/
// browser action tools themselves live in agentTools.ts, shared with telegramBridge.ts.
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

const ALL_TOOLS: Tool[] = [...SHARED_TOOLS, FINISH_CYCLE_TOOL, MARK_TASK_COMPLETE_TOOL]

/**
 * Starts a background loop that watches the screen and acts on its own timer, independent of
 * any live voice session — the user explicitly opted into this running without per-action
 * confirmation for THIS goal specifically (see request_permission's normal per-live-session
 * gate, which this deliberately bypasses via screenControl.setControlGranted).
 */
export function startAutonomousTask(goal: string): void {
  if (isActive()) stopAutonomousTask('replaced by a new task')
  currentGoal = goal
  history = []
  gridTargeting.clearGrids()
  screenControl.setAutonomousControlGranted(true)
  emit({ type: 'started', goal })
  log.info(`[autonomousTask] started, goal="${goal}", log file: ${log.transports.file.getFile().path}`)

  // A self-rescheduling timeout, not setInterval: a real tick (a Claude call plus several tool
  // rounds, each of which can itself retry) routinely runs longer than CHECK_INTERVAL_MS.
  // setInterval doesn't care and fires the next tick anyway, so two ticks end up running
  // concurrently — confirmed live: interleaved "round 0"/"round 3" log lines from two overlapping
  // ticks, each independently deciding to reply to the same incoming message, which is exactly
  // how a real duplicate WhatsApp send happened. Only ever schedule the next tick after the
  // current one has fully finished. `currentGoal` (not `timer`) is the source of truth for
  // "should this still be running" — it's what stopAutonomousTask actually clears, including when
  // tick() itself calls stopAutonomousTask (task completed / no API key) mid-cycle.
  const runCycle = async (): Promise<void> => {
    if (currentGoal === null) return // stopped while this tick was queued
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
    if (currentGoal !== null) timer = setTimeout(() => void runCycle(), CHECK_INTERVAL_MS)
  }

  void runCycle()
}

export function stopAutonomousTask(reason = 'stopped by user'): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (currentGoal) emit({ type: 'stopped', reason })
  currentGoal = null
  screenControl.setAutonomousControlGranted(false)
}

function pushHistory(narration: string): void {
  if (!narration) return
  history.push(narration)
  if (history.length > MAX_HISTORY) history.shift()
  emit({ type: 'log', text: narration })
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

You can take several actions across this check, but for anything that changes the page (a click, typing, a key press) prefer ONE such action per turn, then look at its result before deciding the next one — every click/type/press result tells you plainly if the page's visible text didn't change at all, which means it didn't work; when you see that, do not repeat the same action, and do not claim it succeeded. Only skip this one-at-a-time discipline for pure reads (browser_read_text, browser_evaluate) — those are safe to chain. Call finish_cycle once there's genuinely nothing further to do until the next check — never mid-sequence. Call mark_task_complete only once the ENTIRE goal is done.

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
      const verifiable = VERIFIABLE_ACTIONS.has(call.name) && (await browserControl.isOpen())
      const beforeText = verifiable ? await browserControl.getVisibleText().catch(() => null) : null

      let result: Record<string, unknown>
      try {
        result = await executeTool(call.name, callArgs)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
        log.error(`[autonomousTask] ${call.name} threw:`, err)
      }

      if (beforeText !== null) {
        const afterText = await browserControl.getVisibleText().catch(() => null)
        if (afterText !== null && afterText === beforeText) {
          result.warning =
            'The visible page text is IDENTICAL to before this action — nothing observably changed. Do not assume this worked. Re-observe (browser_read_text or a fresh look) before deciding what to do next, and do not repeat this exact action blindly.'
        }
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
