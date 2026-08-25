import { desktopCapturer, screen, type BrowserWindow } from 'electron'
import { performance } from 'perf_hooks'
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

/** Approved at least once for the current control session — gates all physical-input tools. */
let controlGranted = false

export function isSharing(): boolean {
  return shareTimer !== null
}

export function isControlGranted(): boolean {
  return controlGranted
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

/** Captures a single screenshot of the primary monitor as base64 JPEG. */
export async function captureScreenshotOnce(quality = 88): Promise<string | null> {
  const display = primaryDisplay()
  const width = Math.round(display.bounds.width * display.scaleFactor)
  const height = Math.round(display.bounds.height * display.scaleFactor)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const matched = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!matched || matched.thumbnail.isEmpty()) return null
  return matched.thumbnail.toJPEG(quality).toString('base64')
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

/** Revokes standing control and stops sharing — the global "Stop" kill-switch. */
export function stopAll(): void {
  stopScreenShare()
  controlGranted = false
}

/**
 * Grants or revokes standing authorization for click/type/key. Set true as soon as screen
 * sharing starts (the user's already on notice that DALVE can see and act — no separate
 * per-action confirmation), and by the autonomous task runner for its own up-front,
 * per-task "run this without asking me each time" consent (see autonomousTask.ts).
 */
export function setControlGranted(granted: boolean): void {
  controlGranted = granted
}

function requireControl(): void {
  if (!controlGranted) {
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

export function typeText(text: string): void {
  requireControl()
  getRobot().typeString(text)
}

const VALID_MODIFIERS = new Set(['alt', 'command', 'control', 'shift'])

export function pressKey(key: string, modifiers: string[] = []): void {
  requireControl()
  const mods = modifiers.map((m) => m.toLowerCase()).filter((m) => VALID_MODIFIERS.has(m))
  getRobot().keyTap(key.toLowerCase(), mods)
}

// Scrolling only changes what's visible, never submits or commits anything — treated like
// move_mouse as a harmless "look around" action that doesn't need the control gate.
export function scroll(deltaX: number, deltaY: number): void {
  getRobot().scrollMouse(deltaX, deltaY)
}
