import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolResultBlockParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import * as browserControl from './browserControl'
import { SHARED_TOOLS, VERIFIABLE_ACTIONS, executeTool } from './agentTools'

/**
 * Remote text control — message DALVE on Telegram from anywhere and it runs the command through
 * the same screen/browser tool set as the autonomous task, replying with the result. No Telegram
 * dependency added: the Bot API is plain HTTPS (getUpdates long-poll, sendMessage), and Node's
 * built-in fetch is enough — not worth a whole extra npm package for two REST calls.
 *
 * Security model: a bot token alone is not treated as proof of ownership (a leaked/guessed token
 * would otherwise let a stranger message the bot and control this PC). The bot binds itself to
 * whichever chat sends the FIRST message after a token is saved, and silently ignores every other
 * chat from then on. Saving a new token clears the binding so it re-binds fresh.
 *
 * One real limitation, stated plainly rather than glossed over: this cannot turn the PC on. DALVE
 * only runs while the PC already is — "turn on my PC" needs Wake-on-LAN triggered by something
 * that's on when the PC isn't (a phone app on the same network, a router/relay), which is a
 * different mechanism entirely, not something running inside DALVE could ever provide.
 */

const POLL_MODEL = 'claude-sonnet-5'
const MAX_OUTPUT_TOKENS = 4096
// A remote command is a one-shot ask, not a recurring watch — bounded generously so a real multi-
// step request (open a site, search, read results, summarize) fits comfortably in one go.
const MAX_ROUNDS = 15
const LONG_POLL_TIMEOUT_S = 30

let running = false
let pollAbort: AbortController | null = null

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`
}

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(apiUrl(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) })
    })
  } catch (err) {
    log.error('[telegramBridge] sendMessage failed:', err)
  }
}

const TASK_COMPLETE_TOOL: Tool = {
  name: 'task_complete',
  description:
    "Call once you have a final answer, the requested action is done, or you've determined it genuinely can't be done from here — ends the command and sends `summary` back as the reply the user actually sees.",
  input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
}

const ALL_TOOLS: Tool[] = [...SHARED_TOOLS, TASK_COMPLETE_TOOL]

/** Runs one remote command to completion and returns the text to reply with. Mirrors
 *  autonomousTask.ts's tick() loop (same tools, same verify-by-diff discipline) but as a single
 *  bounded run instead of a recurring background check, with its own explicit completion signal
 *  instead of finish_cycle/mark_task_complete (there's no "next check" to defer to here). Exported
 *  so scheduler.ts can reuse the exact same real-execution path for a scheduled "message" item —
 *  one tested implementation instead of a second hand-rolled agent loop. */
export async function runCommand(commandText: string): Promise<string> {
  const apiKey = settingsStore.getAnthropicApiKey()
  if (!apiKey) return "I can't run remote commands yet — add a Claude API key in DALVE's Settings first."
  const anthropic = new Anthropic({ apiKey })

  const systemText = `You are DALVE, carrying out a command issued without anyone present to watch or confirm anything right now — either a remote Telegram message or a scheduled reminder/message firing on its own — so figure it out and get a real result rather than narrating what you would do. Call task_complete with a clear, concise summary once you have the actual answer/result, or once you've genuinely determined the request can't be done from here (say why). Never enter passwords/payment details/other credentials — if something requires that, say so in the summary instead of attempting it.

Current date/time: ${new Date().toString()}.

Real targeting priority, strongest to weakest — always use the strongest one that applies:
1. browser_open + browser_click/browser_type/browser_read_text/browser_evaluate for ANYTHING that's a website.
2. click_element for native desktop apps (not websites) with a visible label.
3. click_mouse/drag_mouse/define_grid+click_grid_cell — last resort, for genuinely non-web, non-textual content only.

For anything that changes something (a click, typing, a key press), prefer one such action at a time and check its result before the next — every result tells you plainly if the page's visible text didn't change at all, which means it didn't work; don't repeat the same action or claim success when you see that. Reads (browser_read_text, browser_evaluate) are safe to chain freely.

Some requests are physically impossible from here — turning the PC on/off, anything needing hardware DALVE has no access to. Say so plainly in task_complete rather than pretending to try.

The command: "${commandText}"`

  const firstShot = await screenControl.captureScreenshotOnce(80)
  const messages: MessageParam[] = [
    {
      role: 'user',
      content: firstShot
        ? [
            { type: 'text', text: systemText },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: firstShot } }
          ]
        : [{ type: 'text', text: systemText }]
    }
  ]

  screenControl.setRemoteControlGranted(true)
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      log.info(`[telegramBridge] round ${round}: calling ${POLL_MODEL}`)
      let response
      try {
        response = await anthropic.messages.create({ model: POLL_MODEL, max_tokens: MAX_OUTPUT_TOKENS, tools: ALL_TOOLS, messages })
      } catch (err) {
        log.error('[telegramBridge] messages.create threw:', err instanceof Error ? err.stack : err)
        return `Hit an error trying to do that: ${err instanceof Error ? err.message : String(err)}`
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use')
      const textBlocks = response.content.filter((b) => b.type === 'text')
      log.info(
        `[telegramBridge] round ${round} response: toolUses=${toolUses.length}` +
          (toolUses.length ? ` names=[${toolUses.map((c) => c.name).join(', ')}]` : '')
      )

      if (toolUses.length === 0) {
        const text = textBlocks.map((t) => t.text).join(' ').trim()
        return text || "Done, but I didn't come back with anything specific to report."
      }

      messages.push({ role: 'assistant', content: response.content })

      const complete = toolUses.find((c) => c.name === 'task_complete')
      if (complete) {
        const completeArgs = (complete.input ?? {}) as Record<string, unknown>
        return String(completeArgs.summary ?? 'Done.')
      }

      const toolResults: ToolResultBlockParam[] = []
      for (const call of toolUses) {
        const callArgs = (call.input ?? {}) as Record<string, unknown>
        const verifiable = VERIFIABLE_ACTIONS.has(call.name) && (await browserControl.isOpen())
        const beforeText = verifiable ? await browserControl.getVisibleText().catch(() => null) : null

        log.info(`[telegramBridge] executing ${call.name} args=${JSON.stringify(callArgs)}`)
        let result: Record<string, unknown>
        try {
          result = await executeTool(call.name, callArgs)
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
          log.error(`[telegramBridge] ${call.name} threw:`, err)
        }

        if (beforeText !== null) {
          const afterText = await browserControl.getVisibleText().catch(() => null)
          if (afterText !== null && afterText === beforeText) {
            result.warning =
              'The visible page text is IDENTICAL to before this action — nothing observably changed. Do not assume this worked.'
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 4000) })
      }

      const nextShot = await screenControl.captureScreenshotOnce(80)
      const nextContent: ContentBlockParam[] = [...toolResults]
      if (nextShot) nextContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: nextShot } })
      messages.push({ role: 'user', content: nextContent })
    }

    return "That took more steps than I could finish in one go — try breaking it into a smaller request."
  } finally {
    screenControl.setRemoteControlGranted(false)
  }
}

interface TelegramUpdate {
  update_id: number
  message?: { text?: string; chat: { id: number | string } }
}

async function pollLoop(): Promise<void> {
  let offset = 0
  while (running) {
    const token = settingsStore.getTelegramBotToken()
    if (!token) {
      await new Promise((r) => setTimeout(r, 5000))
      continue
    }

    pollAbort = new AbortController()
    let data: { ok: boolean; result?: TelegramUpdate[] } | null = null
    try {
      const res = await fetch(`${apiUrl(token, 'getUpdates')}?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_S}`, {
        signal: pollAbort.signal
      })
      data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] }
    } catch (err) {
      if (!running) break
      log.error('[telegramBridge] getUpdates failed:', err)
      await new Promise((r) => setTimeout(r, 5000))
      continue
    }
    if (!data?.ok || !Array.isArray(data.result)) continue

    for (const update of data.result) {
      offset = Math.max(offset, update.update_id + 1)
      const message = update.message
      if (!message?.text) continue
      const chatId = String(message.chat.id)

      const boundChatId = settingsStore.getTelegramChatId()
      if (!boundChatId) {
        settingsStore.setTelegramChatId(chatId)
        log.info(`[telegramBridge] bound to chat ${chatId}`)
      } else if (chatId !== boundChatId) {
        log.info(`[telegramBridge] ignoring message from unbound chat ${chatId}`)
        continue
      }

      log.info(`[telegramBridge] command: "${message.text}"`)
      runCommand(message.text)
        .then((reply) => sendMessage(token, chatId, reply))
        .catch((err) => {
          log.error('[telegramBridge] runCommand threw:', err)
          void sendMessage(token, chatId, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }
}

/** Called once at app startup — a no-op (just idles, re-checking every 5s) until a bot token is
 *  actually configured in Settings, so it works whenever the user gets to setting one up without
 *  needing an app restart. */
export function initTelegramBridge(): void {
  if (running) return
  running = true
  void pollLoop()
}

export function stopTelegramBridge(): void {
  running = false
  pollAbort?.abort()
}
