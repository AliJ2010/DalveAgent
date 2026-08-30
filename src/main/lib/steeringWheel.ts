import { type BrowserWindow } from 'electron'
import * as screenControl from './screenControl'
import * as handTracking from './handTracking'
import type { SteeringFrame } from '@shared/types'

/**
 * Two-fist "steering wheel" gesture: hold both hands closed like gripping a wheel, and DALVE
 * translates that into real WASD + Space key holds for a racing-game-style keyboard control
 * scheme. Same architecture as handTracking.ts — the camera capture + MediaPipe two-hand
 * inference runs in the renderer (HandTrackingController.tsx, steering mode), this module owns
 * all the gesture policy and turns per-frame fist positions into real held keys. A genuinely
 * separate mode from cursor-control hand tracking, not an extension of it: the two hands' RELATIVE
 * geometry (angle, height) is what matters here, not one hand's absolute position, and normal
 * click/zoom gestures would misfire constantly if run at the same time as gripping a wheel.
 *
 * Design (agreed with the user before building, not guessed):
 * - Steering (A/D): the angle of the line between the two fists vs. horizontal. Past a threshold
 *   either way, hold the matching key; back near level, release both.
 * - Throttle (W/S): the wheel's average height relative to wherever it was when tracking started
 *   (calibrated on the first frame both hands are visible, not a fixed band — adapts to the
 *   user's own seating/camera position). Higher than neutral holds W, lower holds S.
 * - Drift (Space): a FAST rotation (angular velocity, not just position) past a threshold counts
 *   as a "snap" and starts a drift in the snap's own direction (clockwise = right, counter-
 *   clockwise = left) — holding Space + that direction key. The drift keeps holding as long as
 *   the wheel stays turned past a smaller "still hard-turned" angle, and releases the moment the
 *   wheel comes back toward level. Two separate thresholds by design: velocity decides when a
 *   drift STARTS, position decides when it ENDS — a fast snap and a slow deliberate turn to the
 *   same final angle should not both trigger a drift.
 */

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

let active = false

export function isActive(): boolean {
  return active
}

// Hysteresis on the steering angle (radians) — wider release band than engage means once a turn
// direction is held, small jitter back toward center doesn't flicker the key on/off. Same
// engage-tighter/release-looser structure as handTracking.ts's pinch thresholds.
const STEER_ENGAGE_RAD = (12 * Math.PI) / 180
const STEER_RELEASE_RAD = (7 * Math.PI) / 180

// Throttle uses normalized (0-1) vertical displacement from the calibrated neutral height —
// resolution-independent, matches how every other hand-tracking gesture in this app is measured.
const THROTTLE_ENGAGE = 0.09
const THROTTLE_RELEASE = 0.05

// Drift entry: a real "snap", not a slow deliberate turn — the wheel angle must swing at least
// this far within this short a window. Mirrors handTracking.ts's zoom-gesture rolling-window
// shape (delta over a bounded recent window) rather than a raw instantaneous derivative, which
// would be too sensitive to single-frame landmark jitter.
const SNAP_WINDOW_MS = 180
const SNAP_ANGLE_DELTA_RAD = (24 * Math.PI) / 180
// Drift exit: independent of the snap trigger — the wheel must come back under this angle
// (smaller than the snap delta, roughly the same neighborhood as a normal hard turn) before the
// drift actually ends. This is what makes the drift last "as long as you hold the turned angle."
const DRIFT_SUSTAIN_RAD = (15 * Math.PI) / 180

type SteerState = 'left' | 'right' | 'center'
type ThrottleState = 'forward' | 'reverse' | 'neutral'
type DriftDirection = 'left' | 'right' | null

let neutralY: number | null = null
let steerState: SteerState = 'center'
let throttleState: ThrottleState = 'neutral'
let drifting = false
let driftDirection: DriftDirection = null
let angleHistory: { t: number; angle: number }[] = []
const heldKeys = new Set<string>()

function hold(key: string): void {
  if (heldKeys.has(key)) return
  heldKeys.add(key)
  screenControl.holdKey(key)
}

function release(key: string): void {
  if (!heldKeys.has(key)) return
  heldKeys.delete(key)
  screenControl.releaseKey(key)
}

function releaseAll(): void {
  for (const key of Array.from(heldKeys)) release(key)
}

export function start(): { status: 'SUCCESS' | 'FAILED'; message: string } {
  if (!win) return { status: 'FAILED', message: 'No window to run the camera in.' }
  if (active) return { status: 'SUCCESS', message: 'Steering wheel tracking is already on.' }
  // Only one hand-tracking mode can own the camera and gesture policy at a time.
  if (handTracking.isActive()) handTracking.stop()
  active = true
  neutralY = null
  steerState = 'center'
  throttleState = 'neutral'
  drifting = false
  driftDirection = null
  angleHistory = []
  win.webContents.send('steeringWheel:start')
  return {
    status: 'SUCCESS',
    message:
      "Starting the camera — hold both hands closed like gripping a wheel. Turn it left/right to steer, raise it to go forward, lower it to reverse, and snap it hard to one side to drift that direction, holding the turn to keep drifting."
  }
}

export function stop(): { status: 'SUCCESS'; message: string } {
  releaseAll() // safety net — never leave a key physically held down if tracking stops mid-turn
  active = false
  neutralY = null
  win?.webContents.send('steeringWheel:stop')
  return { status: 'SUCCESS', message: 'Steering wheel tracking stopped, camera released.' }
}

function updateSteering(angle: number): void {
  if (steerState !== 'right' && angle > STEER_ENGAGE_RAD) steerState = 'right'
  else if (steerState !== 'left' && angle < -STEER_ENGAGE_RAD) steerState = 'left'
  else if (steerState !== 'center' && Math.abs(angle) < STEER_RELEASE_RAD) steerState = 'center'

  // A held drift forces its own direction key regardless of the steering state machine above —
  // reconciled below in applyKeys() so the two never fight over the same key.
  if (steerState === 'right') {
    hold('d')
    release('a')
  } else if (steerState === 'left') {
    hold('a')
    release('d')
  } else {
    release('a')
    release('d')
  }
}

function updateThrottle(centerY: number): void {
  if (neutralY === null) {
    neutralY = centerY
    return
  }
  // Image Y increases downward, so a SMALLER centerY than neutral means the hands moved UP
  // (higher = forward, per direct request), and a LARGER centerY means they moved down (reverse).
  const delta = centerY - neutralY
  if (throttleState !== 'forward' && delta < -THROTTLE_ENGAGE) throttleState = 'forward'
  else if (throttleState !== 'reverse' && delta > THROTTLE_ENGAGE) throttleState = 'reverse'
  else if (throttleState !== 'neutral' && Math.abs(delta) < THROTTLE_RELEASE) throttleState = 'neutral'

  if (throttleState === 'forward') {
    hold('w')
    release('s')
  } else if (throttleState === 'reverse') {
    hold('s')
    release('w')
  } else {
    release('w')
    release('s')
  }
}

function updateDrift(angle: number, now: number): void {
  angleHistory.push({ t: now, angle })
  angleHistory = angleHistory.filter((s) => now - s.t <= SNAP_WINDOW_MS)

  if (!drifting) {
    if (angleHistory.length >= 2) {
      const oldest = angleHistory[0]
      const delta = angle - oldest.angle
      if (Math.abs(delta) >= SNAP_ANGLE_DELTA_RAD) {
        drifting = true
        driftDirection = delta > 0 ? 'right' : 'left'
      }
    }
  } else if (Math.abs(angle) < DRIFT_SUSTAIN_RAD) {
    drifting = false
    driftDirection = null
    // Otherwise the window still holds samples from the drift that just ended, which could read
    // as a fresh "snap" on the very next frame even though nothing new actually happened — an
    // immediate opposite-direction snap (an S-turn drift chain) needs a genuinely clean window,
    // not a cooldown timer papering over stale data (that just made a real quick re-snap
    // impossible for up to half a second, confirmed by a live simulation before this shipped).
    angleHistory = []
  }

  if (drifting && driftDirection) {
    hold('space')
    hold(driftDirection === 'right' ? 'd' : 'a')
  } else {
    release('space')
  }
}

/** One tracked-two-hand frame from the renderer's camera+MediaPipe pipeline. Either hand can be
 *  temporarily missing (camera angle, hand left the frame) — treated as "letting go of the
 *  wheel": every held key releases and drift resets, but the height calibration is kept so
 *  briefly repositioning your hands doesn't shift the whole neutral band. */
export function onFrame(frame: SteeringFrame): void {
  if (!active) return
  if (!frame.left || !frame.right) {
    releaseAll()
    steerState = 'center'
    throttleState = 'neutral'
    drifting = false
    driftDirection = null
    angleHistory = []
    return
  }

  const dx = frame.right.x - frame.left.x
  const dy = frame.right.y - frame.left.y
  const angle = Math.atan2(dy, dx)
  const centerY = (frame.left.y + frame.right.y) / 2

  updateSteering(angle)
  updateThrottle(centerY)
  updateDrift(angle, Date.now())
}
