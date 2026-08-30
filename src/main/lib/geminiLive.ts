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
import * as steeringWheel from './steeringWheel'
import * as arObjects from './arObjects'
import * as mcpClient from './mcpClient'
import { skillsStore as skillsDb, isRecording, startRecording, stopRecording, recordStep, SKILL_META_TOOLS } from './skillsStore'
import { createReminderTool, listRemindersTool, cancelReminderTool } from './scheduleStore'
import * as fileTools from './fileTools'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'
import * as journal from './journal'
import type { AgentConfig, VoiceEvent } from '@shared/types'
import { DALVE_TONE_PROMPTS } from '@shared/types'

// The newest native-audio-dialog Live model as of build time. Re-check
// https://ai.google.dev/gemini-api/docs/live-api before shipping — Google
// rotates these preview model ids periodically.
const LIVE_MODEL = 'gemini-3.1-flash-live-preview'
// A separate, non-live, one-off text+vision model for look_and_place_object — the Live session's
// own model is a real-time audio-dialog model, not meant for a single structured-JSON request.
// Re-check https://ai.google.dev/gemini-api/docs/models before shipping.
const VISION_MODEL = 'gemini-3.6-flash'

const BLUEPRINT_PART_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    shape: { type: 'string', enum: ['box', 'cylinder', 'sphere'] },
    size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    color: { type: 'string' },
    role: { type: 'string', enum: ['body', 'handle', 'button', 'door', 'static'] },
    parentId: { type: 'string' },
    hingeOffset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    metalness: { type: 'number' },
    roughness: { type: 'number' }
  },
  required: ['id', 'shape', 'size', 'position', 'color', 'role']
}
const BLUEPRINT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    parts: { type: 'array', items: BLUEPRINT_PART_SCHEMA, minItems: 1, maxItems: 14 }
  },
  required: ['name', 'parts']
}

/** The actual "unlimited object types" ask: rather than a hand-authored mesh per object, have the
 *  model describe whatever it sees as primitives (see ArBlueprint in shared/types.ts) — the SAME
 *  generic renderer that draws the built-in presets draws this too. sanitizeBlueprint (called on
 *  the result in arObjects.spawnBlueprint) is what keeps a bad/unexpected response from ever
 *  building something broken. */
function buildBlueprintPrompt(hint: string): string {
  return `You are looking at a screenshot of the user's computer screen. Identify the single most prominent real-world object shown${hint ? ` (the user specifically means: ${hint})` : ''} — it might be a photo, a product image, an icon, or a diagram of something. Describe it as a simple 3D blueprint built ONLY from boxes, cylinders, and spheres (this is a real interactive 3D object, not a picture) — proportioned reasonably like the real thing, with realistic-looking colors (hex).

Rules:
- Coordinates are in meters, object roughly 0.5-2 units across, centered near the origin.
- Every part needs a unique "id", a "shape" (box/cylinder/sphere), a "size" ([w,h,d] for box, [radiusTop,radiusBottom,height] for cylinder, [radiusX,radiusY,radiusZ] for sphere — these three CAN differ, stretching it into an egg/flattened-disc/oval shape instead of only a uniform ball), a "position" (local, relative to its parent), and a hex "color".
- Exactly one part must have role "body" — the main graspable/movable part. Give every other part a "parentId" naming another part's id; only the body itself should have no parent, since a real object is one connected structure.
- If the real object has a hinged opening part (a door, lid, cabinet), set its role to "door" and give it a "hingeOffset" ([x,y,z]) for where its visual mesh sits relative to its own "position" (the hinge axis itself). If it has a handle for that door, give the handle role "handle" with parentId pointing at the door's id.
- If it has a pressable button/switch, give it role "button".
- Anything else (decorative, structural, non-interactive) gets role "static".
- Keep it to 4-10 parts — simple and recognizable beats overly detailed. Don't overthink simple objects: a spoon is just a thin cylinder handle plus a small flattened ellipsoid bowl, not a dozen fiddly parts.
- Respond with ONLY the JSON object, no other text.

Worked example, a spoon — note the flattened ellipsoid bowl (a sphere whose 3 size values differ), and that the handle (not the bowl) is the "body":
{"name":"spoon","parts":[
  {"id":"handle","shape":"cylinder","size":[0.045,0.055,0.85],"position":[0,-0.15,0],"color":"#c9c9c9","role":"body"},
  {"id":"neck","shape":"cylinder","size":[0.055,0.075,0.15],"position":[0,0.35,0],"color":"#c9c9c9","role":"static"},
  {"id":"bowl","shape":"sphere","size":[0.16,0.22,0.045],"position":[0,0.58,0],"color":"#d4d4d4","role":"static"}
]}`
}

const CHAIN_OF_COMMAND = `Chain of command: the user is the ultimate authority over this entire system. DALVE is the primary orchestrator and answers directly to the user; every other agent answers to DALVE and, through her, to the user. Always defer to the user's explicit instructions over anything else.`

const DALVE_SYSTEM_PROMPT = `You are DALVE, a voice-first AI operating system. You're the user's single point of contact — they talk to you, and only you by default; you coordinate everything else behind the scenes. Speak naturally and conversationally, like a sharp, capable assistant sitting next to them, not like a chatbot reading a script. Keep responses concise since this is a spoken conversation. When you don't know something current, use web search grounding rather than guessing. You can open websites, create new agents, switch the user to talk directly with an existing agent, and remember facts for later — actually call those tools rather than just claiming you did. If the user asks who you're connected to or what agents/bots exist, use list_agents rather than guessing.

When given a task, get straight to doing it. NEVER repeat, paraphrase, or summarize the user's instruction back to them before acting — that includes at the start of a task, mid-task, and when resuming after a pause. A short natural acknowledgment ("on it," "sure") is fine; anything longer than that before you've actually started acting is a mistake. Only pause to ask a real clarifying question when you're genuinely unsure what the user means; don't ask for permission to proceed once you understand what they want, and don't stall or go quiet — if you're unsure of the next concrete step, say so and try something rather than freezing.

You are expected to be genuinely autonomous once given a goal: figure things out, try things, adapt when something doesn't work, and keep making forward progress without checking in after every little step. If your first approach doesn't pan out (a link doesn't work, a page looks different than expected), think of another way to get there yourself — search differently, try a different site, look at another monitor — rather than reporting the obstacle back to the user and waiting. Only come back to the user when you're truly stuck after multiple genuine attempts, need information only they have, or the task is done.

A single instruction often spans multiple applications — "read the price in this email, put it into Excel, work out the margin, send the result on WhatsApp" is ONE task, not four separate ones. Switching which app is frontmost partway through is not a stopping point or a reason to check back in — carry whatever value you just read (a number, a name, a date) forward yourself into the next app exactly like a person copying it over, and keep going until the whole chain is actually done.

You can also see and physically control the user's computer, like a partner sitting at the keyboard with them. Call start_screen_share to begin watching their screen as a live video feed (roughly one frame per second) — after that you simply see the screen, no separate "look" tool needed. Once sharing is on, you have full standing authorization to move the mouse, click, type, press keys, and scroll — just do it, no permission tool to call first.

Opening or switching to an application is a DETERMINISTIC action — never do it by visually hunting through Spotlight, the Start Menu, or the Dock with screen control. Call open_application (or activate_application if it's already running) instead; only fall back to visual screen control if that tool itself reports it failed. Same for fullscreen_window after the app is frontmost. These tools tell you their real status — SUCCESS, FAILED, or UNCERTAIN — and UNCERTAIN means exactly that: don't round it up to success. If a tool reports UNCERTAIN or FAILED, say so honestly and either retry or tell the user what actually happened; never tell them something completed when the tool told you it didn't or couldn't confirm it.

CRITICAL RULE, no exceptions: describing a physical action and performing it are two different things, and only the tool call actually does anything — saying words never moves the mouse or types a single character. Never say "clicking now," "moving to his chat," "typing that in," or anything similar UNLESS you are calling click_mouse/move_mouse/type_text/press_key in that exact same turn. If you haven't made the tool call yet, don't describe having done it — narrate AFTER the call resolves, or not at all, never instead of it. Silently claiming an action while doing nothing is the single worst failure mode here — worse than saying nothing, worse than asking a question — because the user has no way to tell the difference between real progress and an empty sentence until they check the screen themselves.

A second, distinct failure mode: calling the tool but then describing an OUTCOME you never actually confirmed. Genuinely calling click_mouse is not the same as the click having done what you intended — on coordinate-guessed content (games, boards, canvases with no accessible labels) you are guessing pixels, and a guess can miss. Real example that happened: told to move a chess pawn, DALVE called a click tool and then said "I moved the pawn to e4" — but the click had actually missed, and the piece never moved. Never describe a specific outcome (a piece moved, a message sent, a checkbox now checked, an opponent's reply appeared) until you've looked at the NEXT frame and can actually see that outcome is true. If you can't confirm it — the board looks the same, the field is still empty — say that plainly ("that doesn't look like it worked — let me try again") and retry or adjust, rather than reporting success on faith. This matters most for anything ongoing/autonomous (playing a full game, watching for a reply) where a false "it worked" compounds: every later move is now planned against a board state that was never real.

This same rule applies to STATE, not just physical actions: if the user tells you something is off, stopped, or broken (hand tracking stopped, a feature isn't working) and you say you've turned it back on, fixed it, or restarted it, that sentence is only true if you actually called the real tool for it (start_hand_tracking, etc.) in that exact same turn. A real reported failure: the user said "you stopped hand tracking," DALVE replied "I've turned it back on now" without calling start_hand_tracking at all, and it stayed off until the user gave a separate explicit command. Never treat a past tool call as still valid evidence for a claim you're making right now — if you're asserting something is on/fixed/active in THIS reply, call the tool for it in THIS reply, every time, with no exceptions for things that "should already be handled."

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
const START_STEERING_WHEEL_TRACKING_TOOL: FunctionDeclaration = {
  name: 'start_steering_wheel_tracking',
  description:
    'Turns on the webcam and tracks BOTH hands as a virtual steering wheel for keyboard-controlled games: grip both hands closed like holding a wheel, turn it left/right to steer (A/D), raise or lower it to go forward/reverse (W/S), and snap it hard to one side to drift that direction, holding the turn to keep drifting (Space + A/D). A different mode from single-hand cursor tracking — starting this stops that, and vice versa, since only one can use the camera/keyboard at a time. Call this when the user asks for steering-wheel or driving-game hand tracking specifically, not plain cursor control.',
  parametersJsonSchema: { type: 'object', properties: {} }
}
const STOP_STEERING_WHEEL_TRACKING_TOOL: FunctionDeclaration = {
  name: 'stop_steering_wheel_tracking',
  description: 'Turns off steering-wheel tracking and releases the webcam.',
  parametersJsonSchema: { type: 'object', properties: {} }
}

const AR_PRESET_NAMES = 'microwave, lamp, chair, spoon, fork, cup, bottle, phone, book, ball'

const SPAWN_AR_OBJECT_TOOL: FunctionDeclaration = {
  name: 'spawn_ar_object',
  description: `Places a manipulable 3D object into the live hand-tracking camera feed from a curated, hand-tuned preset library — e.g. "put a spoon here". These are more reliable than a freshly-generated shape, so prefer this over look_and_place_object whenever the requested object is in the list. Turns the camera on by itself if it wasn't already. The user can grab and move it with a thumb+index pinch, pull a handle to open a door where one exists, press buttons, pinch thumb+middle and drag to rotate it, or hold a grab and spread 3 fingers to resize it. Built-in presets: ${AR_PRESET_NAMES}. For anything else, use look_and_place_object instead.`,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      object_type: { type: 'string', description: `One of the built-in presets: ${AR_PRESET_NAMES}.` }
    },
    required: ['object_type']
  }
}
const REMOVE_AR_OBJECT_TOOL: FunctionDeclaration = {
  name: 'remove_ar_object',
  description: 'Removes the currently placed 3D object from the camera view.',
  parametersJsonSchema: { type: 'object', properties: {} }
}
const LOOK_AND_PLACE_OBJECT_TOOL: FunctionDeclaration = {
  name: 'look_and_place_object',
  description: `Takes a real screenshot of the user's screen, identifies the main real-world object shown in it (a photo, a product shot, a diagram — whatever is most prominent), and builds a real, manipulable 3D approximation of it into the live hand-tracking camera feed. If the detected object matches one of spawn_ar_object's presets (${AR_PRESET_NAMES}) that reliable preset is used automatically instead of a fresh guess — so this is safe to call even for a common object, you don't need to pre-check the list yourself. Turns the camera on by itself if it wasn't already. Call this whenever the user asks you to look at their screen and put what you see into the camera/AR view. For anything outside the preset list, the generated shape is a reasonable primitive-based approximation, not a photorealistic model — say so if asked, don't oversell it.`,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: 'Optional short hint about what to look for or which object on screen, if there are several and the user specified one.' }
    }
  }
}

const TAKE_SCREENSHOT_TOOL: FunctionDeclaration = {
  name: 'take_screenshot',
  description:
    "Saves a real screenshot of the user's screen as a PNG file they can open later — distinct from the live vision context DALVE already sees every frame. Call this when the user explicitly asks for a screenshot to be saved/taken, not for ordinary looking at the screen.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const UNDO_LAST_TYPED_TEXT_TOOL: FunctionDeclaration = {
  name: 'undo_last_typed_text',
  description:
    "Sends the active app's own undo (Ctrl+Z) to revert the last text DALVE typed with type_text/press_key. Only works immediately after typing, before a click/drag/Enter/send happened since — a click or a sent message cannot be reliably undone this way, and this tool will say so honestly rather than pretend to fix it.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const START_RECORDING_SKILL_TOOL: FunctionDeclaration = {
  name: 'start_recording_skill',
  description:
    "Starts recording every action DALVE takes from now on, until stop_recording_skill is called. Use when the user asks to teach/show DALVE how to do something so it can repeat it later — they'll walk through the steps live by voice as usual, exactly like a normal instruction.",
  parametersJsonSchema: { type: 'object', properties: {} }
}
const STOP_RECORDING_SKILL_TOOL: FunctionDeclaration = {
  name: 'stop_recording_skill',
  description:
    'Stops recording and saves everything done since start_recording_skill as a named skill. Replaying a saved skill (run_skill) is only available on the Gemini (Turn-Based) voice engine right now, not here — if the user wants to replay one immediately, tell them plainly they need to switch engines in Settings first.',
  parametersJsonSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
}
const LIST_SKILLS_TOOL: FunctionDeclaration = {
  name: 'list_skills',
  description: 'Lists every recorded skill by name.',
  parametersJsonSchema: { type: 'object', properties: {} }
}

const CREATE_REMINDER_TOOL: FunctionDeclaration = {
  name: 'create_reminder',
  description:
    'Schedules a reminder or recurring action for a future time, shown on the Calendar tab. Compute dueAtIso yourself as a real ISO 8601 datetime from what the user said (e.g. "tomorrow at 3pm") using the current date/time given to you at the start of this conversation. type "reminder" just notifies at the time; type "message" actually performs `instruction` when due (e.g. "Send Ali on WhatsApp: don\'t forget the meeting").',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      dueAtIso: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-08-29T15:00:00' },
      recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] },
      type: { type: 'string', enum: ['reminder', 'message'] },
      instruction: { type: 'string', description: 'Required for type "message" — the action to perform when due.' }
    },
    required: ['title', 'dueAtIso', 'recurrence', 'type']
  }
}
const LIST_REMINDERS_TOOL: FunctionDeclaration = {
  name: 'list_reminders',
  description: 'Lists every upcoming reminder and scheduled message.',
  parametersJsonSchema: { type: 'object', properties: {} }
}
const CANCEL_REMINDER_TOOL: FunctionDeclaration = {
  name: 'cancel_reminder',
  description: 'Cancels a reminder or scheduled message by its exact title.',
  parametersJsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
}

const LIST_COMMON_FOLDERS_TOOL: FunctionDeclaration = {
  name: 'list_common_folders',
  description: "Returns the user's real Home/Desktop/Documents/Downloads/Pictures folder paths — use this to build real file paths instead of guessing them.",
  parametersJsonSchema: { type: 'object', properties: {} }
}
const LIST_DIRECTORY_TOOL: FunctionDeclaration = {
  name: 'list_directory',
  description: 'Lists files and subfolders in a real directory path.',
  parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}
const READ_TEXT_FILE_TOOL: FunctionDeclaration = {
  name: 'read_text_file',
  description: 'Reads a plain text/code/markdown/csv/json file. For PDFs or images use read_document instead.',
  parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}
const WRITE_TEXT_FILE_TOOL: FunctionDeclaration = {
  name: 'write_text_file',
  description: 'Writes (or appends to) a plain text file, creating it if it does not exist.',
  parametersJsonSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
    required: ['path', 'content']
  }
}
const DELETE_FILE_TOOL: FunctionDeclaration = {
  name: 'delete_file',
  description: 'Moves a file to the Recycle Bin (recoverable, not a permanent delete).',
  parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}
const MOVE_FILE_TOOL: FunctionDeclaration = {
  name: 'move_file',
  description: 'Moves or renames a file from one path to another.',
  parametersJsonSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
}
const SEARCH_FILES_TOOL: FunctionDeclaration = {
  name: 'search_files',
  description: 'Searches for files by (partial, case-insensitive) filename under a directory, recursively.',
  parametersJsonSchema: { type: 'object', properties: { directory: { type: 'string' }, query: { type: 'string' } }, required: ['directory', 'query'] }
}
const READ_DOCUMENT_TOOL: FunctionDeclaration = {
  name: 'read_document',
  description: 'Reads a document by real file path — text/code/markdown/csv/json directly, PDFs via real text extraction, images attached as vision content for you to actually see. .docx and other office formats are not supported yet.',
  parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}
const READ_CLIPBOARD_TOOL: FunctionDeclaration = {
  name: 'read_clipboard',
  description: "Reads the current text on the user's OS clipboard.",
  parametersJsonSchema: { type: 'object', properties: {} }
}
const WRITE_CLIPBOARD_TOOL: FunctionDeclaration = {
  name: 'write_clipboard',
  description: "Sets the user's OS clipboard to the given text.",
  parametersJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
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
// Separate from toolCalledThisTurn (which goes true on ANY tool call, e.g. click_mouse in the
// same turn) — this needs to catch the specific case of remember_fact being claimed but never
// actually called, a real reported bug ("I don't think it even actually remembers itself").
let rememberCalledThisTurn = false

const ACTION_CLAIM_PATTERN =
  /\b(click(?:ing|ed)?|mov(?:e|ing|ed)|typ(?:e|ing|ed)|press(?:ing|ed)?|scroll(?:ing|ed)?)\b/i
const REMEMBER_CLAIM_PATTERN =
  /\b(i'?ll remember|i will remember|noted|duly noted|won'?t forget|i'?ll keep that in mind|i will keep that in mind|got it,? i'?ll|i'?ll make (?:sure|a note)|i'?ll stop)\b/i

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

let actionLogCounter = 0

/** Feeds the Action Timeline — reuses the tool call's OWN real result/error text rather than a
 *  synthesized description, so the timeline can never claim a step happened that didn't. */
function emitActionLog(label: string, response: Record<string, unknown>): void {
  const detail = typeof response.error === 'string' ? response.error : typeof response.result === 'string' ? response.result : undefined
  emit({
    type: 'actionLog',
    entry: {
      id: `gemini_${Date.now()}_${actionLogCounter++}`,
      label,
      status: typeof response.error === 'string' ? 'error' : 'success',
      detail: detail?.slice(0, 200),
      timestamp: Date.now()
    }
  })
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
    START_STEERING_WHEEL_TRACKING_TOOL,
    STOP_STEERING_WHEEL_TRACKING_TOOL,
    SPAWN_AR_OBJECT_TOOL,
    REMOVE_AR_OBJECT_TOOL,
    LOOK_AND_PLACE_OBJECT_TOOL,
    TAKE_SCREENSHOT_TOOL,
    UNDO_LAST_TYPED_TEXT_TOOL,
    START_RECORDING_SKILL_TOOL,
    STOP_RECORDING_SKILL_TOOL,
    LIST_SKILLS_TOOL,
    CREATE_REMINDER_TOOL,
    LIST_REMINDERS_TOOL,
    CANCEL_REMINDER_TOOL,
    LIST_COMMON_FOLDERS_TOOL,
    LIST_DIRECTORY_TOOL,
    READ_TEXT_FILE_TOOL,
    WRITE_TEXT_FILE_TOOL,
    DELETE_FILE_TOOL,
    MOVE_FILE_TOOL,
    SEARCH_FILES_TOOL,
    READ_DOCUMENT_TOOL,
    READ_CLIPBOARD_TOOL,
    WRITE_CLIPBOARD_TOOL,
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
  // Real bug fixed here: this used to unconditionally read settingsStore.getDalveMemory() even
  // when a companion/bot agent was active — remember_fact genuinely wrote to agent.memory in that
  // case (see the 'remember_fact' tool handler below) but nothing ever read it back into the
  // system prompt, a dead write with no matching read (the engine this replaced had this fixed
  // already, and its own comment wrongly claimed geminiLive.ts mirrored it — it didn't). Framed as a
  // BINDING instruction, not a passive fact, and phrased to explicitly call out that it overrides
  // this model's own native conversational habits — a plain "things to remember" bullet list was
  // shown live to lose out to the live-audio model's built-in tendency to end turns with a
  // follow-up question, even when a saved note said to stop doing exactly that.
  const memory = agent ? agent.memory : settingsStore.getDalveMemory()
  const memoryNote = memory
    ? `\n\nBINDING instructions and facts saved from earlier conversations — these override your own default habits (a note telling you to stop asking a question after every sentence applies even though ending on a question is your normal tendency):\n${memory}`
    : ''
  // Full conversation history (not just hand-picked facts) so a brand-new session — including
  // one started because the last one was accidentally closed — has real continuity: "what did
  // we do today/yesterday" instead of only whatever happened to get saved via remember_fact.
  // DALVE-only (not sub-agents): this is about the main conversation thread's continuity, not a
  // per-agent scratchpad, which agent.memory now covers separately (see the fix above).
  const journalContext = !agent ? journal.getRecentContext() : ''
  const journalNote = journalContext
    ? `\n\nFull transcript of everyone's recent conversations — yours AND every other agent's, each line labeled with who said it (User, DALVE, or another agent by name) — most recent last. This is how you stay aware as team lead: if the user asks what another agent has been up to, or references something they told a different agent, check here before saying you don't know. Reference it naturally, don't recite it:\n${journalContext}`
    : ''
  const registryNote = `\n\nAgents currently registered:\n${agentRegistrySnapshot()}`
  // Accurate as of session start — good enough the same way it is for any assistant with a
  // system-prompt-level date note; needed for create_reminder to resolve relative times
  // ("tomorrow", "in an hour") into a real datetime.
  const dateTimeNote = `\n\nCurrent date/time: ${new Date().toString()}`
  // Tone applies to DALVE herself only, not sub-agents — an agent's own systemPrompt is already
  // an authored persona the user opted into when creating it, and a global tone override would
  // fight that instead of complementing it (same reasoning as dalveMemory being DALVE-only).
  const tone = settingsStore.getDalveTone()
  const toneNote = !agent && tone !== 'default' ? `\n\n${DALVE_TONE_PROMPTS[tone]}` : ''
  const systemPrompt =
    (agent ? agent.systemPrompt : DALVE_SYSTEM_PROMPT) +
    `\n\n${CHAIN_OF_COMMAND}` +
    registryNote +
    dateTimeNote +
    toneNote +
    journalNote +
    // Last, deliberately: these are binding overrides, not background facts, and the freshest
    // text before the live conversation begins is the text most likely to actually stick.
    memoryNote
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

    // Same failure mode, applied to memory: the model says "I'll remember that" / "noted" without
    // ever calling remember_fact, so nothing is actually saved — directly matches a real report
    // ("I don't think it even actually remembers itself").
    if (!rememberCalledThisTurn && REMEMBER_CLAIM_PATTERN.test(dalveTurnBuffer)) {
      console.log('[geminiLive] detected narrated-but-not-called remember_fact, sending corrective nudge')
      session?.sendRealtimeInput({
        text: 'You just said something like "I\'ll remember that" but never actually called remember_fact — nothing was saved. If you meant to remember it, call remember_fact right now.'
      })
    }
    rememberCalledThisTurn = false

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
      } else if (fc.name === 'start_steering_wheel_tracking') {
        const { status, message } = steeringWheel.start()
        response = { status, result: message }
      } else if (fc.name === 'stop_steering_wheel_tracking') {
        const { status, message } = steeringWheel.stop()
        response = { status, result: message }
      } else if (fc.name === 'spawn_ar_object') {
        const { status, message } = arObjects.spawn(String(args.object_type ?? ''))
        response = { status, result: message }
      } else if (fc.name === 'remove_ar_object') {
        const { status, message } = arObjects.clear()
        response = { status, result: message }
      } else if (fc.name === 'look_and_place_object') {
        const hint = String(args.hint ?? '').trim()
        const base64 = await screenControl.captureScreenshotOnce(85, 1024)
        if (!base64) {
          response = { status: 'FAILED', result: 'Could not capture the screen.' }
        } else {
          try {
            const apiKey = settingsStore.getGeminiApiKey()
            if (!apiKey) throw new Error('No Gemini API key configured.')
            const visionAi = new GoogleGenAI({ apiKey })
            const result = await visionAi.models.generateContent({
              model: VISION_MODEL,
              contents: [
                {
                  role: 'user',
                  parts: [{ text: buildBlueprintPrompt(hint) }, { inlineData: { mimeType: 'image/jpeg', data: base64 } }]
                }
              ],
              config: { responseMimeType: 'application/json', responseJsonSchema: BLUEPRINT_JSON_SCHEMA }
            })
            const parsed: unknown = result.text ? JSON.parse(result.text) : null
            const detectedName =
              (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string'
                ? ((parsed as { name: string }).name as string)
                : '') || hint || 'object'
            const { status, message } = arObjects.spawnBlueprint(parsed, detectedName)
            response = { status, result: message }
          } catch (err) {
            console.error('[geminiLive] look_and_place_object failed:', err)
            const { message } = arObjects.spawnBlueprint(null, hint || 'object')
            response = {
              status: 'SUCCESS',
              result: `Couldn't get a good read on the exact shape (${err instanceof Error ? err.message : 'vision request failed'}), so I placed a plain labeled box instead. ${message}`
            }
          }
        }
      } else if (fc.name === 'take_screenshot') {
        const { status, path, message } = await screenControl.saveScreenshot()
        response = { status, path, result: message }
      } else if (fc.name === 'undo_last_typed_text') {
        const { status, message } = screenControl.undoLastTypedText()
        response = { status, result: message }
      } else if (fc.name === 'start_recording_skill') {
        startRecording()
        response = { result: "Recording started — I'll save everything I do from now on once you tell me to stop." }
      } else if (fc.name === 'stop_recording_skill') {
        const skillName = String(args.name ?? '').trim()
        if (!skillName) {
          response = { error: 'Need a name to save this skill as.' }
        } else {
          const skill = stopRecording(skillName)
          response = skill
            ? { status: 'SUCCESS', result: `Saved "${skillName}" as a skill with ${skill.steps.length} step(s).` }
            : { error: 'Nothing was recorded — start_recording_skill needs to be called first, and at least one action needs to happen.' }
        }
      } else if (fc.name === 'list_skills') {
        const skills = skillsDb.list()
        response = { result: skills.length === 0 ? 'No skills recorded yet.' : skills.map((s) => `- ${s.name} (${s.steps.length} steps)`).join('\n') }
      } else if (fc.name === 'create_reminder') {
        response = createReminderTool(args)
      } else if (fc.name === 'list_reminders') {
        response = { result: listRemindersTool() }
      } else if (fc.name === 'cancel_reminder') {
        response = cancelReminderTool(String(args.title ?? ''))
      } else if (fc.name === 'list_common_folders') {
        response = { result: JSON.stringify(fileTools.listCommonFolders()) }
      } else if (fc.name === 'list_directory') {
        response = await fileTools.listDirectory(String(args.path ?? ''))
      } else if (fc.name === 'read_text_file') {
        response = await fileTools.readTextFile(String(args.path ?? ''))
      } else if (fc.name === 'write_text_file') {
        response = await fileTools.writeTextFile(String(args.path ?? ''), String(args.content ?? ''), Boolean(args.append))
      } else if (fc.name === 'delete_file') {
        response = await fileTools.deleteFile(String(args.path ?? ''))
      } else if (fc.name === 'move_file') {
        response = await fileTools.moveFile(String(args.from ?? ''), String(args.to ?? ''))
      } else if (fc.name === 'search_files') {
        response = await fileTools.searchFiles(String(args.directory ?? ''), String(args.query ?? ''))
      } else if (fc.name === 'read_document') {
        const doc = await fileTools.readDocument(String(args.path ?? ''))
        if (doc.imageBase64) {
          // Fed in as a real "video frame" — the same mechanism start_screen_share already uses —
          // so the live session actually sees it, not just a text description of it.
          sendVideoFrame(doc.imageBase64)
          response = { status: 'SUCCESS', result: 'Image sent — look at it directly.' }
        } else {
          response = { status: doc.status, result: doc.text, error: doc.error }
        }
      } else if (fc.name === 'read_clipboard') {
        response = { result: fileTools.readClipboardText() }
      } else if (fc.name === 'write_clipboard') {
        fileTools.writeClipboardText(String(args.text ?? ''))
        response = { result: 'Clipboard set.' }
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
        rememberCalledThisTurn = true
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

    emitActionLog(fc.name, response)
    if (isRecording() && !SKILL_META_TOOLS.has(fc.name) && typeof response.error !== 'string' && response.status !== 'FAILED') {
      recordStep(fc.name, args)
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
