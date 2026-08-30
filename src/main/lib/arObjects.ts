import type { BrowserWindow } from 'electron'
import type { ArBlueprint } from '@shared/types'
import { BUILTIN_BLUEPRINTS, resolveBlueprintName, sanitizeBlueprint } from '@shared/arBlueprints'
import * as handTracking from './handTracking'

/**
 * Spatial AR object placement — DALVE can drop a manipulable 3D object into the live camera feed
 * for the user to grab/move/rotate/resize with their tracked hand. The actual Three.js scene lives
 * in the renderer (same reason hand tracking's camera/vision work does — no main-process WebGL),
 * this module just relays the AI's intent to spawn/clear an object into that renderer scene, the
 * same attach/relay shape as handTracking.ts uses for start/stop.
 *
 * Objects come from two sources into the exact same ArBlueprint shape: a small hand-authored
 * preset library (BUILTIN_BLUEPRINTS, for a fast named spawn) and an AI-generated one from looking
 * at a screenshot (see look_and_place_object in geminiLive.ts) — "unlimited object types" is just
 * more/better blueprints on this one path, not a second engine.
 */

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

let active = false

export function isActive(): boolean {
  return active
}

export function listBuiltinTypes(): string[] {
  return Object.keys(BUILTIN_BLUEPRINTS)
}

/** Turning on the camera is a real prerequisite for placing anything in it — rather than making
 *  the model remember to chain start_hand_tracking before every spawn (a real reported failure
 *  mode elsewhere: claiming a prerequisite is handled without actually doing it), just do it here
 *  whenever it's actually needed. */
function ensureCameraOn(): void {
  if (!handTracking.isActive()) handTracking.start()
}

export function spawn(type: string): { status: 'SUCCESS' | 'FAILED'; message: string } {
  if (!win) return { status: 'FAILED', message: 'No window to render the object in.' }
  const blueprint = resolveBlueprintName(type)
  if (!blueprint) {
    return {
      status: 'FAILED',
      message: `Don't have a built-in "${type}" — available presets are ${listBuiltinTypes().join(', ')}. Use look_and_place_object to generate any other real-world object from a screenshot instead.`
    }
  }
  ensureCameraOn()
  active = true
  win.webContents.send('ar:spawn', blueprint)
  return { status: 'SUCCESS', message: describeSpawn(blueprint) }
}

/** Spawns an arbitrary AI-generated object description — but ALWAYS checks the curated preset
 *  library first by the detected name (see resolveBlueprintName). Real reported failure: asked to
 *  place a spoon, the freely-generated geometry for something this ordinary came out "super
 *  random" — a name match against a hand-tuned preset is far more reliable than trusting a fresh
 *  guess every time, so free generation (sanitizeBlueprint) is now only actually used for objects
 *  that genuinely aren't in the library. A malformed or unexpected model response still degrades
 *  to a plain labeled box instead of failing outright or building something broken. */
export function spawnBlueprint(raw: unknown, fallbackName: string): { status: 'SUCCESS'; message: string } {
  const preset = resolveBlueprintName(fallbackName)
  const blueprint: ArBlueprint = preset ?? sanitizeBlueprint(raw, fallbackName)
  ensureCameraOn()
  active = true
  win?.webContents.send('ar:spawn', blueprint)
  return { status: 'SUCCESS', message: describeSpawn(blueprint) }
}

function describeSpawn(blueprint: ArBlueprint): string {
  const hasHandle = blueprint.parts.some((p) => p.role === 'handle')
  const hasButton = blueprint.parts.some((p) => p.role === 'button')
  const hints: string[] = ['pinch thumb+index on it to grab and move it']
  if (hasHandle) hints.push('pinch its handle to open it')
  if (hasButton) hints.push('pinch a button to press it')
  hints.push('pinch thumb+middle and drag to rotate it', 'hold a grab and spread 3 fingers to resize it')
  return `Placed a ${blueprint.name} in the camera view — ${hints.join(', ')}.`
}

export function clear(): { status: 'SUCCESS'; message: string } {
  active = false
  win?.webContents.send('ar:clear')
  return { status: 'SUCCESS', message: 'Removed the object from the camera view.' }
}
