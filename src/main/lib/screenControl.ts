import { desktopCapturer, screen, type BrowserWindow } from 'electron'
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

// Instant jump, not an animated glide — moveMouseSmooth's visible drag-across-the-screen was
// read as "slow." The final coordinate is identical either way; smooth vs instant only affects
// how it looks while getting there, not accuracy.
export function moveMouse(x: number, y: number): void {
  const p = toGlobalCoords(x, y)
  getRobot().moveMouse(p.x, p.y)
}

export function clickMouse(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', double = false): void {
  requireControl()
  const p = toGlobalCoords(x, y)
  const r = getRobot()
  r.moveMouse(p.x, p.y)
  r.mouseClick(button, double)
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
