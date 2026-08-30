import { app, desktopCapturer, screen, type BrowserWindow } from 'electron'
import { performance } from 'perf_hooks'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import type { ScreenControlEvent } from '@shared/types'

// robotjs is a native addon (rebuilt against Electron's ABI via `electron-builder install-app-deps`
// in postinstall). Requiring it lazily, and behind a try/catch, means a machine/platform where the
// native build didn't succeed degrades to "screen sharing works, physical control doesn't" instead
// of crashing the whole app at import time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let robot: any = null
function getRobot(): any {
  if (robot) return robot
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    robot = require('robotjs')
    robot.setMouseDelay(4)
    robot.setKeyboardDelay(4)
  } catch (err) {
    console.error('[screenControl] robotjs unavailable — physical control disabled:', err)
    throw new Error('Screen control is not available on this machine (input driver failed to load).')
  }
  return robot
}

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: ScreenControlEvent): void {
  win?.webContents.send('screenControl:event', event)
}

let shareTimer: ReturnType<typeof setInterval> | null = null
let onFrame: ((base64Jpeg: string) => void) | null = null

// THREE independent grants, not one shared flag. They used to be a single `controlGranted`
// boolean that both the live voice session and the autonomous task runner set/cleared — which
// meant either one ending (geminiLive's stopAll() on session close/error, completely unrelated to
// whatever the autonomous task was doing) silently revoked the OTHER subsystem's authorization
// mid-run. Confirmed live: an autonomous WhatsApp task started getting "Not authorized to act
// yet" on click_mouse mid-task with no user action to explain it — root cause was exactly this.
// remoteControlGranted is the same idea for telegramBridge.ts's one-shot remote commands — kept
// separate so a Telegram command finishing (and revoking its own grant) can never strip
// permission out from under a concurrently-running autonomous task, or vice versa.
let liveControlGranted = false
let autonomousControlGranted = false
let remoteControlGranted = false

export function isSharing(): boolean {
  return shareTimer !== null
}

export function isControlGranted(): boolean {
  return liveControlGranted || autonomousControlGranted || remoteControlGranted
}

// Locked to the primary monitor only — multi-monitor targeting (list_monitors/switch_monitor)
// was a real source of "clicked but nothing happened" bugs: a window could open on a different
// physical monitor than the one being watched, and DALVE had no reliable way to notice. Simpler
// and more reliable to just always watch and act on the main display.
function primaryDisplay() {
  return screen.getPrimaryDisplay()
}

/** The primary monitor's captured-frame pixel dimensions — what x/y=0..width/height already mean
 *  to every tool here. Exposed so callers dealing in a different coordinate space (e.g. the
 *  computer_use tool's 0-999 normalized coordinates) can convert into this one correctly. */
export function getFrameSize(): { width: number; height: number } {
  const display = primaryDisplay()
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }
}

/** Captures a single screenshot of the primary monitor as base64 JPEG. `maxWidth`, if given,
 *  downscales before encoding — a real, confirmed need for the turn-based voice engine
 *  (geminiTurnVoice.ts): a full native-resolution screenshot (e.g. a 1440p+ display) alone was
 *  enough to meaningfully eat into a free-tier vision model's per-minute token budget on the
 *  Groq-backed engine this replaced, and stays cheap discipline now on Gemini's own budget. */
export async function captureScreenshotOnce(quality = 88, maxWidth?: number): Promise<string | null> {
  const display = primaryDisplay()
  const width = Math.round(display.bounds.width * display.scaleFactor)
  const height = Math.round(display.bounds.height * display.scaleFactor)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const matched = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!matched || matched.thumbnail.isEmpty()) return null
  let image = matched.thumbnail
  const size = image.getSize()
  if (maxWidth && size.width > maxWidth) {
    image = image.resize({ width: maxWidth, height: Math.round(size.height * (maxWidth / size.width)) })
  }
  return image.toJPEG(quality).toString('base64')
}

/** Captures the primary monitor at full quality and saves it as a real PNG file the user can
 *  actually open/share — distinct from captureScreenshotOnce, which only ever produces an
 *  in-memory base64 JPEG fed silently to a model as vision context. Saved under Pictures so it
 *  shows up somewhere the user would naturally look, not buried in an app-data folder. */
export async function saveScreenshot(): Promise<{ status: 'SUCCESS' | 'FAILED'; path?: string; message: string }> {
  const display = primaryDisplay()
  const width = Math.round(display.bounds.width * display.scaleFactor)
  const height = Math.round(display.bounds.height * display.scaleFactor)

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  const matched = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!matched || matched.thumbnail.isEmpty()) {
    return { status: 'FAILED', message: 'Could not capture the screen.' }
  }

  const dir = join(app.getPath('pictures'), 'DALVE Screenshots')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(dir, `dalve-${stamp}.png`)
  writeFileSync(filePath, matched.thumbnail.toPNG())
  return { status: 'SUCCESS', path: filePath, message: `Saved a screenshot to ${filePath}` }
}

/** Starts periodic screenshot capture of the active monitor, handed to `onFrameCb` as base64 JPEG (~1 fps). */
export function startScreenShare(onFrameCb: (base64Jpeg: string) => void): void {
  if (shareTimer) return
  onFrame = onFrameCb
  emit({ type: 'active', active: true })

  const capture = async (): Promise<void> => {
    try {
      // Higher quality than a typical video frame — this is read for small text (chat names,
      // list items) that a compressed frame turns into mush, which is exactly what was causing
      // wrong-target clicks: she genuinely couldn't distinguish similar-looking rows.
      const base64 = await captureScreenshotOnce(88)
      if (base64) onFrame?.(base64)
    } catch (err) {
      console.error('[screenControl] frame capture failed:', err)
    }
  }

  void capture()
  shareTimer = setInterval(() => void capture(), 1000)
}

export function stopScreenShare(): void {
  if (shareTimer) {
    clearInterval(shareTimer)
    shareTimer = null
  }
  onFrame = null
  emit({ type: 'active', active: false })
}

/** Revokes the LIVE session's standing control and stops sharing — the live session's own "Stop"
 *  kill-switch. Deliberately does not touch autonomousControlGranted — an unrelated background
 *  task's authorization must survive the live voice session ending. */
export function stopAll(): void {
  stopScreenShare()
  liveControlGranted = false
}

/**
 * Grants or revokes the LIVE voice session's standing authorization for click/type/key. Set true
 * as soon as screen sharing starts (the user's already on notice that DALVE can see and act — no
 * separate per-action confirmation).
 */
export function setControlGranted(granted: boolean): void {
  liveControlGranted = granted
}

/** Grants or revokes the autonomous task runner's own, independent standing authorization — see
 *  autonomousTask.ts. Kept separate from setControlGranted so starting/stopping one doesn't
 *  silently strip the other's permission. */
export function setAutonomousControlGranted(granted: boolean): void {
  autonomousControlGranted = granted
}

/** Grants or revokes a Telegram remote command's own, independent standing authorization — see
 *  telegramBridge.ts. Kept separate so one running command finishing doesn't strip permission
 *  from a concurrently-running autonomous task or live session, or vice versa. */
export function setRemoteControlGranted(granted: boolean): void {
  remoteControlGranted = granted
}

function requireControl(): void {
  if (!liveControlGranted && !autonomousControlGranted && !remoteControlGranted) {
    throw new Error('Not authorized to act yet — call start_screen_share before taking any physical action.')
  }
}

/**
 * Translates a coordinate on the primary monitor's video frame (0,0 = its top-left) into
 * robotjs's global desktop coordinate space, then clamps it to that monitor's bounds.
 */
function toGlobalCoords(x: number, y: number): { x: number; y: number } {
  const display = primaryDisplay()
  const originX = Math.round(display.bounds.x * display.scaleFactor)
  const originY = Math.round(display.bounds.y * display.scaleFactor)
  const width = Math.round(display.bounds.width * display.scaleFactor)
  const height = Math.round(display.bounds.height * display.scaleFactor)
  return {
    x: originX + Math.max(0, Math.min(Math.round(x), width - 1)),
    y: originY + Math.max(0, Math.min(Math.round(y), height - 1))
  }
}

// --- Mouse trajectory engine ---
// robotjs's own moveMouseSmooth produced genuinely poor motion (reported as looking like
// teleporting rather than travel, especially on curved paths) — it appears to internally step by
// a fixed small delta per call with no real timing control. This replaces it with a hand-rolled
// animator: one high-level command crosses into this module once, and the actual point-by-point
// stepping happens in a local, real-time-driven loop (performance.now()-based, self-correcting
// for timer drift/jitter) rather than a naive fixed-delay-per-step approach. The model only ever
// asks for a target and a mode; it never generates individual coordinates.
export type MoveMode = 'instant' | 'visible'

const FRAME_MS = 12 // ~80fps ceiling — smooth without hammering the CPU or the input queue

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/** Duration scales with distance so a 30px nudge and a full-screen traverse don't take the same time. */
function durationForDistance(distancePx: number): number {
  return Math.min(650, Math.max(90, distancePx * 0.55))
}

async function animateTo(toX: number, toY: number): Promise<void> {
  const r = getRobot()
  const from = r.getMousePos()
  const distance = Math.hypot(toX - from.x, toY - from.y)
  if (distance < 1) return
  const durationMs = durationForDistance(distance)
  const start = performance.now()

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const elapsed = performance.now() - start
      const t = Math.min(1, elapsed / durationMs)
      const eased = easeInOutQuad(t)
      r.moveMouse(Math.round(from.x + (toX - from.x) * eased), Math.round(from.y + (toY - from.y) * eased))
      if (t < 1) setTimeout(tick, FRAME_MS)
      else resolve()
    }
    tick()
  })
}

/** Animates through a sequence of points as one continuous motion over totalDurationMs. */
async function animatePath(points: { x: number; y: number }[], totalDurationMs: number): Promise<void> {
  if (points.length === 0) return
  const r = getRobot()
  const perSegment = totalDurationMs / points.length
  const start = performance.now()

  for (let i = 0; i < points.length; i++) {
    const segmentStart = start + i * perSegment
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const elapsed = performance.now() - segmentStart
        const t = Math.min(1, elapsed / perSegment)
        r.moveMouse(Math.round(points[i].x), Math.round(points[i].y))
        if (t < 1) setTimeout(tick, FRAME_MS)
        else resolve()
      }
      tick()
    })
  }
}

export async function moveMouse(x: number, y: number, mode: MoveMode = 'visible'): Promise<void> {
  const p = toGlobalCoords(x, y)
  if (mode === 'instant') {
    getRobot().moveMouse(p.x, p.y)
  } else {
    await animateTo(p.x, p.y)
  }
}

/**
 * Direct, ungated, un-eased cursor set in GLOBAL desktop coordinates (not the captured-frame
 * space toGlobalCoords converts from) — used by handTracking.ts, where the user's own physical
 * hand is the actual input device, not an AI-chosen action. Deliberately skips requireControl()
 * for the same reason installing a different physical mouse wouldn't need AI permission, and
 * skips the eased animation since the hand-tracking layer already paces/smooths every frame
 * itself — adding another smoothing pass on top would just add lag.
 */
export function setCursorPositionAbsolute(x: number, y: number): void {
  getRobot().moveMouse(Math.round(x), Math.round(y))
}

/** Same "the human is the actual actor" reasoning as setCursorPositionAbsolute — a pinch gesture
 *  is the user's own physical click, not an AI decision, so this isn't gated either. */
export function clickAtCurrentPosition(button: 'left' | 'right' = 'left'): void {
  getRobot().mouseClick(button)
  canUndoTyping = false
}

/** Explicit press/release (not a single click) — what hand-tracking's click-and-hold-to-drag
 *  needs: press the instant a pinch engages, keep the button held while the pinch is maintained,
 *  release the instant it's released. Same "the user's own gesture is the actual actor" reasoning
 *  as the other hand-tracking primitives here, so this isn't gated either. */
export function pressMouseDown(button: 'left' | 'right' = 'left'): void {
  getRobot().mouseToggle('down', button)
  canUndoTyping = false
}

export function releaseMouseUp(button: 'left' | 'right' = 'left'): void {
  getRobot().mouseToggle('up', button)
}

/** Explicit key hold/release (not a tap) — what steeringWheel.ts needs: hold W/A/S/D/Space for as
 *  long as the tracked gesture (wheel angle, hand height, a drift) says it should keep going, not
 *  a single keyTap. Same "the user's own gesture is the actual actor" reasoning as the mouse
 *  press/release and cursor functions above, so this isn't gated behind requireControl() either —
 *  turning steering-wheel tracking on IS the user's explicit standing authorization for it, the
 *  same way turning on hand-tracking cursor control already is for clicks. */
export function holdKey(key: string): void {
  getRobot().keyToggle(key.toLowerCase(), 'down')
}

export function releaseKey(key: string): void {
  getRobot().keyToggle(key.toLowerCase(), 'up')
}

/**
 * Ctrl+scroll at the current cursor position — the standard cross-app zoom gesture (browsers,
 * most image/PDF viewers, many creative apps, Windows desktop icon size). Used by handTracking.ts
 * for the open/close-while-moving-vertically zoom gesture; same "the user's own gesture is the
 * actual actor" reasoning as the cursor/click functions above, so this isn't gated either.
 * Positive notches zooms in, negative zooms out.
 */
export function zoomAtCurrentPosition(notches: number): void {
  const r = getRobot()
  r.keyToggle('control', 'down')
  try {
    r.scrollMouse(0, notches)
  } finally {
    r.keyToggle('control', 'up')
  }
}

export async function clickMouse(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  double = false,
  mode: MoveMode = 'visible'
): Promise<void> {
  requireControl()
  const p = toGlobalCoords(x, y)
  const r = getRobot()
  if (mode === 'instant') {
    r.moveMouse(p.x, p.y)
  } else {
    await animateTo(p.x, p.y)
  }
  r.mouseClick(button, double)
  canUndoTyping = false
}

/**
 * A real press-move-release drag, not two separate clicks — many sites (drag-to-move chess
 * boards among them) only respond to an actual held-mouse-button drag gesture, which nothing in
 * this file could produce before this. Moves to the start point first, presses down, drags
 * smoothly to the end point via the same trajectory engine as a normal move, then releases.
 */
export async function dragMouse(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  mode: MoveMode = 'visible'
): Promise<void> {
  requireControl()
  const from = toGlobalCoords(fromX, fromY)
  const to = toGlobalCoords(toX, toY)
  const r = getRobot()
  if (mode === 'instant') {
    r.moveMouse(from.x, from.y)
  } else {
    await animateTo(from.x, from.y)
  }
  r.mouseToggle('down')
  try {
    if (mode === 'instant') {
      r.moveMouse(to.x, to.y)
    } else {
      await animateTo(to.x, to.y)
    }
  } finally {
    r.mouseToggle('up')
  }
  canUndoTyping = false
}

export type TracePattern = 'circle' | 'square' | 'zigzag' | 'line'

/**
 * Generates and smoothly animates a named shape locally — used both as a real "trace this path"
 * capability and as a direct fix for the circle/square/zigzag test: the model names the shape and
 * its size once, instead of computing and issuing dozens of individual move calls itself (which
 * is inherently janky no matter how good the animator is, since each call round-trips through the
 * tool-call/IPC layer separately).
 */
export async function tracePattern(
  pattern: TracePattern,
  centerX: number,
  centerY: number,
  size: number,
  durationMs = 1200
): Promise<void> {
  const c = toGlobalCoords(centerX, centerY)
  const half = size / 2
  const points: { x: number; y: number }[] = []

  if (pattern === 'circle') {
    const steps = 72
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2
      points.push({ x: c.x + Math.cos(angle) * half, y: c.y + Math.sin(angle) * half })
    }
  } else if (pattern === 'square') {
    const corners = [
      { x: c.x - half, y: c.y - half },
      { x: c.x + half, y: c.y - half },
      { x: c.x + half, y: c.y + half },
      { x: c.x - half, y: c.y + half },
      { x: c.x - half, y: c.y - half }
    ]
    const stepsPerSide = 18
    for (let i = 0; i < corners.length - 1; i++) {
      for (let s = 0; s < stepsPerSide; s++) {
        const t = s / stepsPerSide
        points.push({
          x: corners[i].x + (corners[i + 1].x - corners[i].x) * t,
          y: corners[i].y + (corners[i + 1].y - corners[i].y) * t
        })
      }
    }
  } else if (pattern === 'zigzag') {
    const segments = 6
    const stepsPerSegment = 12
    for (let i = 0; i < segments; i++) {
      const x0 = c.x - half + (size / segments) * i
      const x1 = c.x - half + (size / segments) * (i + 1)
      const y0 = i % 2 === 0 ? c.y - half : c.y + half
      const y1 = i % 2 === 0 ? c.y + half : c.y - half
      for (let s = 0; s < stepsPerSegment; s++) {
        const t = s / stepsPerSegment
        points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t })
      }
    }
  } else {
    // line: straight across through the center, `size` long
    const steps = 40
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      points.push({ x: c.x - half + size * t, y: c.y })
    }
  }

  await animatePath(points, durationMs)
}

// Real, honest scope for "undo": only typed text has a safe, well-defined inverse (the target
// app's own Ctrl+Z) — a click, a send, or a drag has no reliable universal undo, and pretending
// otherwise would be worse than not offering it. Cleared by anything that moves on from the typed
// text (a click, a drag, Enter/Return) since undoing it would no longer make sense at that point.
let canUndoTyping = false

export function typeText(text: string): void {
  requireControl()
  getRobot().typeString(text)
  canUndoTyping = true
}

const VALID_MODIFIERS = new Set(['alt', 'command', 'control', 'shift'])

export function pressKey(key: string, modifiers: string[] = []): void {
  requireControl()
  const mods = modifiers.map((m) => m.toLowerCase()).filter((m) => VALID_MODIFIERS.has(m))
  getRobot().keyTap(key.toLowerCase(), mods)
  if (['enter', 'return'].includes(key.toLowerCase())) canUndoTyping = false
}

/** Best-effort, honest undo: sends the frontmost app's own Ctrl+Z (Cmd+Z on Mac) right after
 *  DALVE typed something — the same thing a human would do to undo it themselves. Deliberately
 *  refuses once a click/drag/Enter has happened since, rather than pretending it would still work. */
export function undoLastTypedText(): { status: 'SUCCESS' | 'FAILED'; message: string } {
  if (!canUndoTyping) {
    return {
      status: 'FAILED',
      message:
        "Nothing safely undoable right now — this only works immediately after DALVE typed something, before a click, Enter, or a send happened since. Clicks and sent messages can't be reliably undone this way."
    }
  }
  canUndoTyping = false
  const r = getRobot()
  const modifier = process.platform === 'darwin' ? 'command' : 'control'
  r.keyToggle(modifier, 'down')
  try {
    r.keyTap('z')
  } finally {
    r.keyToggle(modifier, 'up')
  }
  return { status: 'SUCCESS', message: "Sent the app's own undo (Ctrl+Z) for the last text DALVE typed — check that it actually reverted what you expected." }
}

// Scrolling only changes what's visible, never submits or commits anything — treated like
// move_mouse as a harmless "look around" action that doesn't need the control gate.
export function scroll(deltaX: number, deltaY: number): void {
  getRobot().scrollMouse(deltaX, deltaY)
}
