import { screen, type BrowserWindow } from 'electron'
import * as screenControl from './screenControl'

/**
 * Webcam hand-tracking as a real cursor replacement — move your hand, the cursor follows; pinch
 * (thumb to index fingertip) to click. The actual camera capture + MediaPipe hand-landmark
 * inference runs in the RENDERER (getUserMedia + WASM are browser-standard APIs; there's no
 * camera or vision-model access from the Electron main process), driven by
 * HandTrackingBridge.tsx — this module just tells that component when to start/stop and turns
 * its per-frame hand position into real cursor movement.
 */

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

let active = false
let smoothedX: number | null = null
let smoothedY: number | null = null
let wasPinching = false

// Lower = smoother but laggier, higher = snappier but jitterier. Started at 0.35; lowered after
// real feedback that the cursor felt too fast/twitchy — this is the dominant "speed" knob since
// it controls how much of the gap to the new hand position gets closed every single frame.
const SMOOTHING = 0.15
// A hand rarely reaches the true edges of the camera frame comfortably — mapping only the
// center 90% of tracked range to the full screen means a natural, relaxed hand range still
// reaches every screen edge instead of requiring an uncomfortable stretch to the frame border.
// Widened from 0.1 (80% range) after the same "too fast" feedback — a WIDER active range means
// the same hand movement now covers proportionally LESS screen distance (lower sensitivity),
// at the small cost of needing to reach slightly closer to the frame's true edge for the very
// corners of the screen.
const ACTIVE_MARGIN = 0.05

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
  wasPinching = false
  win.webContents.send('handTracking:start')
  return { status: 'SUCCESS', message: 'Starting the camera — move your index finger to move the cursor, pinch your thumb and index finger together to click.' }
}

export function stop(): { status: 'SUCCESS'; message: string } {
  active = false
  win?.webContents.send('handTracking:stop')
  return { status: 'SUCCESS', message: 'Hand tracking stopped, camera released.' }
}

/**
 * One tracked-hand frame from the renderer's camera+MediaPipe pipeline. rawX/rawY are the index
 * fingertip's normalized (0-1) position in the RAW captured camera frame (unmirrored); pinching
 * is whether the thumb and index fingertip are currently close enough together to count as a
 * pinch. Called continuously (per animation frame) while tracking is active.
 */
export function onFrame(rawX: number, rawY: number, pinching: boolean): void {
  if (!active) return

  // Mirror X: a front-facing camera captures the opposite of what the user experiences as "my
  // right hand" — without this, moving your hand right would move the cursor left, which is the
  // opposite of what anyone expects from hand control (even without a mirrored preview to look
  // at, people move their hand the way they would if they COULD see themselves in a mirror).
  const targetX = mapAxis(1 - rawX)
  const targetY = mapAxis(rawY)

  smoothedX = smoothedX === null ? targetX : smoothedX + (targetX - smoothedX) * SMOOTHING
  smoothedY = smoothedY === null ? targetY : smoothedY + (targetY - smoothedY) * SMOOTHING

  const display = screen.getPrimaryDisplay()
  screenControl.setCursorPositionAbsolute(
    display.bounds.x + smoothedX * display.bounds.width,
    display.bounds.y + smoothedY * display.bounds.height
  )

  // Edge-triggered: fires once on the down-transition, not once per frame the pinch is held —
  // otherwise holding a pinch for even a few frames would fire a rapid burst of clicks.
  if (pinching && !wasPinching) {
    screenControl.clickAtCurrentPosition()
  }
  wasPinching = pinching
}
