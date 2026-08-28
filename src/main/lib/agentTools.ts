import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import * as screenControl from './screenControl'
import * as uiAutomation from './uiAutomation'
import * as ocr from './ocr'
import * as gridTargeting from './gridTargeting'
import * as browserControl from './browserControl'

/**
 * The screen/browser/desktop tool set shared by every Claude-driven agent loop in DALVE
 * (autonomousTask.ts's recurring background checks, telegramBridge.ts's one-shot remote
 * commands) — one real, tested implementation instead of near-duplicate copies that would
 * silently drift apart. Real targeting priority, strongest to weakest, matches the hierarchy
 * given to the live Gemini voice session in geminiLive.ts.
 */
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
const UNDO_LAST_TYPED_TEXT_TOOL: Tool = {
  name: 'undo_last_typed_text',
  description:
    "Sends the active app's own undo (Ctrl+Z) to revert the last text DALVE typed with type_text/press_key. Only works immediately after typing, before a click/drag/Enter/send happened since — a click or a sent message cannot be reliably undone this way, and this tool will say so honestly rather than pretend to fix it.",
  input_schema: { type: 'object', properties: {} }
}

/** The physical/browser action tools every agent loop shares. Control-flow tools (when to stop,
 *  how to report completion) differ per caller and are added on top of this by each one. */
export const SHARED_TOOLS: Tool[] = [
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
  UNDO_LAST_TYPED_TEXT_TOOL
]

/** Actions that are supposed to visibly change the page — worth a real before/after check rather
 *  than trusting "the click ran" as proof it worked (see VERIFIABLE_ACTIONS usage in callers). */
export const VERIFIABLE_ACTIONS = new Set(['browser_click', 'browser_type', 'click_element', 'click_mouse', 'click_grid_cell', 'drag_mouse', 'type_text', 'press_key'])

export async function executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    case 'undo_last_typed_text': {
      const { status, message } = screenControl.undoLastTypedText()
      return { status, result: message }
    }
    default:
      return { error: `Unrecognized action "${name}".` }
  }
}
