import { screen, type BrowserWindow } from 'electron'
import * as screenControl from './screenControl'
import type { HandFrame } from '@shared/types'

/**
 * Webcam hand-tracking as a real cursor replacement — move your hand, the cursor follows; pinch
 * (thumb to index) to left-click, pinch (thumb to middle) to right-click, open/close the hand
 * while moving up/down to zoom. The actual camera capture + MediaPipe hand-landmark inference
 * runs in the RENDERER (getUserMedia + WASM are browser-standard APIs; there's no camera or
 * vision-model access from the Electron main process), driven by HandTrackingController.tsx —
 * this module owns all the gesture policy (thresholds, smoothing, hysteresis, zoom windowing)
 * and turns per-frame hand geometry into real cursor movement and clicks.
 */

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

let active = false
let smoothedX: number | null = null
let smoothedY: number | null = null
let leftPinching = false
let rightPinching = false

// Lower = smoother but laggier, higher = snappier but jitterier. Started at 0.35, then 0.15 after
// real feedback the cursor felt too fast — this is the dominant "speed" knob, how much of the gap
// to the new hand position closes per frame.
const BASE_SMOOTHING = 0.15
// A hand rarely reaches the true edges of the camera frame comfortably — mapping only the center
// 90% of tracked range to the full screen means a natural, relaxed hand range still reaches every
// screen edge instead of requiring an uncomfortable stretch to the frame border.
const ACTIVE_MARGIN = 0.05

// Pinch detection uses hysteresis (two different thresholds for "just pinched" vs. "just
// released"), not one — a single threshold flickers true/false across frame-to-frame landmark
// noise right at the boundary, which is the actual mechanism behind "sometimes doesn't register
// as a click." ENGAGE is deliberately tighter than RELEASE so a genuine pinch registers cleanly
// and doesn't re-fire until the fingers have clearly moved apart again.
const PINCH_ENGAGE = 0.045
const PINCH_RELEASE = 0.08
// As fingers approach pinch distance, cursor movement gets damped toward near-frozen — directly
// per user feedback/suggestion: the actual failure mode wasn't the pinch failing to register, it
// was the cursor still drifting during the docking motion, so the click landed off-target and
// read as "it moved instead of clicking." SLOWDOWN_START is the distance at which damping begins
// ramping in; below PINCH_ENGAGE the cursor is nearly stationary.
const SLOWDOWN_START = 0.14

// Zoom: tracks a short rolling window of {spread, palmY} samples and looks for the hand
// opening while rising (zoom in) or closing while falling (zoom out) across that window — one
// continuous gesture, not a per-frame toggle. Thresholds/window length are a first pass with no
// camera to tune against, same caveat as the original sensitivity constants.
const ZOOM_WINDOW_MS = 450
const ZOOM_SPREAD_THRESHOLD = 0.06
const ZOOM_VERTICAL_THRESHOLD = 0.08
const ZOOM_COOLDOWN_MS = 700
const ZOOM_SCROLL_NOTCHES = 4

interface ZoomSample {
  t: number
  spread: number
  palmY: number
}
let zoomHistory: ZoomSample[] = []
let lastZoomAt = 0

function mapAxis(raw: number): number {
  const t = (raw - ACTIVE_MARGIN) / (1 - 2 * ACTIVE_MARGIN)
  return Math.min(1, Math.max(0, t))
}

export function isActive(): boolean {
  return active
}

export function start(): { status: 'SUCCESS' | 'FAILED'; message: string } {
  if (!win) return { status: 'FAILED', message: 'No window to run the camera in.' }
  if (active) return { status: 'SUCCESS', message: 'Hand tracking is already on.' }
  active = true
  smoothedX = null
  smoothedY = null
  leftPinching = false
  rightPinching = false
  zoomHistory = []
  win.webContents.send('handTracking:start')
  return {
    status: 'SUCCESS',
    message:
      'Starting the camera — move your index finger to move the cursor, pinch thumb+index to left-click, thumb+middle to right-click, open/close your hand while moving up/down to zoom.'
  }
}

export function stop(): { status: 'SUCCESS'; message: string } {
  active = false
  win?.webContents.send('handTracking:stop')
  return { status: 'SUCCESS', message: 'Hand tracking stopped, camera released.' }
}

function updateCursor(rawX: number, rawY: number, closenessSmoothingFactor: number): void {
  // Mirror X: a front-facing camera captures the opposite of what the user experiences as "my
  // right hand" — without this, moving your hand right would move the cursor left.
  const targetX = mapAxis(1 - rawX)
  const targetY = mapAxis(rawY)

  smoothedX = smoothedX === null ? targetX : smoothedX + (targetX - smoothedX) * closenessSmoothingFactor
  smoothedY = smoothedY === null ? targetY : smoothedY + (targetY - smoothedY) * closenessSmoothingFactor

  const display = screen.getPrimaryDisplay()
  screenControl.setCursorPositionAbsolute(
    display.bounds.x + smoothedX * display.bounds.width,
    display.bounds.y + smoothedY * display.bounds.height
  )
}

function handlePinch(
  dist: number,
  wasPinching: boolean,
  onEngage: () => void
): boolean {
  if (!wasPinching && dist < PINCH_ENGAGE) {
    onEngage()
    return true
  }
  if (wasPinching && dist > PINCH_RELEASE) {
    return false
  }
  return wasPinching
}

function checkZoom(spread: number, palmY: number): void {
  const now = Date.now()
  zoomHistory.push({ t: now, spread, palmY })
  zoomHistory = zoomHistory.filter((s) => now - s.t <= ZOOM_WINDOW_MS)
  if (zoomHistory.length < 3 || now - lastZoomAt < ZOOM_COOLDOWN_MS) return

  const oldest = zoomHistory[0]
  const spreadDelta = spread - oldest.spread
  // Normalized image Y increases downward, so a negative delta means the hand rose.
  const verticalDelta = oldest.palmY - palmY

  if (spreadDelta > ZOOM_SPREAD_THRESHOLD && verticalDelta > ZOOM_VERTICAL_THRESHOLD) {
    lastZoomAt = now
    zoomHistory = []
    screenControl.zoomAtCurrentPosition(ZOOM_SCROLL_NOTCHES)
  } else if (spreadDelta < -ZOOM_SPREAD_THRESHOLD && verticalDelta < -ZOOM_VERTICAL_THRESHOLD) {
    lastZoomAt = now
    zoomHistory = []
    screenControl.zoomAtCurrentPosition(-ZOOM_SCROLL_NOTCHES)
  }
}

/** One tracked-hand frame from the renderer's camera+MediaPipe pipeline, called continuously
 *  (per animation frame) while tracking is active. */
export function onFrame(frame: HandFrame): void {
  if (!active) return

  const closestPinch = Math.min(frame.thumbIndexDist, frame.thumbMiddleDist)
  const slowdown =
    closestPinch >= SLOWDOWN_START
      ? 1
      : Math.max(0.08, closestPinch / SLOWDOWN_START)
  updateCursor(frame.indexX, frame.indexY, BASE_SMOOTHING * slowdown)

  leftPinching = handlePinch(frame.thumbIndexDist, leftPinching, () => screenControl.clickAtCurrentPosition('left'))
  // Only consider a right-click pinch when the left-click gesture isn't also currently engaged,
  // so a thumb resting near both fingers during a left-click doesn't also fire a right-click.
  if (!leftPinching) {
    rightPinching = handlePinch(frame.thumbMiddleDist, rightPinching, () => screenControl.clickAtCurrentPosition('right'))
  }

  checkZoom(frame.spread, frame.palmY)
}
