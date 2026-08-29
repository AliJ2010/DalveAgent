import type { BrowserWindow } from 'electron'

/**
 * Spatial AR object placement — DALVE can drop a manipulable 3D object into the live camera feed
 * for the user to grab/move/rotate/resize with their tracked hand. The actual Three.js scene lives
 * in the renderer (same reason hand tracking's camera/vision work does — no main-process WebGL),
 * this module just relays the AI's intent to spawn/clear an object into that renderer scene, the
 * same attach/relay shape as handTracking.ts uses for start/stop.
 */

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

// V1 supports one procedural object. Real, working manipulation (grab/move/rotate/resize/door
// hinge/button press) beats a bigger catalog of objects with no interaction depth — more object
// types are a content problem, not an architecture one, and slot into the same spawn contract.
export type ArObjectType = 'microwave'
const KNOWN_TYPES: ArObjectType[] = ['microwave']

let currentType: ArObjectType | null = null

export function isActive(): boolean {
  return currentType !== null
}

export function spawn(type: string): { status: 'SUCCESS' | 'FAILED'; message: string } {
  if (!win) return { status: 'FAILED', message: 'No window to render the object in.' }
  const normalized = type.trim().toLowerCase() as ArObjectType
  if (!KNOWN_TYPES.includes(normalized)) {
    return {
      status: 'FAILED',
      message: `Don't have a "${type}" object yet — only "microwave" is available right now.`
    }
  }
  currentType = normalized
  win.webContents.send('ar:spawn', normalized)
  return {
    status: 'SUCCESS',
    message: `Placed a ${normalized} in the camera view. Pinch thumb+index on it to grab and move, pinch on the handle to open the door, pinch a button to press it, pinch thumb+middle and drag to rotate, or hold thumb+index+middle and spread to resize.`
  }
}

export function clear(): { status: 'SUCCESS'; message: string } {
  currentType = null
  win?.webContents.send('ar:clear')
  return { status: 'SUCCESS', message: 'Removed the object from the camera view.' }
}
