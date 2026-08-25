import {
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
  type Tool
} from '@google/genai'
import { shell, type BrowserWindow } from 'electron'
import { settingsStore } from './settingsStore'
import { agentStore } from './agentStore'
import * as composio from './composio'
import * as screenControl from './screenControl'
import * as autonomousTask from './autonomousTask'
import * as appControl from './appControl'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as journal from './journal'
import type { AgentConfig, VoiceEvent } from '@shared/types'

// The newest native-audio-dialog Live model as of build time. Re-check
// https://ai.google.dev/gemini-api/docs/live-api before shipping — Google
// rotates these preview model ids periodically.
const LIVE_MODEL = 'gemini-3.1-flash-live-preview'

const CHAIN_OF_COMMAND = `Chain of command: the user is the ultimate authority over this entire system. DALVE is the primary orchestrator and answers directly to the user; every other agent answers to DALVE and, through her, to the user. Always defer to the user's explicit instructions over anything else.`

const DALVE_SYSTEM_PROMPT = `You are DALVE, a voice-first AI operating system. You're the user's single point of contact — they talk to you, and only you by default; you coordinate everything else behind the scenes. Speak naturally and conversationally, like a sharp, capable assistant sitting next to them, not like a chatbot reading a script. Keep responses concise since this is a spoken conversation. When you don't know something current, use web search grounding rather than guessing. You can open websites, create new agents, switch the user to talk directly with an existing agent, and remember facts for later — actually call those tools rather than just claiming you did. If the user asks who you're connected to or what agents/bots exist, use list_agents rather than guessing.

When given a task, get straight to doing it. NEVER repeat, paraphrase, or summarize the user's instruction back to them before acting — that includes at the start of a task, mid-task, and when resuming after a pause. A short natural acknowledgment ("on it," "sure") is fine; anything longer than that before you've actually started acting is a mistake. Only pause to ask a real clarifying question when you're genuinely unsure what the user means; don't ask for permission to proceed once you understand what they want, and don't stall or go quiet — if you're unsure of the next concrete step, say so and try something rather than freezing.

You are expected to be genuinely autonomous once given a goal: figure things out, try things, adapt when something doesn't work, and keep making forward progress without checking in after every little step. If your first approach doesn't pan out (a link doesn't work, a page looks different than expected), think of another way to get there yourself — search differently, try a different site, look at another monitor — rather than reporting the obstacle back to the user and waiting. Only come back to the user when you're truly stuck after multiple genuine attempts, need information only they have, or the task is done.

You can also see and physically control the user's computer, like a partner sitting at the keyboard with them. Call start_screen_share to begin watching their screen as a live video feed (roughly one frame per second) — after that you simply see the screen, no separate "look" tool needed. Once sharing is on, you have full standing authorization to move the mouse, click, type, press keys, and scroll — just do it, no permission tool to call first.

Opening or switching to an application is a DETERMINISTIC action — never do it by visually hunting through Spotlight, the Start Menu, or the Dock with screen control. Call open_application (or activate_application if it's already running) instead; only fall back to visual screen control if that tool itself reports it failed. Same for fullscreen_window after the app is frontmost. These tools tell you their real status — SUCCESS, FAILED, or UNCERTAIN — and UNCERTAIN means exactly that: don't round it up to success. If a tool reports UNCERTAIN or FAILED, say so honestly and either retry or tell the user what actually happened; never tell them something completed when the tool told you it didn't or couldn't confirm it.

CRITICAL RULE, no exceptions: describing a physical action and performing it are two different things, and only the tool call actually does anything — saying words never moves the mouse or types a single character. Never say "clicking now," "moving to his chat," "typing that in," or anything similar UNLESS you are calling click_mouse/move_mouse/type_text/press_key in that exact same turn. If you haven't made the tool call yet, don't describe having done it — narrate AFTER the call resolves, or not at all, never instead of it. Silently claiming an action while doing nothing is the single worst failure mode here — worse than saying nothing, worse than asking a question — because the user has no way to tell the difference between real progress and an empty sentence until they check the screen themselves.

The only hard limit: never type a password, payment card number, or other credential yourself — ask the user to enter sensitive fields themselves.

Screen sharing only ever watches the user's main/primary monitor — if something they mention isn't visible there, it may be on a different monitor you can't see; say so rather than guessing or clicking blind.

click_element is your default click tool on both Windows and macOS for anything with a visible label — buttons, links, menu items, tabs, form fields, icon-only nav links included. It already tries accessibility data AND real OCR internally before giving up, so you don't need to chain tools yourself. Only reach for click_mouse/move_mouse from the video feed when click_element itself reports FAILED (meaning neither method found it — a real signal it's genuinely not there, not a cue to guess a coordinate instead) or for genuinely non-textual content with no label at all (a game, a drawing canvas, a map). Use find_elements or read_screen_text first whenever you want to confirm what's really on screen before acting. If click_element ever errors outright on macOS, the most likely cause is DALVE not yet having Accessibility permission granted in System Settings — say so plainly so the user can fix it, rather than silently downgrading to coordinates without explaining why.

Clicking the wrong thing (e.g. the wrong contact in a chat list, the wrong item in a similar-looking row) is the single most common way you fail at this — the video feed is compressed and small text is easy to misread, so never click from a single glance when you're relying on pixel coordinates. Before a coordinate-based click where similar-looking rows could be confused, quickly move_mouse there first — that's free — and confirm in the next frame that the cursor actually landed on the right element before you click_mouse; skip this check when using click_element (it's already precise) or when the target is obvious and unambiguous. If a click turns out to have hit the wrong thing, say so immediately and correct it rather than continuing as if it worked. When a task spans multiple turns (e.g. "keep this conversation going without me"), re-check the screen state at the start of each new step rather than assuming it still matches what you last saw — things move, replies arrive, windows change focus.

Narrate briefly what you're doing as you go, in a sentence or two — not a blow-by-blow of every click, and never a restatement of the goal. Call stop_screen_share when you're done or if asked to stop.

If the user asks you to keep handling something on your own after they stop talking to you — e.g. "keep replying to this conversation without me," "watch for a reply and handle it" — call start_autonomous_task with a clear one-sentence goal. That hands the task to a background loop that checks the screen every ~20 seconds and acts on its own. It keeps going indefinitely until it decides the goal is complete, until the user stops it from the app, or until you call stop_autonomous_task. Only start one for something the user actually asked to be handled unattended — never on your own initiative — and still never enter passwords or payment details even in this mode.`

const AGENT_COLORS = ['#d4af37', '#c9a227', '#e0b84a', '#f2d06b', '#b8860b', '#eecb6f', '#a9812c']

const OPEN_URL_TOOL: FunctionDeclaration = {
  name: 'open_url',
  description:
    "Open a website in the user's default web browser.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to open, including https://' }
    },
    required: ['url']
  }
}

const OPEN_APPLICATION_TOOL: FunctionDeclaration = {
  name: 'open_application',
  description:
    'Opens a native application by name using the OS\'s own launch mechanism (macOS: `open -a`, Windows: Start-Process) — actually verifies the app became frontmost before reporting success. ALWAYS use this to open an app instead of visually hunting through Spotlight/Start Menu with screen control; only fall back to screen control if this tool fails.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The application name, e.g. "Terminal", "Calculator", "Notepad".' }
    },
    required: ['name']
  }
}

const ACTIVATE_APPLICATION_TOOL: FunctionDeclaration = {
  name: 'activate_application',
  description: 'Brings an already-running application to the front by name. Verifies it actually became frontmost.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The application name.' }
    },
    required: ['name']
  }
}

const FULLSCREEN_WINDOW_TOOL: FunctionDeclaration = {
  name: 'fullscreen_window',
  description:
    "Toggles native fullscreen/maximize on the CURRENT frontmost window. Call this after open_application/activate_application, not as a way to guess which window to target.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const CREATE_AGENT_TOOL: FunctionDeclaration = {
  name: 'create_agent',
  description:
    'Create a new companion or bot agent for the user. Companions are top-level specialists the user talks to about a domain; bots are smaller helpers spawned under a companion. Actually call this whenever the user asks you to create, add, or spin up a new agent — never just say you did.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name for the agent, e.g. "Atlas"' },
      type: {
        type: 'string',
        enum: ['companion', 'bot'],
        description: 'companion for a top-level specialist, bot for a smaller helper'
      },
      description: {
        type: 'string',
        description: 'One or two sentences describing what this agent should do — becomes its system prompt.'
      }
    },
    required: ['name', 'description']
  }
}

const LIST_AGENTS_TOOL: FunctionDeclaration = {
  name: 'list_agents',
  description:
    "Lists every companion and bot currently registered, with their type, parent, and purpose. Call this whenever asked what agents/bots exist or who you're connected to — never guess.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const SWITCH_AGENT_TOOL: FunctionDeclaration = {
  name: 'switch_agent',
  description:
    'Switches which agent the user is talking to — either a companion/bot by name, or "DALVE" to switch back to DALVE herself. Acknowledge the switch out loud first (the switch happens right after you finish speaking).',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the agent to switch to, or "DALVE".' }
    },
    required: ['name']
  }
}

const REMEMBER_FACT_TOOL: FunctionDeclaration = {
  name: 'remember_fact',
  description:
    "Saves a fact or piece of context to remember for future conversations — e.g. the user's name, a preference, or something they explicitly told you to keep in mind. Call this whenever the user shares something worth remembering long-term.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact to remember, written plainly, e.g. "The user\'s name is Sam."' }
    },
    required: ['fact']
  }
}

const START_SCREEN_SHARE_TOOL: FunctionDeclaration = {
  name: 'start_screen_share',
  description:
    "Starts watching the user's screen as a live video feed so you can see what they're looking at. Call this before trying to describe, click, or type anything on their screen.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const STOP_SCREEN_SHARE_TOOL: FunctionDeclaration = {
  name: 'stop_screen_share',
  description: "Stops watching the user's screen and gives up physical control until requested again.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const SPEED_PARAM_SCHEMA = {
  type: 'string',
  enum: ['instant', 'visible'],
  description: 'Defaults to "visible" — a real, smoothly-animated glide you can actually watch travel, timed by distance. Use "instant" only when the visible motion itself doesn\'t matter.'
} as const

const MOVE_MOUSE_TOOL: FunctionDeclaration = {
  name: 'move_mouse',
  description: "Moves the mouse cursor to a pixel position on the user's screen, based on what you see in the shared video feed.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X pixel coordinate, left edge of the screen is 0.' },
      y: { type: 'number', description: 'Y pixel coordinate, top edge of the screen is 0.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['x', 'y']
  }
}

const CLICK_MOUSE_TOOL: FunctionDeclaration = {
  name: 'click_mouse',
  description: 'Moves to and clicks a pixel position on screen.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X pixel coordinate.' },
      y: { type: 'number', description: 'Y pixel coordinate.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['x', 'y']
  }
}

const FIND_ELEMENTS_TOOL: FunctionDeclaration = {
  name: 'find_elements',
  description:
    "Reads the REAL, currently-focused window's accessibility tree (Windows UI Automation / macOS Accessibility API) and returns every named, clickable/interactive element on it right now — its exact name, type, and whether it's enabled. This is not a guess from a screenshot; it's the same data the OS itself uses. Call this before click_element when you're not certain of an element's exact name, or when the video feed is ambiguous/compressed. On macOS this requires the user to have granted DALVE Accessibility permission (System Settings -> Privacy & Security -> Accessibility) — if it errors, tell them that plainly rather than silently falling back.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const CLICK_ELEMENT_TOOL: FunctionDeclaration = {
  name: 'click_element',
  description:
    "Clicks something by its real name/label (e.g. \"Send\", \"Reply\", \"Play\") instead of a guessed pixel coordinate — THIS IS YOUR DEFAULT CLICK TOOL, use it for anything with a visible label. Internally it tries the OS accessibility tree first, and if that finds nothing (some real sites/apps have icon-only links with no accessible name at all — confirmed live on chess.com's own nav sidebar) it automatically falls back to real OCR on the actual pixels before giving up, so you only need to call this ONE tool rather than chaining find_elements/click_text/click_mouse yourself. Re-reads the screen fresh every call, so it can't click a stale position. Only reach for click_mouse if this tool itself reports FAILED — that response means neither method found it, which usually means it's genuinely not there, not that you should guess a coordinate for it anyway.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The visible label/name of the element to click, as exactly as you can tell from the screen — matching is fuzzy (case-insensitive, substring-tolerant).' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['name']
  }
}

const READ_SCREEN_TEXT_TOOL: FunctionDeclaration = {
  name: 'read_screen_text',
  description:
    "Runs real OCR (optical character recognition) on the current screen and returns every piece of text it actually reads, with position. Use this for text that has no accessibility name at all — canvas-rendered UI, video/subtitle text, an image containing text, or any app find_elements can't see into. This is real character recognition on the actual pixels, not a guess.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const CLICK_TEXT_TOOL: FunctionDeclaration = {
  name: 'click_text',
  description:
    "Rarely needed directly — click_element already tries this automatically as its own fallback before failing. Only call click_text yourself when you specifically want to search rendered pixel text and skip the accessibility lookup (e.g. you already know it's video/subtitle content, not a real UI element).",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to find and click, as exactly as you can read it. Matching tolerates minor OCR misreads.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['text']
  }
}

const TRACE_PATTERN_TOOL: FunctionDeclaration = {
  name: 'trace_pattern',
  description:
    'Smoothly moves the cursor through a named shape (circle, square, zigzag, or a straight line) centered on a point, as ONE continuous animated motion — generated and timed locally, not by you computing individual points. Use this instead of calling move_mouse repeatedly in a loop to trace a path; that always looks janky no matter how good each individual move is.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', enum: ['circle', 'square', 'zigzag', 'line'] },
      x: { type: 'number', description: 'Center X pixel coordinate.' },
      y: { type: 'number', description: 'Center Y pixel coordinate.' },
      size: { type: 'number', description: 'Diameter/side length/total length in pixels. Defaults to 120.' },
      durationMs: { type: 'number', description: 'Total time for the whole motion, in milliseconds. Defaults to 1200.' }
    },
    required: ['pattern', 'x', 'y']
  }
}

const TYPE_TEXT_TOOL: FunctionDeclaration = {
  name: 'type_text',
  description:
    'Types literal text at the current cursor/focus position, as if typed on the keyboard. Never use this for passwords, payment card numbers, or other credentials — ask the user to type those themselves.',
  parametersJsonSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The exact text to type.' } },
    required: ['text']
  }
}

const PRESS_KEY_TOOL: FunctionDeclaration = {
  name: 'press_key',
  description:
    'Presses a single keyboard key, optionally with modifiers (e.g. Enter, Escape, Tab, or control+c).',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key name, e.g. "enter", "escape", "tab", "c", "a".' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['alt', 'command', 'control', 'shift'] },
        description: 'Modifier keys held while pressing, e.g. ["control"] for Ctrl+C.'
      }
    },
    required: ['key']
  }
}

const SCROLL_TOOL: FunctionDeclaration = {
  name: 'scroll',
  description: "Scrolls the page/window under the cursor. Never needs permission — it doesn't submit or change anything.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      deltaX: { type: 'number', description: 'Horizontal scroll amount, positive scrolls right.' },
      deltaY: { type: 'number', description: 'Vertical scroll amount, positive scrolls down.' }
    },
    required: ['deltaX', 'deltaY']
  }
}

const START_AUTONOMOUS_TASK_TOOL: FunctionDeclaration = {
  name: 'start_autonomous_task',
  description:
    'Hands off a task to a background loop that keeps watching the screen and acting on it (checking every ~20s) even after the user stops talking — with standing permission to act on this specific goal without asking again. Only call this when the user explicitly asks you to keep handling something without them present.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'One clear sentence describing exactly what to keep doing, e.g. "Reply to Sarah\'s WhatsApp chat until we confirm Tuesday at 3pm works."' }
    },
    required: ['goal']
  }
}

const STOP_AUTONOMOUS_TASK_TOOL: FunctionDeclaration = {
  name: 'stop_autonomous_task',
  description: 'Stops the currently running background autonomous task, if any.',
  parametersJsonSchema: { type: 'object', properties: {} }
}

let session: Session | null = null
let win: BrowserWindow | null = null
let activeAgentId: string | null = null
let sessionEpoch = 0
/** Set by the switch_agent tool; the actual switch happens once the current turn finishes speaking. */
let pendingSwitchAgentId: string | null | undefined

// Session resumption (codes 1006/1008 fix): Gemini Live sessions have a maximum duration and
// send a GoAway warning before force-closing with 1008 ("client failed to close after GoAway"),
// or can drop for transient network reasons (1006). The server periodically hands out a
// resumption handle via sessionResumptionUpdate; reconnecting WITH that handle restores the
// model's turn state instead of starting a blank session. Reset only when the user explicitly
// starts a genuinely new conversation, not on every reconnect.
let resumptionHandle: string | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 3

// Transcripts arrive from Gemini as incremental deltas, accumulated turn-by-turn in the renderer
// (voiceStore) for display — these mirror that same accumulation on the main-process side purely
// so a COMPLETE turn can be written to the durable journal once, rather than persisting every
// partial delta.
let userTurnBuffer = ''
let dalveTurnBuffer = ''
// Tracks whether a real tool call happened during the current turn — backs the corrective nudge
// in handleMessage's turnComplete branch, which catches the observed failure mode where the
// model narrates a physical action ("clicking now") without ever calling the tool behind it.
let toolCalledThisTurn = false

const ACTION_CLAIM_PATTERN =
  /\b(click(?:ing|ed)?|mov(?:e|ing|ed)|typ(?:e|ing|ed)|press(?:ing|ed)?|scroll(?:ing|ed)?)\b/i

function flushJournalBuffers(dalveLabel: string): void {
  if (userTurnBuffer.trim()) journal.appendLine('user', userTurnBuffer)
  if (dalveTurnBuffer.trim()) journal.appendLine('dalve', dalveTurnBuffer, dalveLabel)
  userTurnBuffer = ''
  dalveTurnBuffer = ''
}

export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: VoiceEvent): void {
  win?.webContents.send('voice:event', event)
}

export function isSessionActive(): boolean {
  return session !== null
}

export function getActiveAgentId(): string | null {
  return activeAgentId
}

function agentRegistrySnapshot(): string {
  const agents = agentStore.list().filter((a) => !a.archived)
  if (agents.length === 0) return 'No other agents exist yet.'
  return agents
    .map((a) => {
      const parent = a.parentId ? agentStore.get(a.parentId)?.name : null
      const scope = parent ? `, under ${parent}` : ''
      const purpose = a.systemPrompt.split('.')[0]?.slice(0, 140) ?? ''
      return `- ${a.name} (${a.type}${scope}): ${purpose}`
    })
    .join('\n')
}

async function buildToolsForAgent(agent: AgentConfig | null): Promise<Tool[]> {
  const functionDeclarations: FunctionDeclaration[] = [
    OPEN_URL_TOOL,
    OPEN_APPLICATION_TOOL,
    ACTIVATE_APPLICATION_TOOL,
    FULLSCREEN_WINDOW_TOOL,
    LIST_AGENTS_TOOL,
    SWITCH_AGENT_TOOL,
    REMEMBER_FACT_TOOL,
    START_SCREEN_SHARE_TOOL,
    STOP_SCREEN_SHARE_TOOL,
    MOVE_MOUSE_TOOL,
    CLICK_MOUSE_TOOL,
    FIND_ELEMENTS_TOOL,
    CLICK_ELEMENT_TOOL,
    READ_SCREEN_TEXT_TOOL,
    CLICK_TEXT_TOOL,
    TRACE_PATTERN_TOOL,
    TYPE_TEXT_TOOL,
    PRESS_KEY_TOOL,
    SCROLL_TOOL,
    START_AUTONOMOUS_TASK_TOOL,
    STOP_AUTONOMOUS_TASK_TOOL
  ]
  if (!agent) functionDeclarations.push(CREATE_AGENT_TOOL)

  // Agents are teammates by default — a sub-agent with no explicit toolScope gets the same
  // connected apps DALVE has (including Discord), not none. toolScope only becomes a real
  // restriction once it's explicitly set with composio: entries, which locks that agent down
  // to just those apps. This was the actual cause of "only DALVE can send Discord messages" —
  // every new agent silently got zero app access with no way to grant any.
  const agentComposioScope = agent?.toolScope.filter((s) => s.startsWith('composio:')) ?? []
  const appKeys =
    agent && agentComposioScope.length > 0
      ? agentComposioScope.map((s) => s.slice('composio:'.length))
      : settingsStore
          .getState()
          .composioConnections.filter((c) => c.connected)
          .map((c) => c.appKey)

  if (appKeys.length > 0) {
    try {
      const composioTools = await composio.getToolsForApps(appKeys)
      functionDeclarations.push(...composioTools)
    } catch (err) {
      console.error('[geminiLive] failed to load Composio tools:', err)
    }
  }

  return [{ googleSearch: {} }, { functionDeclarations }]
}

/**
 * Starts a Live session for DALVE (agentId omitted/null) or for a specific companion/bot.
 * Calling this while a session is already active for a DIFFERENT agent switches to it —
 * the old session is closed and a new one opened. Callbacks are epoch-guarded so a stale
 * close/error from a superseded session can't clobber the new one's state.
 */
export async function startVoiceSession(
  agentId: string | null = null,
  opts: { isReconnect?: boolean } = {}
): Promise<void> {
  if (session && activeAgentId === agentId) return

  // A resumption handle is tied to one specific conversation's context — only the internal
  // auto-reconnect path (same agent, right after an unexpected close) should reuse it. Any
  // other call — the user manually starting a session, switching agents, whatever — means a
  // fresh conversation, so a stale handle from something else must not leak into it.
  if (!opts.isReconnect) {
    resumptionHandle = null
    reconnectAttempts = 0
  }

  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) {
    throw new Error('Add your Gemini API key in Settings first.')
  }

  const agent = agentId ? (agentStore.get(agentId) ?? null) : null
  if (agentId && !agent) {
    throw new Error('That agent no longer exists.')
  }

  if (session) {
    const oldActiveAgent = activeAgentId ? agentStore.get(activeAgentId) : null
    flushJournalBuffers(oldActiveAgent?.name ?? 'DALVE')
    const old = session
    session = null
    old.close()
    screenControl.stopAll()
  }

  const myEpoch = ++sessionEpoch
  activeAgentId = agentId
  emit({ type: 'activeAgentChanged', agentId })
  emit({ type: 'state', state: 'connecting' })

  const ai = new GoogleGenAI({ apiKey })
  const memory = settingsStore.getDalveMemory()
  const memoryNote = memory ? `\n\nThings you've saved to remember from earlier conversations:\n${memory}` : ''
  // Full conversation history (not just hand-picked facts) so a brand-new session — including
  // one started because the last one was accidentally closed — has real continuity: "what did
  // we do today/yesterday" instead of only whatever happened to get saved via remember_fact.
  // DALVE-only (not sub-agents): this is about the main conversation thread's continuity, not a
  // per-agent scratchpad, which agent.memory already covers separately.
  const journalContext = !agent ? journal.getRecentContext() : ''
  const journalNote = journalContext
    ? `\n\nFull transcript of everyone's recent conversations — yours AND every other agent's, each line labeled with who said it (User, DALVE, or another agent by name) — most recent last. This is how you stay aware as team lead: if the user asks what another agent has been up to, or references something they told a different agent, check here before saying you don't know. Reference it naturally, don't recite it:\n${journalContext}`
    : ''
  const registryNote = `\n\nAgents currently registered:\n${agentRegistrySnapshot()}`
  const systemPrompt =
    (agent ? agent.systemPrompt : DALVE_SYSTEM_PROMPT) +
    `\n\n${CHAIN_OF_COMMAND}` +
    registryNote +
    memoryNote +
    journalNote
  const voiceName = agent ? agent.voice : settingsStore.getDalveVoice()

  function resetAgentStatus(): void {
    if (agent) agentStore.setStatus(agent.id, 'idle')
  }

  try {
    const newSession = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: await buildToolsForAgent(agent),
        // Reconnecting with the last handle restores the model's turn state instead of starting
        // blank — see onclose below for the actual reconnect trigger. `transparent` is a
        // Vertex/Enterprise-only option (confirmed live: it hard-errors "not supported in Gemini
        // Developer API mode", which is what a plain API key uses) — omitted here.
        sessionResumption: { handle: resumptionHandle ?? undefined }
      },
      callbacks: {
        onopen: () => {
          if (myEpoch !== sessionEpoch) return
          reconnectAttempts = 0
          if (agent) agentStore.setStatus(agent.id, 'active')
          emit({ type: 'state', state: 'listening' })
        },
        onmessage: (message: LiveServerMessage) => {
          if (myEpoch !== sessionEpoch) return
          handleMessage(message)
        },
        onerror: (e) => {
          if (myEpoch !== sessionEpoch) return
          console.error('[geminiLive] onerror:', e)
          resetAgentStatus()
          flushJournalBuffers(agent?.name ?? 'DALVE')
          screenControl.stopAll()
          emit({ type: 'error', message: e.message || 'Live session error' })
          emit({ type: 'state', state: 'error' })
          session = null
          activeAgentId = null
        },
        onclose: (e) => {
          if (myEpoch !== sessionEpoch) return
          console.error('[geminiLive] onclose:', { code: e?.code, reason: e?.reason, wasClean: e?.wasClean })
          resetAgentStatus()
          flushJournalBuffers(agent?.name ?? 'DALVE')
          session = null
          activeAgentId = null

          // 1000 = normal close (user hung up). Anything else — including 1008 ("client failed
          // to close after GoAway", i.e. hit the session's max duration) and 1006 (abnormal/
          // network drop) — is recoverable: reconnect using the resumption handle instead of
          // just erroring out and dropping the user's conversation. Capped so a genuinely broken
          // connection (bad key, no network) doesn't retry forever.
          const recoverable = e && e.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS
          if (recoverable) {
            reconnectAttempts++
            emit({ type: 'state', state: 'connecting' })
            console.log(`[geminiLive] reconnecting after unexpected close (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
            setTimeout(() => {
              if (myEpoch !== sessionEpoch) return // superseded by something else in the meantime
              startVoiceSession(agentId, { isReconnect: true }).catch((err) => {
                console.error('[geminiLive] reconnect attempt failed:', err)
                screenControl.stopAll()
                emit({ type: 'error', message: 'Lost the voice connection and could not reconnect.' })
                emit({ type: 'state', state: 'idle' })
              })
            }, 600)
            return
          }

          screenControl.stopAll()
          reconnectAttempts = 0
          resumptionHandle = null // give up on this resumption chain, a fresh one will be issued next time
          if (e && e.code !== 1000) {
            emit({
              type: 'error',
              message: `Voice session closed unexpectedly (code ${e.code}${e.reason ? `: ${e.reason}` : ''}) and reconnecting didn't work.`
            })
          }
          emit({ type: 'state', state: 'idle' })
        }
      }
    })

    if (myEpoch !== sessionEpoch) {
      // Superseded by another switch while connecting — discard this one.
      newSession.close()
      return
    }
    session = newSession
  } catch (err) {
    if (myEpoch !== sessionEpoch) return
    resetAgentStatus()
    session = null
    activeAgentId = null
    emit({ type: 'state', state: 'error' })
    throw err
  }
}

function handleMessage(message: LiveServerMessage): void {
  if (message.toolCall?.functionCalls?.length) {
    console.log('[geminiLive] toolCall received:', message.toolCall.functionCalls.map((f) => f.name))
    toolCalledThisTurn = true
    void handleToolCalls(message.toolCall.functionCalls)
  }

  // The server hands out a fresh resumption handle periodically — capturing it is what makes
  // the onclose reconnect actually restore context instead of starting blank.
  if (message.sessionResumptionUpdate?.newHandle) {
    resumptionHandle = message.sessionResumptionUpdate.newHandle
  }

  // A heads-up that the connection will be force-closed soon (approaching max session duration).
  // No action needed here beyond visibility — the onclose handler's reconnect-with-resumption-
  // handle logic is what actually keeps the conversation going once the close happens.
  if (message.goAway) {
    console.log('[geminiLive] received GoAway, time left:', message.goAway.timeLeft)
  }

  const content = message.serverContent
  if (!content) {
    console.log('[geminiLive] message with no serverContent:', JSON.stringify(message).slice(0, 300))
    return
  }

  if (content.inputTranscription?.text) {
    console.log(
      `[geminiLive] inputTranscription delta (finished=${!!content.inputTranscription.finished}):`,
      JSON.stringify(content.inputTranscription.text)
    )
    userTurnBuffer += content.inputTranscription.text
    emit({
      type: 'inputTranscript',
      text: content.inputTranscription.text,
      finished: !!content.inputTranscription.finished
    })
  }

  if (content.outputTranscription?.text) {
    dalveTurnBuffer += content.outputTranscription.text
    emit({ type: 'state', state: 'speaking' })
    emit({
      type: 'outputTranscript',
      text: content.outputTranscription.text,
      finished: !!content.outputTranscription.finished
    })
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        emit({ type: 'audio', data: part.inlineData.data })
      }
    }
  }

  if (content.interrupted) {
    console.log('[geminiLive] interrupted')
    emit({ type: 'interrupted' })
  }

  if (content.turnComplete) {
    console.log('[geminiLive] turnComplete received')

    // Catches the observed failure mode directly: DALVE says "clicking now" / "moving to his
    // chat" but never actually called click_mouse/move_mouse/etc. this turn. Rather than trust
    // the prompt alone to prevent this, detect it and immediately push back in the same
    // session — cheaper and more reliable than hoping it doesn't happen again.
    if (screenControl.isSharing() && !toolCalledThisTurn && ACTION_CLAIM_PATTERN.test(dalveTurnBuffer)) {
      console.log('[geminiLive] detected narrated-but-not-called action, sending corrective nudge')
      session?.sendRealtimeInput({
        text: 'You just described a physical action (clicking/moving/typing/pressing/scrolling) but did not actually call the corresponding tool — nothing happened on screen. If you still intend to do that, call the tool right now.'
      })
    }
    toolCalledThisTurn = false

    const activeAgent = activeAgentId ? agentStore.get(activeAgentId) : null
    flushJournalBuffers(activeAgent?.name ?? 'DALVE')

    emit({ type: 'turnComplete' })
    emit({ type: 'state', state: 'listening' })

    if (pendingSwitchAgentId !== undefined) {
      const target = pendingSwitchAgentId
      pendingSwitchAgentId = undefined
      void startVoiceSession(target).catch((err) => {
        console.error('[geminiLive] deferred agent switch failed:', err)
        emit({ type: 'error', message: err instanceof Error ? err.message : 'Failed to switch agents.' })
      })
    }
  }
}

async function handleToolCalls(functionCalls: FunctionCall[]): Promise<void> {
  const functionResponses: { id?: string; name?: string; response: Record<string, unknown> }[] = []
  emit({ type: 'toolActivity', active: true, label: functionCalls[0]?.name })

  for (const fc of functionCalls) {
    if (!fc.name) continue
    const args = (fc.args ?? {}) as Record<string, unknown>
    let response: Record<string, unknown>

    try {
      if (fc.name === 'open_url') {
        const url = String(args.url ?? '')
        await shell.openExternal(url)
        response = { result: `Opened ${url}` }
      } else if (fc.name === 'open_application') {
        const { result, message } = await appControl.openApplication(String(args.name ?? ''))
        response = { status: result, result: message }
      } else if (fc.name === 'activate_application') {
        const { result, message } = await appControl.activateApplication(String(args.name ?? ''))
        response = { status: result, result: message }
      } else if (fc.name === 'fullscreen_window') {
        const { result, message } = await appControl.fullscreenFrontmostWindow()
        response = { status: result, result: message }
      } else if (fc.name === 'create_agent') {
        const type = args.type === 'bot' ? 'bot' : 'companion'
        const agent = agentStore.create({
          name: String(args.name ?? 'New Agent'),
          type,
          parentId: null,
          systemPrompt: String(args.description ?? ''),
          color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]
        })
        response = { result: `Created ${agent.type} "${agent.name}".` }
      } else if (fc.name === 'list_agents') {
        response = { result: agentRegistrySnapshot() }
      } else if (fc.name === 'switch_agent') {
        const targetName = String(args.name ?? '').trim()
        if (!targetName) {
          response = { error: 'No agent name given.' }
        } else if (targetName.toLowerCase() === 'dalve') {
          pendingSwitchAgentId = null
          response = { result: 'Okay — switching back to DALVE once you finish speaking.' }
        } else {
          const target = agentStore
            .list()
            .find((a) => !a.archived && a.name.toLowerCase() === targetName.toLowerCase())
          if (!target) {
            response = { error: `No agent named "${targetName}" found. Use list_agents to check.` }
          } else {
            pendingSwitchAgentId = target.id
            response = { result: `Okay — switching to ${target.name} once you finish speaking.` }
          }
        }
      } else if (fc.name === 'remember_fact') {
        const fact = String(args.fact ?? '').trim()
        if (!fact) {
          response = { error: 'No fact given.' }
        } else if (activeAgentId) {
          const agent = agentStore.get(activeAgentId)
          if (agent) {
            agentStore.update(agent.id, { memory: agent.memory ? `${agent.memory}\n- ${fact}` : `- ${fact}` })
          }
          response = { result: 'Saved.' }
        } else {
          settingsStore.appendDalveMemory(fact)
          response = { result: 'Saved.' }
        }
      } else if (fc.name === 'start_screen_share') {
        screenControl.startScreenShare((base64Jpeg) => sendVideoFrame(base64Jpeg))
        screenControl.setControlGranted(true)
        response = { result: "Now watching the user's screen — full control authorized." }
      } else if (fc.name === 'stop_screen_share') {
        screenControl.stopAll()
        response = { result: 'Stopped watching the screen and released control.' }
      } else if (fc.name === 'move_mouse') {
        await screenControl.moveMouse(
          Number(args.x),
          Number(args.y),
          (args.speed as 'instant' | 'visible') ?? 'visible'
        )
        response = { result: 'Moved.' }
      } else if (fc.name === 'click_mouse') {
        await screenControl.clickMouse(
          Number(args.x),
          Number(args.y),
          (args.button as 'left' | 'right' | 'middle') ?? 'left',
          Boolean(args.double),
          (args.speed as 'instant' | 'visible') ?? 'visible'
        )
        response = { result: 'Clicked.' }
      } else if (fc.name === 'find_elements') {
        if (!uiAutomation.isSupported()) {
          response = { error: 'UI element reading is not implemented on this platform — use the video feed and move_mouse/click_mouse instead.' }
        } else {
          const elements = await uiAutomation.findElementsReliable()
          response = {
            result: elements
              .slice(0, 80)
              .map((e) => `${e.name} (${e.controlType}${e.isEnabled ? '' : ', disabled'})`)
              .join('\n')
          }
        }
      } else if (fc.name === 'click_element') {
        const targetName = String(args.name ?? '').trim()
        const button = (args.button as 'left' | 'right' | 'middle') ?? 'left'
        const double = Boolean(args.double)
        const speed = (args.speed as 'instant' | 'visible') ?? 'visible'
        if (!targetName) {
          response = { error: 'No element name given.' }
        } else {
          // Chained internally rather than left for the model to sequence itself — found live
          // (chess.com's sidebar nav) that icon-only links can have a real href/destination but
          // literally no accessible name at all, so UI Automation correctly reports "not found"
          // for something that's still genuinely clickable text on screen. Trusting the model to
          // remember "try click_text next" as a separate step is exactly what failed in
          // practice; doing the fallback here means there's only one way to get it wrong instead
          // of two tool calls that both have to go right.
          const uiResult = uiAutomation.isSupported() ? await uiAutomation.locateElement(targetName) : null
          if (uiResult?.found && uiResult.centerX !== undefined && uiResult.centerY !== undefined) {
            await screenControl.clickMouse(uiResult.centerX, uiResult.centerY, button, double, speed)
            response = {
              status: 'SUCCESS',
              result: `Clicked "${uiResult.element?.name}" (${uiResult.element?.controlType}), found via accessibility data.`
            }
          } else {
            const ocrResult = await ocr.locateText(targetName)
            if (ocrResult.found && ocrResult.centerX !== undefined && ocrResult.centerY !== undefined) {
              await screenControl.clickMouse(ocrResult.centerX, ocrResult.centerY, button, double, speed)
              response = {
                status: 'SUCCESS',
                result: `Clicked "${ocrResult.line?.text}", found via OCR (no accessible name existed for this element).`
              }
            } else {
              response = {
                status: 'FAILED',
                error: `"${targetName}" wasn't found via accessibility data OR real OCR on the current screen. It genuinely isn't there right now, isn't visible, or is worded differently than you think — do NOT fall back to guessing a pixel coordinate for it. Either re-read the screen (find_elements/read_screen_text) and retry with a corrected name, or tell the user you can't find it.`,
                accessibilityCandidates: uiResult?.candidates ?? [],
                ocrCandidates: ocrResult.candidates ?? []
              }
            }
          }
        }
      } else if (fc.name === 'read_screen_text') {
        const lines = await ocr.readScreenText()
        response = {
          result: lines.length
            ? lines.map((l) => l.text).join('\n')
            : 'No text was recognized on screen right now.'
        }
      } else if (fc.name === 'click_text') {
        const targetText = String(args.text ?? '').trim()
        if (!targetText) {
          response = { error: 'No text given.' }
        } else {
          const located = await ocr.locateText(targetText)
          if (!located.found || located.centerX === undefined || located.centerY === undefined) {
            response = {
              status: 'FAILED',
              error: `OCR didn't find text matching "${targetText}" on screen right now.`,
              candidates: located.candidates ?? []
            }
          } else {
            await screenControl.clickMouse(
              located.centerX,
              located.centerY,
              (args.button as 'left' | 'right' | 'middle') ?? 'left',
              Boolean(args.double),
              (args.speed as 'instant' | 'visible') ?? 'visible'
            )
            response = { status: 'SUCCESS', result: `Clicked text "${located.line?.text}".` }
          }
        }
      } else if (fc.name === 'trace_pattern') {
        await screenControl.tracePattern(
          (args.pattern as screenControl.TracePattern) ?? 'circle',
          Number(args.x),
          Number(args.y),
          Number(args.size) || 120,
          Number(args.durationMs) || 1200
        )
        response = { result: `Traced a ${String(args.pattern ?? 'circle')}.` }
      } else if (fc.name === 'type_text') {
        screenControl.typeText(String(args.text ?? ''))
        response = { result: 'Typed.' }
      } else if (fc.name === 'press_key') {
        screenControl.pressKey(String(args.key ?? ''), (args.modifiers as string[]) ?? [])
        response = { result: 'Pressed.' }
      } else if (fc.name === 'scroll') {
        screenControl.scroll(Number(args.deltaX ?? 0), Number(args.deltaY ?? 0))
        response = { result: 'Scrolled.' }
      } else if (fc.name === 'start_autonomous_task') {
        const goal = String(args.goal ?? '').trim()
        if (!goal) {
          response = { error: 'No goal given.' }
        } else {
          autonomousTask.startAutonomousTask(goal)
          response = { result: `Started — I'll keep handling "${goal}" in the background.` }
        }
      } else if (fc.name === 'stop_autonomous_task') {
        autonomousTask.stopAutonomousTask('stopped by DALVE')
        response = { result: 'Stopped the background task.' }
      } else {
        response = { result: await composio.executeComposioTool(fc.name, args) }
      }
    } catch (err) {
      console.error(`[geminiLive] tool "${fc.name}" failed:`, err)
      response = { error: err instanceof Error ? err.message : String(err) }
    }

    functionResponses.push({ id: fc.id, name: fc.name, response })
  }

  session?.sendToolResponse({ functionResponses })
  emit({ type: 'toolActivity', active: false })
}

export function sendAudioChunk(base64Pcm16: string): void {
  session?.sendRealtimeInput({ audio: { data: base64Pcm16, mimeType: 'audio/pcm;rate=16000' } })
}

export function sendVideoFrame(base64Jpeg: string): void {
  session?.sendRealtimeInput({ video: { data: base64Jpeg, mimeType: 'image/jpeg' } })
}

export function sendText(text: string): void {
  session?.sendRealtimeInput({ text })
}

export function stopVoiceSession(): void {
  sessionEpoch++ // invalidate any in-flight connect/callbacks
  reconnectAttempts = 0
  resumptionHandle = null // deliberate stop — don't resume this conversation on the next start
  screenControl.stopAll()
  if (!session) return
  const closingAgent = activeAgentId ? agentStore.get(activeAgentId) : null
  flushJournalBuffers(closingAgent?.name ?? 'DALVE')
  session.close()
  session = null
  if (activeAgentId) {
    agentStore.setStatus(activeAgentId, 'idle')
    activeAgentId = null
  }
  emit({ type: 'state', state: 'idle' })
}
