import * as THREE from 'three'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export type ArObjectType = 'microwave'

/** One tracked-hand frame's gesture distances, same shape HandTrackingController already
 *  computes every frame for the main-process cursor path — reused here so both consumers read
 *  off the exact same numbers instead of two slightly-different pinch measurements drifting apart. */
export interface HandGesture {
  hand: NormalizedLandmark[] | undefined
  pinchIndex: number
  pinchMiddle: number
  spread: number
}

const PINCH_ENGAGE = 0.055
const PINCH_RELEASE = 0.09
const DOOR_MAX_OPEN = 1.7 // radians, ~97 degrees
const DOOR_DRAG_SENSITIVITY = 6
const ROTATE_SENSITIVITY = 5
const SCALE_MIN = 0.5
const SCALE_MAX = 2.2
// Hand-to-world mapping for whole-object drag — normalized fingertip (0-1) maps onto this many
// world units so a natural hand range across the camera frame moves the object across the whole
// visible interaction area rather than a tiny sliver of it.
const PLANE_WIDTH = 3.6
const PLANE_HEIGHT = 2.4

type GrabMode = 'move' | 'rotate' | 'door' | null

interface GrabState {
  mode: GrabMode
  startHandX: number
  startHandY: number
  startObjectX: number
  startObjectY: number
  startRotationY: number
  startDoorAngle: number
  startSpread: number
  startScale: number
}

function makeMicrowave(): THREE.Group {
  const root = new THREE.Group()

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1c1a16, metalness: 0.6, roughness: 0.35 })
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.25 })
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a0908,
    metalness: 0.2,
    roughness: 0.1,
    transparent: true,
    opacity: 0.55
  })

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1.1), bodyMat)
  body.userData.part = 'body'
  root.add(body)

  // Door hinges on its LEFT edge, so it's parented to a pivot Group placed at that edge (not at
  // the door's own center) — rotating the pivot swings the door like a real hinge instead of
  // spinning it in place around its own middle.
  const doorPivot = new THREE.Group()
  doorPivot.position.set(-0.62, 0, 0.56)
  root.add(doorPivot)

  const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.86, 0.05), glassMat)
  door.position.set(0.6, 0, 0)
  door.userData.part = 'door'
  doorPivot.add(door)

  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.12), accentMat)
  handle.position.set(1.14, 0, 0.05)
  handle.userData.part = 'handle'
  doorPivot.add(handle)

  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.9, 0.04), bodyMat)
  panel.position.set(0.66, 0, 0.57)
  root.add(panel)

  const buttonColors = [0xe05a5a, 0x6fe08a, 0xd4af37]
  for (let i = 0; i < 3; i++) {
    const btn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16),
      new THREE.MeshStandardMaterial({ color: buttonColors[i], metalness: 0.4, roughness: 0.4 })
    )
    btn.rotation.x = Math.PI / 2
    btn.position.set(0.66, 0.28 - i * 0.28, 0.6)
    btn.userData.part = 'button'
    btn.userData.buttonIndex = i
    btn.userData.restZ = btn.position.z
    root.add(btn)
  }

  const turntable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.02, 32),
    new THREE.MeshStandardMaterial({ color: 0x3a3630, metalness: 0.3, roughness: 0.5 })
  )
  turntable.rotation.x = Math.PI / 2
  turntable.position.set(0.15, -0.35, 0.4)
  turntable.userData.part = 'turntable'
  root.add(turntable)

  root.userData.doorPivot = doorPivot
  root.userData.turntable = turntable
  return root
}

/**
 * Spatial AR scene compositing a manipulable 3D object over the live camera feed, driven by the
 * SAME per-frame hand landmarks HandTrackingController already gets from MediaPipe for cursor
 * control — real 3D hit-testing via raycasting decides which part (body/handle/button) a pinch is
 * touching, and grab/rotate/door/press are genuine held-state gestures with hysteresis, not one-
 * shot triggers. Renders as its own transparent-background WebGL canvas layered on top of the
 * existing 2D preview canvas so both draw over the same mirrored video frame.
 */
export class SpatialEngine {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private object: THREE.Group | null = null
  private grab: GrabState | null = null
  private buttonFlash = new Map<number, number>()
  private rafId: number | null = null
  private disposed = false

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
    this.camera.position.set(0, 0, 5)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(2, 3, 4)
    this.scene.add(key)

    this.resize(container.clientWidth || 320, container.clientHeight || 240)
    this.loop()
  }

  spawn(type: ArObjectType): void {
    this.clear()
    if (type === 'microwave') this.object = makeMicrowave()
    if (this.object) this.scene.add(this.object)
  }

  clear(): void {
    if (this.object) {
      this.scene.remove(this.object)
      this.object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const mat = child.material
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else mat.dispose()
        }
      })
    }
    this.object = null
    this.grab = null
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private hitTest(ndcX: number, ndcY: number): THREE.Object3D | null {
    if (!this.object) return null
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const hits = this.raycaster.intersectObject(this.object, true)
    return hits.length > 0 ? hits[0].object : null
  }

  /** Called once per hand-tracking animation frame. `hand` landmarks are the raw MediaPipe
   *  normalized (0-1) coordinates, mirrored the same way the 2D preview already draws them. */
  updateHand(gesture: HandGesture): void {
    if (!this.object) return
    const { hand, pinchIndex, pinchMiddle, spread } = gesture
    if (!hand) {
      this.grab = null
      return
    }

    const indexTip = hand[8]
    // Mirror to match the preview's mirrored draw so grabbing "looks right" — moving your hand
    // right moves the object right on screen, not left.
    const handX = 1 - indexTip.x
    const handY = indexTip.y
    const ndcX = handX * 2 - 1
    const ndcY = -(handY * 2 - 1)

    const hit = pinchIndex >= PINCH_ENGAGE && pinchMiddle >= PINCH_ENGAGE ? this.hitTest(ndcX, ndcY) : null
    const hoveredPart = hit?.userData.part as string | undefined

    if (!this.grab) {
      if (pinchIndex < PINCH_ENGAGE) {
        const part = this.hitTest(ndcX, ndcY)?.userData.part as string | undefined
        // The closed door's glass sits directly in front of most of the body's front face — a
        // pinch dead-center on the object is just as likely to land on the door as the body
        // (confirmed live: identical coordinates hit one or the other depending on tiny
        // sub-pixel differences). Grabbing the glass front to move the whole object is exactly
        // what real-world intuition expects (you don't need to find the one bare edge of the
        // body specifically), so a door hit falls through to the same move-grab as a body hit —
        // the handle stays the only way to open it.
        if (part === 'body' || part === 'door') {
          this.grab = {
            mode: 'move',
            startHandX: handX,
            startHandY: handY,
            startObjectX: this.object.position.x,
            startObjectY: this.object.position.y,
            startRotationY: 0,
            startDoorAngle: 0,
            startSpread: spread,
            startScale: this.object.scale.x
          }
        } else if (part === 'handle') {
          const doorPivot = this.object.userData.doorPivot as THREE.Group
          this.grab = {
            mode: 'door',
            startHandX: handX,
            startHandY: handY,
            startObjectX: 0,
            startObjectY: 0,
            startRotationY: 0,
            startDoorAngle: doorPivot.rotation.y,
            startSpread: spread,
            startScale: 1
          }
        } else if (part === 'button') {
          const btn = this.hitTest(ndcX, ndcY)
          const idx = btn?.userData.buttonIndex as number | undefined
          if (idx !== undefined) this.buttonFlash.set(idx, performance.now())
        }
      } else if (pinchMiddle < PINCH_ENGAGE && hoveredPart === undefined) {
        // Rotate engages off a body hover check separately below (needs its own hit test since
        // the shared `hit` above requires BOTH pinches released to avoid stealing a move-grab).
        const part = this.hitTest(ndcX, ndcY)?.userData.part as string | undefined
        if (part === 'body' || part === 'door') {
          this.grab = {
            mode: 'rotate',
            startHandX: handX,
            startHandY: handY,
            startObjectX: 0,
            startObjectY: 0,
            startRotationY: this.object.rotation.y,
            startDoorAngle: 0,
            startSpread: spread,
            startScale: 1
          }
        }
      }
    } else {
      const releaseDist = this.grab.mode === 'rotate' ? pinchMiddle : pinchIndex
      if (releaseDist > PINCH_RELEASE) {
        this.grab = null
      } else if (this.grab.mode === 'move') {
        const dx = (handX - this.grab.startHandX) * PLANE_WIDTH
        const dy = -(handY - this.grab.startHandY) * PLANE_HEIGHT
        this.object.position.x = this.grab.startObjectX + dx
        this.object.position.y = this.grab.startObjectY + dy
        // Resize piggybacks on an active move-grab via the existing 3-finger spread signal, so
        // scaling and moving can happen in the same held gesture instead of a separate mode.
        const scaleDelta = (spread - this.grab.startSpread) * 3
        const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, this.grab.startScale + scaleDelta))
        this.object.scale.setScalar(scale)
      } else if (this.grab.mode === 'rotate') {
        const dx = handX - this.grab.startHandX
        this.object.rotation.y = this.grab.startRotationY + dx * ROTATE_SENSITIVITY
      } else if (this.grab.mode === 'door') {
        // The hinge is on the object's left edge and the handle on the right — as the door swings
        // open (rotation.y going negative, see makeMicrowave's geometry), the handle's world
        // position arcs toward the hinge, which projects to moving LEFT on screen. So a leftward
        // drag (handX decreasing, dx negative) must DECREASE rotation.y — a `-` here would instead
        // require a rightward "push away from the hinge" to open it, which is backwards from how
        // pulling a handle actually reads (confirmed via a live interaction test where this exact
        // sign was wrong and the door only ever clamped to closed).
        const dx = handX - this.grab.startHandX
        const doorPivot = this.object.userData.doorPivot as THREE.Group
        doorPivot.rotation.y = Math.min(
          0,
          Math.max(-DOOR_MAX_OPEN, this.grab.startDoorAngle + dx * DOOR_DRAG_SENSITIVITY)
        )
      }
    }
  }

  private loop = (): void => {
    if (this.disposed) return
    if (this.object) {
      const turntable = this.object.userData.turntable as THREE.Mesh | undefined
      if (turntable) turntable.rotation.z += 0.01

      const now = performance.now()
      for (const child of this.object.children) {
        if (child.userData.part !== 'button') continue
        const pressedAt = this.buttonFlash.get(child.userData.buttonIndex)
        const restZ = child.userData.restZ as number
        if (pressedAt !== undefined && now - pressedAt < 220) {
          child.position.z = restZ - 0.025
        } else {
          child.position.z = restZ
          if (pressedAt !== undefined) this.buttonFlash.delete(child.userData.buttonIndex)
        }
      }
    }
    this.renderer.render(this.scene, this.camera)
    this.rafId = requestAnimationFrame(this.loop)
  }

  dispose(): void {
    this.disposed = true
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.clear()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}
