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
let leftPinchStartAt: number | null = null
// True once a held left pinch has crossed HOLD_TO_DRAG_MS — cursor movement switches back to full
// speed at that point (see cursorSlowdownFactor) so the hand can actually drag something instead
// of staying frozen the whole time a pinch is held, which is what pinching otherwise looks like.
let leftDragging = false
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
// noise right at the boundary. Loosened both from the first pass (0.045/0.08) per direct feedback
// that pinches still needed "too much" closing distance to register — ENGAGE stays tighter than
// RELEASE so a genuine pinch registers cleanly and doesn't re-fire until fingers clearly separate.
const PINCH_ENGAGE = 0.055
const PINCH_RELEASE = 0.09
// As fingers approach pinch distance, cursor movement gets damped toward fully frozen (not just
// slowed) — direct feedback was that clicks still failed to register because the cursor kept
// drifting during the docking motion even with the earlier partial damping, landing the click
// off-target. SLOWDOWN_START is the distance at which damping begins ramping in; at or below
// PINCH_ENGAGE the cursor is completely still, not just nearly so.
const SLOWDOWN_START = 0.16
// How long a left pinch (thumb+index) must be held before it's treated as "grab and drag" instead
// of "click" — per explicit request, mirrors holding down the left mouse button to move something.
const HOLD_TO_DRAG_MS = 2000

// Zoom: tracks a short rolling window of hand-openness ("spread") samples and looks for it
// growing (zoom in) or shrinking (zoom out) across that window — one continuous gesture, not a
// per-frame toggle. No longer requires any vertical hand motion (per feedback that having to
// move the hand up/down at the same time made the gesture harder to land) — openness alone
// drives it now. Threshold loosened and cooldown shortened per feedback that it was "hard to get
// it to notice" and jumped by an unhelpfully small amount each time; each detected gesture now
// fires one clearly noticeable step rather than a barely-visible increment. Thresholds are still a
// first pass with no camera to tune against, same caveat as the original constants.
const ZOOM_WINDOW_MS = 400
const ZOOM_SPREAD_THRESHOLD = 0.045
const ZOOM_COOLDOWN_MS = 500
// Ctrl+scroll zoom step size is ultimately up to whatever app is focused (there's no OS-wide way
// to force an exact "15% per step" — Chrome-based zoom, OS icon scaling, and PDF viewers all
// interpret scroll notches differently), but a bigger notch burst per gesture gets much closer to
// one clearly noticeable jump instead of the barely-perceptible increments this had before.
const ZOOM_SCROLL_NOTCHES = 10

interface ZoomSample {
  t: number
  spread: number
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
  leftPinchStartAt = null
  leftDragging = false
  rightPinching = false
  zoomHistory = []
  win.webContents.send('handTracking:start')
  return {
    status: 'SUCCESS',
    message:
      'Starting the camera — move your index finger to move the cursor, pinch thumb+index to left-click (hold it to drag), thumb+middle to right-click, open/close your hand to zoom.'
  }
}

export function stop(): { status: 'SUCCESS'; message: string } {
  // Safety net: never leave the mouse button physically held down if tracking stops mid-drag.
  if (leftPinching) screenControl.releaseMouseUp('left')
  active = false
  leftPinching = false
  leftPinchStartAt = null
  leftDragging = false
  rightPinching = false
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

/** Left click gets its own state machine (instead of the simple handlePinch above) because it
 *  supports click-and-hold-to-drag: press on engage, keep the button held the whole time the
 *  pinch is maintained, release on release — a fast pinch-release reads as a normal click, a
 *  pinch held past HOLD_TO_DRAG_MS reads as "grab and drag". */
function updateLeftPinch(dist: number): void {
  const now = Date.now()
  if (!leftPinching && dist < PINCH_ENGAGE) {
    leftPinching = true
    leftPinchStartAt = now
    leftDragging = false
    screenControl.pressMouseDown('left')
    return
  }
  if (leftPinching && dist > PINCH_RELEASE) {
    leftPinching = false
    leftPinchStartAt = null
    leftDragging = false
    screenControl.releaseMouseUp('left')
    return
  }
  if (leftPinching && !leftDragging && leftPinchStartAt !== null && now - leftPinchStartAt >= HOLD_TO_DRAG_MS) {
    leftDragging = true
  }
}

/** While docking a fresh pinch (closing in, not yet decided click vs. drag), cursor movement
 *  damps toward fully frozen so the click lands where it was aimed instead of drifting during the
 *  closing motion. Once a left pinch has turned into an actual drag, that protection would just
 *  prevent the drag itself — full speed resumes so the hand can drag normally. */
function cursorSlowdownFactor(closestPinch: number): number {
  if (leftDragging) return 1
  if (closestPinch <= PINCH_ENGAGE) return 0
  if (closestPinch >= SLOWDOWN_START) return 1
  return (closestPinch - PINCH_ENGAGE) / (SLOWDOWN_START - PINCH_ENGAGE)
}

function checkZoom(spread: number): void {
  const now = Date.now()
  zoomHistory.push({ t: now, spread })
  zoomHistory = zoomHistory.filter((s) => now - s.t <= ZOOM_WINDOW_MS)
  if (zoomHistory.length < 3 || now - lastZoomAt < ZOOM_COOLDOWN_MS) return

  const oldest = zoomHistory[0]
  const spreadDelta = spread - oldest.spread

  if (spreadDelta > ZOOM_SPREAD_THRESHOLD) {
    lastZoomAt = now
    zoomHistory = []
    screenControl.zoomAtCurrentPosition(ZOOM_SCROLL_NOTCHES)
  } else if (spreadDelta < -ZOOM_SPREAD_THRESHOLD) {
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
  updateCursor(frame.indexX, frame.indexY, BASE_SMOOTHING * cursorSlowdownFactor(closestPinch))

  updateLeftPinch(frame.thumbIndexDist)
  // Only consider a right-click pinch when the left-click gesture isn't also currently engaged,
  // so a thumb resting near both fingers during a left-click doesn't also fire a right-click.
  if (!leftPinching) {
    rightPinching = handlePinch(frame.thumbMiddleDist, rightPinching, () => screenControl.clickAtCurrentPosition('right'))
  }

  checkZoom(frame.spread)
}
