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
import * as windowLayout from './windowLayout'
import * as priceAxis from './priceAxis'
import * as handTracking from './handTracking'
import * as mcpClient from './mcpClient'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
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

A second, distinct failure mode: calling the tool but then describing an OUTCOME you never actually confirmed. Genuinely calling click_mouse is not the same as the click having done what you intended — on coordinate-guessed content (games, boards, canvases with no accessible labels) you are guessing pixels, and a guess can miss. Real example that happened: told to move a chess pawn, DALVE called a click tool and then said "I moved the pawn to e4" — but the click had actually missed, and the piece never moved. Never describe a specific outcome (a piece moved, a message sent, a checkbox now checked, an opponent's reply appeared) until you've looked at the NEXT frame and can actually see that outcome is true. If you can't confirm it — the board looks the same, the field is still empty — say that plainly ("that doesn't look like it worked — let me try again") and retry or adjust, rather than reporting success on faith. This matters most for anything ongoing/autonomous (playing a full game, watching for a reply) where a false "it worked" compounds: every later move is now planned against a board state that was never real.

The only hard limit: never type a password, payment card number, or other credential yourself — ask the user to enter sensitive fields themselves. Everything else — including sending a message you were asked to send (WhatsApp, text, email, any chat) — is NOT a hard limit and needs no confirmation. A real reported failure: told to message a friend, DALVE typed the message and then stopped to ask "should I send this?" instead of just sending it — that is exactly the over-cautious pause this prompt tells you not to do. Once you've typed what the user asked you to send, send it (press Enter or click Send) in the same turn, then confirm from the next frame that it actually went — don't pause mid-task to ask permission for the very thing you were already told to do.

Screen sharing only ever watches the user's main/primary monitor — if something they mention isn't visible there, it may be on a different monitor you can't see; say so rather than guessing or clicking blind.

Real targeting priority, strongest to weakest — always prefer the strongest one that applies: (1) A direct integration tool (Composio/MCP) if one exists for what's being asked — check before touching any UI at all. (2) browser_open + browser_click/browser_type/browser_read_text for ANYTHING that's a website — WhatsApp Web, any web app. This is real DOM lookup by actual text/label, running in DALVE's own dedicated automation browser; it cannot ever accidentally click the browser's own toolbar/tabs/profile button, because that browser has none visible and the tool has no way to address them even if it did — confirmed root cause of a real repeated mistake (clicking Chrome's own account button because it happened to share a name with the real target) that this structurally can't reproduce. (3) click_element for native desktop apps with a visible label — reads the OS accessibility tree, falls back to OCR internally, no need to chain tools yourself. (4) click_mouse/move_mouse from the video feed — last resort, for genuinely non-textual, non-web content only (a game, a drawing canvas, a map). If click_element ever errors outright on macOS, the most likely cause is DALVE not yet having Accessibility permission granted in System Settings — say so plainly.

For grid/board content specifically — chess/checkers boards, sudoku, spreadsheets, calendars, minesweeper, anything laid out as uniform rows/columns — go straight to define_grid + click_grid_cell rather than trying click_element or click_text first. Confirmed via real testing: a chess board's squares and pieces are pure graphics with zero accessible name and zero readable text, so those tools will just fail there every time and waste a step. Call define_grid ONCE per game/session with your best visual estimate of the whole grid's outer boundary (a big, forgiving target), then click_grid_cell for every individual move after that — it computes the exact position mathematically instead of you re-guessing a small target from scratch each time. If a click still lands wrong, call define_grid again with a corrected boundary rather than continuing to guess with the same one. Many drag-to-move interfaces (chess/checkers pieces especially) don't respond to two separate clicks at all — if a piece doesn't visibly move after clicking its square then the destination, that's the signal to try drag_mouse (piece's cell center to destination cell center) instead of repeating the same click sequence. Genuinely non-textual, non-grid content with no label at all (a drawing canvas, a map, a free-form game) is the actual last resort for click_mouse/move_mouse.

For anything involving an EXACT PRICE on a trading chart (TradingView etc.) — placing a stop/limit order at a specific price, setting a take-profit or stop-loss level, right-clicking at a price to bring up an order menu — always use click_price_level, never click_mouse. A trading chart's price scale is not something you can read a pixel position from by eye; confirmed via a real failed trade that guessing a coordinate for "$20 below entry" landed the order at the wrong price entirely. click_price_level reads the chart's own price scale and calibrates the exact pixel for you — you only ever need to give it the actual price number.

Clicking the wrong thing (e.g. the wrong contact in a chat list, the wrong item in a similar-looking row) is the single most common way you fail at this — the video feed is compressed and small text is easy to misread, so never click from a single glance when you're relying on pixel coordinates. Before a coordinate-based click where similar-looking rows could be confused, quickly move_mouse there first — that's free — and confirm in the next frame that the cursor actually landed on the right element before you click_mouse; skip this check when using click_element (it's already precise) or when the target is obvious and unambiguous. If a click turns out to have hit the wrong thing, say so immediately and correct it rather than continuing as if it worked. When a task spans multiple turns (e.g. "keep this conversation going without me"), re-check the screen state at the start of each new step rather than assuming it still matches what you last saw — things move, replies arrive, windows change focus.

Narrate briefly what you're doing as you go, in a sentence or two — not a blow-by-blow of every click, and never a restatement of the goal. Call stop_screen_share when you're done or if asked to stop.

IMPORTANT structural limit to understand about yourself: watching the screen live (start_screen_share) only ever lets you REACT — to something the user just said, or mid-tool-call-loop. Getting a passive video frame with a new WhatsApp message sitting in it does NOT by itself make you take a turn and act; nothing "wakes you up" just because the picture changed while nobody is talking to you. That is exactly why start_autonomous_task exists — it's a separate loop that actively re-checks the screen on its own timer and can act with nobody present. Whenever what's being asked amounts to "keep doing this without me watching/talking to you" — monitoring a chat (WhatsApp especially) and replying to new messages as they come in is the single most common real case — you MUST call start_autonomous_task, every time, not just when the user's exact wording matches an example. Trying to "just keep an eye on it" during the current live session instead is the concrete, previously-reported failure mode ("keeps relying on me to tell it to reply") — it silently doesn't work, because nothing will prompt you to look again once the user stops talking. Give it a clear one-sentence goal; it checks the screen every ~20 seconds and keeps going indefinitely until it decides the goal is complete, until the user stops it from the app, or until you call stop_autonomous_task. Only start one for something the user actually asked to be handled unattended — never on your own initiative — and still never enter passwords or payment details even in this mode.`

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

const OPEN_TRADING_SETUP_TOOL: FunctionDeclaration = {
  name: 'open_trading_setup',
  description:
    'Sets up the user\'s trading workspace across monitors: opens and maximizes the TradingView desktop app on the main monitor, and opens Discord (top 80%) and Tradovate (bottom 20%) as separate windows snapped to the secondary monitor. Call this when the user asks to open/start their trading setup, trading layout, or similar (e.g. "open trading setup", "set up my trading workspace"). Windows only.',
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

const DRAG_MOUSE_TOOL: FunctionDeclaration = {
  name: 'drag_mouse',
  description:
    'A real press-move-release drag gesture — not two separate clicks. Use this for anything that only responds to an actual held-mouse-button drag: a chess/checkers piece, a slider, a reorderable list item, a selection rectangle. Two click_mouse calls will NOT move a chess piece on a site that requires a real drag.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fromX: { type: 'number', description: 'Starting X pixel coordinate (where you press down).' },
      fromY: { type: 'number', description: 'Starting Y pixel coordinate.' },
      toX: { type: 'number', description: 'Ending X pixel coordinate (where you release).' },
      toY: { type: 'number', description: 'Ending Y pixel coordinate.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['fromX', 'fromY', 'toX', 'toY']
  }
}

const CLICK_PRICE_LEVEL_TOOL: FunctionDeclaration = {
  name: 'click_price_level',
  description:
    "Clicks or right-clicks at an EXACT price on a financial trading chart (TradingView etc.) — reads the chart's own right-side price scale via OCR and mathematically calibrates price-to-pixel, instead of guessing a coordinate from the screenshot. ALWAYS use this instead of click_mouse for anything involving a specific price (placing a stop order at a price, setting a take-profit/stop-loss level) — a guessed coordinate has repeatedly landed at the wrong price. Requires the chart's price scale to be visible on screen with at least 2 readable price labels.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      price: { type: 'number', description: 'The exact price to click at, e.g. 29562.00' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Defaults to left. Use right for a context menu (e.g. to place a stop order).' },
      x: { type: 'number', description: 'Optional X pixel coordinate within the chart body. Defaults to a safe position left of the price scale.' }
    },
    required: ['price']
  }
}

const START_HAND_TRACKING_TOOL: FunctionDeclaration = {
  name: 'start_hand_tracking',
  description:
    "Turns on the webcam and starts tracking the user's hand as a real cursor: the index fingertip's position moves the OS cursor, and pinching the thumb and index finger together clicks. Call this when the user asks to control the cursor/computer with their hand, turn on the webcam for hand control, or similar. Windows/Mac only (needs a webcam) — say so plainly if there's no camera available.",
  parametersJsonSchema: { type: 'object', properties: {} }
}
const STOP_HAND_TRACKING_TOOL: FunctionDeclaration = {
  name: 'stop_hand_tracking',
  description: 'Turns off hand tracking and releases the webcam.',
  parametersJsonSchema: { type: 'object', properties: {} }
}

const TAKE_SCREENSHOT_TOOL: FunctionDeclaration = {
  name: 'take_screenshot',
  description:
    "Saves a real screenshot of the user's screen as a PNG file they can open later — distinct from the live vision context DALVE already sees every frame. Call this when the user explicitly asks for a screenshot to be saved/taken, not for ordinary looking at the screen.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const BROWSER_OPEN_TOOL: FunctionDeclaration = {
  name: 'browser_open',
  description:
    "Opens a URL in DALVE's OWN dedicated automation browser window — separate from screen sharing and from the user's regular browser. STRONGLY PREFER this over open_url/screen control for any site where you'll need to click things or read content (WhatsApp Web, any web app) — everything done in this browser after opening is real DOM-level control (browser_click/browser_type/browser_read_text), not coordinate guessing, and it's structurally immune to the 'clicked the browser's own toolbar instead of the page' class of mistake since this browser has no visible toolbar/tabs/profile button for it to ever click by accident. Logins persist across launches — the first time on a given site (e.g. WhatsApp Web's QR code) needs the user to actually do that once in this window; after that it stays signed in.",
  parametersJsonSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL, including https://' } },
    required: ['url']
  }
}

const BROWSER_CLICK_TOOL: FunctionDeclaration = {
  name: 'browser_click',
  description:
    "Clicks a real element in DALVE's automation browser by its actual visible text/label/role (e.g. \"Ali\", \"Send\", \"Search\") — a genuine DOM lookup, not a coordinate guess. If multiple things match, this reports that back explicitly rather than picking one blind — read the response and be more specific rather than repeating the same query.",
  parametersJsonSchema: {
    type: 'object',
    properties: { description: { type: 'string', description: 'The visible text/label of what to click.' } },
    required: ['description']
  }
}

const BROWSER_TYPE_TOOL: FunctionDeclaration = {
  name: 'browser_type',
  description: 'Clicks a field by its label/placeholder (e.g. "Search or start a new chat", "Type a message") then types into it — so it actually has focus first, same as the OS-level tools.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fieldDescription: { type: 'string', description: 'The field\'s visible label or placeholder text.' },
      text: { type: 'string' },
      pressEnter: { type: 'boolean', description: 'Press Enter after typing, e.g. to send a message.' }
    },
    required: ['fieldDescription', 'text']
  }
}

const BROWSER_READ_TEXT_TOOL: FunctionDeclaration = {
  name: 'browser_read_text',
  description: "Returns the real visible text of the current page in DALVE's automation browser — actual DOM content, not OCR. Use this to check what's really on the page (e.g. did a message actually appear, what conversations are listed) before deciding the next action.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const BROWSER_PRESS_KEY_TOOL: FunctionDeclaration = {
  name: 'browser_press_key',
  description: "Presses a key in DALVE's automation browser (e.g. \"Enter\", \"Escape\").",
  parametersJsonSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
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

const DEFINE_GRID_TOOL: FunctionDeclaration = {
  name: 'define_grid',
  description:
    "Registers the pixel boundary of a grid/board on screen (chess/checkers board, sudoku, spreadsheet, calendar, minesweeper — anything laid out as uniform rows/columns with no accessible labels and no readable text for click_element/click_text to find). Look at the video feed and estimate the FOUR OUTER EDGES of the whole grid as a single rectangle — that's a large, forgiving target, much easier to get right than guessing one small cell directly. After this, use click_grid_cell to click any individual cell by row/column with exact computed math instead of a fresh guess every time. Call this again any time the grid moves, resizes, or you get a cell wrong and want to recalibrate.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'A short name for this grid, e.g. "chessboard". Reused in click_grid_cell.' },
      x: { type: 'number', description: 'Left edge of the grid, pixels.' },
      y: { type: 'number', description: 'Top edge of the grid, pixels.' },
      width: { type: 'number', description: 'Total width of the grid, pixels.' },
      height: { type: 'number', description: 'Total height of the grid, pixels.' },
      rows: { type: 'number', description: 'Number of rows, e.g. 8 for a chess board.' },
      cols: { type: 'number', description: 'Number of columns, e.g. 8 for a chess board.' }
    },
    required: ['label', 'x', 'y', 'width', 'height', 'rows', 'cols']
  }
}

const CLICK_GRID_CELL_TOOL: FunctionDeclaration = {
  name: 'click_grid_cell',
  description:
    "Clicks one exact cell of a previously-defined grid (see define_grid) — the position is computed mathematically from the grid's boundary, not guessed fresh. row/col are 0-indexed from the TOP-LEFT of the grid AS YOU CURRENTLY SEE IT on screen (if a chess board is flipped so Black is at the bottom, row 0 is still whatever's visually on top right now, not a fixed rank number — work out the mapping from what you actually see each time, since orientation can change).",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'The grid name used in define_grid.' },
      row: { type: 'number', description: '0-indexed row, top = 0.' },
      col: { type: 'number', description: '0-indexed column, left = 0.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      speed: SPEED_PARAM_SCHEMA
    },
    required: ['label', 'row', 'col']
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
    OPEN_TRADING_SETUP_TOOL,
    START_HAND_TRACKING_TOOL,
    STOP_HAND_TRACKING_TOOL,
    TAKE_SCREENSHOT_TOOL,
    LIST_AGENTS_TOOL,
    SWITCH_AGENT_TOOL,
    REMEMBER_FACT_TOOL,
    START_SCREEN_SHARE_TOOL,
    STOP_SCREEN_SHARE_TOOL,
    MOVE_MOUSE_TOOL,
    CLICK_MOUSE_TOOL,
    DRAG_MOUSE_TOOL,
    CLICK_PRICE_LEVEL_TOOL,
    BROWSER_OPEN_TOOL,
    BROWSER_CLICK_TOOL,
    BROWSER_TYPE_TOOL,
    BROWSER_READ_TEXT_TOOL,
    BROWSER_PRESS_KEY_TOOL,
    FIND_ELEMENTS_TOOL,
    CLICK_ELEMENT_TOOL,
    READ_SCREEN_TEXT_TOOL,
    CLICK_TEXT_TOOL,
    DEFINE_GRID_TOOL,
    CLICK_GRID_CELL_TOOL,
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

  functionDeclarations.push(...mcpClient.listToolDeclarations())

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
    // A grid defined for a previous conversation's board/spreadsheet/etc. has no business
    // surviving into an unrelated new one — genuine reconnects (same conversation, dropped
    // connection) should keep it, since the same grid is still on screen.
    gridTargeting.clearGrids()
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
      } else if (fc.name === 'open_trading_setup') {
        const { status, message } = await windowLayout.openTradingSetup()
        response = { status, result: message }
      } else if (fc.name === 'start_hand_tracking') {
        const { status, message } = handTracking.start()
        response = { status, result: message }
      } else if (fc.name === 'stop_hand_tracking') {
        const { status, message } = handTracking.stop()
        response = { status, result: message }
      } else if (fc.name === 'take_screenshot') {
        const { status, path, message } = await screenControl.saveScreenshot()
        response = { status, path, result: message }
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
      } else if (fc.name === 'drag_mouse') {
        await screenControl.dragMouse(
          Number(args.fromX),
          Number(args.fromY),
          Number(args.toX),
          Number(args.toY),
          (args.speed as 'instant' | 'visible') ?? 'visible'
        )
        response = { result: 'Dragged.' }
      } else if (fc.name === 'click_price_level') {
        const price = Number(args.price)
        const located = await priceAxis.locatePriceY(price)
        if (!located.found || located.y === undefined) {
          response = { status: 'FAILED', error: located.error ?? `Could not locate price ${price} on screen.` }
        } else {
          const frame = screenControl.getFrameSize()
          const targetX = args.x !== undefined ? Number(args.x) : Math.round(frame.width * 0.6)
          await screenControl.clickMouse(
            targetX,
            located.y,
            (args.button as 'left' | 'right') ?? 'left',
            false,
            'visible'
          )
          response = { status: 'SUCCESS', result: `Clicked at price ${price} (y=${located.y}, calibrated from ${located.samples} price labels).` }
        }
      } else if (fc.name === 'browser_open') {
        const info = await browserControl.openUrl(String(args.url ?? ''))
        response = { result: `Opened. title="${info.title}" url=${info.url}` }
      } else if (fc.name === 'browser_click') {
        response = await browserControl.clickByDescription(String(args.description ?? ''))
      } else if (fc.name === 'browser_type') {
        response = await browserControl.typeIntoField(
          String(args.fieldDescription ?? ''),
          String(args.text ?? ''),
          Boolean(args.pressEnter)
        )
      } else if (fc.name === 'browser_read_text') {
        response = { result: await browserControl.getVisibleText() }
      } else if (fc.name === 'browser_press_key') {
        await browserControl.pressKey(String(args.key ?? ''))
        response = { result: 'Pressed.' }
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
            const ambiguityNote = uiResult.ambiguousMatchCount
              ? ` NOTE: ${uiResult.ambiguousMatchCount} other element(s) on screen also matched "${targetName}" — if this wasn't the one the user meant (e.g. they described its color, size, or position), call find_elements to see the exact distinct names and retry with the more specific one instead of repeating the same generic word.`
              : ''
            response = {
              status: 'SUCCESS',
              result: `Clicked "${uiResult.element?.name}" (${uiResult.element?.controlType}), found via accessibility data.${ambiguityNote}`
            }
          } else {
            const ocrResult = await ocr.locateText(targetName)
            if (ocrResult.found && ocrResult.centerX !== undefined && ocrResult.centerY !== undefined) {
              await screenControl.clickMouse(ocrResult.centerX, ocrResult.centerY, button, double, speed)
              const ambiguityNote = ocrResult.ambiguousMatchCount
                ? ` NOTE: ${ocrResult.ambiguousMatchCount} other occurrence(s) of "${targetName}" were also visible on screen — if this wasn't the one the user meant, call read_screen_text to see everything actually on screen and retry with more specific wording (e.g. its exact full label, not just this one word).`
                : ''
              response = {
                status: 'SUCCESS',
                result: `Clicked "${ocrResult.line?.text}", found via OCR (no accessible name existed for this element).${ambiguityNote}`
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
      } else if (fc.name === 'define_grid') {
        const label = String(args.label ?? '').trim()
        if (!label) {
          response = { error: 'No label given.' }
        } else {
          gridTargeting.defineGrid(label, {
            x: Number(args.x),
            y: Number(args.y),
            width: Number(args.width),
            height: Number(args.height),
            rows: Math.max(1, Math.round(Number(args.rows))),
            cols: Math.max(1, Math.round(Number(args.cols)))
          })
          response = { result: `Registered grid "${label}" — use click_grid_cell to click cells by row/col from now on.` }
        }
      } else if (fc.name === 'click_grid_cell') {
        const label = String(args.label ?? '').trim()
        const cell = gridTargeting.cellCenter(label, Math.round(Number(args.row)), Math.round(Number(args.col)))
        if (!cell.found || cell.centerX === undefined || cell.centerY === undefined) {
          response = { status: 'FAILED', error: cell.error ?? 'Cell not found.' }
        } else {
          await screenControl.clickMouse(
            cell.centerX,
            cell.centerY,
            (args.button as 'left' | 'right' | 'middle') ?? 'left',
            Boolean(args.double),
            (args.speed as 'instant' | 'visible') ?? 'visible'
          )
          response = {
            status: 'SUCCESS',
            result: `Clicked row ${args.row}, col ${args.col} of "${label}". Remember: check the next frame to confirm this actually did what you expected before describing the outcome — a computed position still lands wrong if the grid boundary itself was defined slightly off.`
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
      } else if (mcpClient.isMcpTool(fc.name)) {
        response = await mcpClient.callMcpTool(fc.name, args)
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
