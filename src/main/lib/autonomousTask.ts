import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolResultBlockParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
import { SHARED_TOOLS, VERIFIABLE_ACTIONS, executeTool } from './agentTools'
import type { AutonomousTaskEvent, Subtask } from '@shared/types'

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
let subtasks: Subtask[] = []
// Tracks whether the SAME exact action (name + args) just failed again unchanged, across both
// rounds within one tick and across ticks — a real, code-level signal (not a hope the model
// remembers on its own) that the current approach isn't working and a different one is needed.
let lastFailedSignature: string | null = null
let lastFailedCount = 0

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
  description:
    'Call once the ENTIRE goal is fully accomplished — stops the background task completely. finalSummary must synthesize everything accomplished into ONE coherent result (e.g. "Found 3 important emails today, summarized them, and drafted replies to 2"), not a restatement of individual steps.',
  input_schema: {
    type: 'object',
    properties: { narration: { type: 'string' }, finalSummary: { type: 'string' } },
    required: ['narration', 'finalSummary']
  }
}
const SET_SUBTASKS_TOOL: Tool = {
  name: 'set_subtasks',
  description:
    'For a goal with more than one distinct chunk of work (e.g. "go through emails, summarize the important ones, draft replies"), call this ONCE near the start to declare your plan as a checklist of short subtask descriptions, in order. Skip entirely for a single simple action. Calling it again replaces the whole list.',
  input_schema: {
    type: 'object',
    properties: { subtasks: { type: 'array', items: { type: 'string' }, description: 'Short descriptions, in the order you plan to do them.' } },
    required: ['subtasks']
  }
}
const COMPLETE_SUBTASK_TOOL: Tool = {
  name: 'complete_subtask',
  description: 'Marks one subtask (from set_subtasks) as done, by its exact text.',
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

const ALL_TOOLS: Tool[] = [...SHARED_TOOLS, FINISH_CYCLE_TOOL, MARK_TASK_COMPLETE_TOOL, SET_SUBTASKS_TOOL, COMPLETE_SUBTASK_TOOL]

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
  subtasks = []
  lastFailedSignature = null
  lastFailedCount = 0
  gridTargeting.clearGrids()
  screenControl.setAutonomousControlGranted(true)
  emit({ type: 'started', goal })
  emit({ type: 'subtasks', subtasks })
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

export function stopAutonomousTask(reason = 'stopped by user', summary?: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (currentGoal) emit({ type: 'stopped', reason, summary })
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

Current date/time: ${new Date().toString()} — use this to resolve any relative time ("tomorrow", "in an hour") into a real ISO 8601 datetime if you call create_reminder.

Real targeting priority, strongest to weakest — always use the strongest one that applies:
1. browser_open + browser_click/browser_type/browser_read_text/browser_evaluate for ANYTHING that's a website (WhatsApp Web included). This is real DOM lookup by actual text, not a coordinate guess, running in DALVE's own dedicated automation browser (separate from the screenshot below) — it cannot mis-click a browser's own toolbar/tabs/account button, since that browser has no visible chrome for it to ever address. If a site needs login (e.g. WhatsApp Web's QR code) the user needs to do that once in that window — say so plainly if you hit a login wall you can't get past yourself.
2. click_element for native desktop apps (not websites) with a visible label.
3. click_mouse/drag_mouse/define_grid+click_grid_cell from the screenshot below — last resort, for genuinely non-web, non-textual content only (a game, a drawing canvas).

You can take several actions across this check, but for anything that changes the page (a click, typing, a key press) prefer ONE such action per turn, then look at its result before deciding the next one — every click/type/press result tells you plainly if the page's visible text didn't change at all, which means it didn't work; when you see that, do not repeat the same action, and do not claim it succeeded. Only skip this one-at-a-time discipline for pure reads (browser_read_text, browser_evaluate) — those are safe to chain. Call finish_cycle once there's genuinely nothing further to do until the next check — never mid-sequence. Call mark_task_complete only once the ENTIRE goal is done.

The goal itself may span multiple applications — reading a value in one place and acting on it somewhere else is normal, not a reason to stop and report back partway through. Carry whatever you just read forward into the next app or site yourself, across as many actions/cycles as it takes.

UNCONDITIONAL rule for any goal that involves a chat/messaging app (WhatsApp or otherwise): every single cycle, check for new/unread messages and, if this goal covers replying to them, draft and actually send a reply yourself, completely on your own — right now, this cycle, not "noted, will reply once told." Never call finish_cycle after merely noticing a new message that needs a reply; that is exactly the "waits for the user to say reply" failure this task exists to prevent. The only acceptable reason to not reply immediately is genuine ambiguity the goal itself doesn't resolve (e.g. no idea what the correct answer/decision is) — in that case say so in your narration, but still don't just sit on an unanswered message silently.

RECOVERY PROTOCOL — when something fails, diagnose it and try a genuinely different method, don't repeat the same call or just give up and report back:
- A button/element wasn't found where expected → the layout may differ from what you assumed; re-observe first (browser_read_text or a fresh look at the screenshot), then try a different targeting tier (OCR/click_text instead of click_element, or vice versa) rather than the identical call again.
- An app didn't launch / isn't where expected → try activate_application in case it's already running under a slightly different title, or open_application again — don't silently stall.
- A site looks logged out → you cannot complete a real login yourself (no credentials); say so plainly in your narration and call finish_cycle rather than looping on it, but do check again next cycle in case the user logged back in.
- An unexpected popup/dialog appears → read it (it's often blocking everything behind it) and dismiss it (find and click its close/cancel/OK button) before retrying the original action, rather than treating it as the same failure.
- The page/screen looks different than last check → re-observe before acting; don't act on a stale assumption of what's on screen.
- A tool/API call returns an error → read the actual error. A rate-limit/timeout-shaped error is worth one retry after this cycle; a "not found"/"invalid"/structural error means the approach itself is wrong and needs a different method, not a retry.
If you see a "repeated failure" warning on a tool result below, that means this exact action already failed and was retried unchanged — you MUST do something meaningfully different this time (different tool, different target, or re-observe first), not call it again as-is.

For a goal with multiple distinct chunks of work, call set_subtasks ONCE near the start to declare your plan, then complete_subtask as each one finishes — this is your own explicit progress tracker, don't skip it for anything non-trivial. Skip it entirely for a single simple action.
${subtasks.length > 0 ? `\nCurrent checklist:\n${subtasks.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}\n` : ''}
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
    let finalSummary: string | undefined
    const toolResults: ToolResultBlockParam[] = []
    for (const call of toolUses) {
      const callArgs = (call.input ?? {}) as Record<string, unknown>

      if (call.name === 'finish_cycle' || call.name === 'mark_task_complete') {
        pushHistory(String(callArgs.narration ?? call.name))
        if (call.name === 'mark_task_complete') {
          shouldEndTask = true
          finalSummary = String(callArgs.finalSummary ?? callArgs.narration ?? '')
        }
        shouldEndCycle = true
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'acknowledged' })
        continue
      }

      if (call.name === 'set_subtasks') {
        const list = Array.isArray(callArgs.subtasks) ? (callArgs.subtasks as unknown[]).map(String) : []
        subtasks = list.map((text, i) => ({ id: `subtask_${i}`, text, done: false }))
        emit({ type: 'subtasks', subtasks })
        pushHistory(`Plan: ${list.join(' | ')}`)
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Checklist set.' })
        continue
      }

      if (call.name === 'complete_subtask') {
        const text = String(callArgs.text ?? '')
        const idx = subtasks.findIndex((s) => s.text === text)
        if (idx >= 0) {
          subtasks[idx] = { ...subtasks[idx], done: true }
          emit({ type: 'subtasks', subtasks })
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Marked done.' })
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `No subtask matches "${text}" exactly — check the text from set_subtasks.`
          })
        }
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

      // Real, code-level recovery signal — not dependent on the model remembering the recovery
      // protocol on its own. Fires only when the EXACT same call (name + args) fails/no-ops twice
      // in a row, so genuinely retrying a flaky action once is still fine.
      const failed = typeof result.error === 'string' || result.status === 'FAILED' || typeof result.warning === 'string'
      const signature = `${call.name}:${JSON.stringify(callArgs)}`
      if (failed && signature === lastFailedSignature) {
        lastFailedCount++
        if (lastFailedCount >= 2) {
          result.warning = `${typeof result.warning === 'string' ? result.warning + ' ' : ''}REPEATED FAILURE: this exact action (same tool, same arguments) has now failed ${lastFailedCount} times in a row — see the RECOVERY PROTOCOL above. Do not call it again unchanged.`
        }
      } else if (failed) {
        lastFailedSignature = signature
        lastFailedCount = 1
      } else {
        lastFailedSignature = null
        lastFailedCount = 0
      }

      log.info(`[autonomousTask] ${call.name} result=${JSON.stringify(result).slice(0, 500)}`)
      pushHistory(`${call.name}(${JSON.stringify(callArgs).slice(0, 200)}) -> ${JSON.stringify(result).slice(0, 300)}`)
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
    }

    if (shouldEndTask) {
      stopAutonomousTask('task completed', finalSummary)
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
