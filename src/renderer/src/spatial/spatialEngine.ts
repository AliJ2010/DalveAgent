import * as THREE from 'three'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { ArBlueprint, ArBlueprintPart } from '@shared/types'

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
  doorTarget: THREE.Object3D | null
}

function makeGeometry(part: ArBlueprintPart): THREE.BufferGeometry {
  const [a, b, c] = part.size
  if (part.shape === 'cylinder') return new THREE.CylinderGeometry(Math.max(0.001, a), Math.max(0.001, b), Math.max(0.001, c), 24)
  // Always a unit sphere — see applyShapeScale, which stretches it per-axis. THREE.SphereGeometry
  // only ever takes one radius; building a real egg/spoon-head/squashed-lid shape needs all three
  // of a part's size components to matter, not just size[0] with the other two silently ignored.
  if (part.shape === 'sphere') return new THREE.SphereGeometry(1, 20, 16)
  return new THREE.BoxGeometry(Math.max(0.001, a), Math.max(0.001, b), Math.max(0.001, c))
}

/** A sphere is the one shape whose geometry can't encode 3 independent dimensions on its own
 *  (box/cylinder already do, via their own constructor args) — this is what turns a unit sphere
 *  into an ellipsoid matching the part's actual [x,y,z] size. */
function applyShapeScale(mesh: THREE.Mesh, part: ArBlueprintPart): void {
  if (part.shape !== 'sphere') return
  const [a, b, c] = part.size
  mesh.scale.set(Math.max(0.001, a), Math.max(0.001, b), Math.max(0.001, c))
}

/**
 * Builds a real THREE.Group hierarchy from a blueprint — the SAME generic path handles a
 * hand-authored built-in (see BUILTIN_BLUEPRINTS below) and one an AI just generated from a
 * screenshot, so "unlimited object types" is a content problem (more/better blueprints), not an
 * engine one. A part attaches to whatever `parentId` names; a 'door' part gets a hinge pivot Group
 * inserted so it swings around its hinge axis instead of spinning in place, and anything (like a
 * handle) that names a door as ITS parent attaches to that same pivot, so they move together.
 */
function buildFromBlueprint(blueprint: ArBlueprint): THREE.Group {
  const root = new THREE.Group()
  const nodesById = new Map<string, THREE.Object3D>()
  const remaining = new Map(blueprint.parts.map((p) => [p.id, p]))

  function attachNode(part: ArBlueprintPart, node: THREE.Object3D, parent: THREE.Object3D): void {
    node.position.set(...part.position)
    if (part.rotation) node.rotation.set(...part.rotation)
    parent.add(node)
    nodesById.set(part.id, node)
  }

  function buildPart(part: ArBlueprintPart, parent: THREE.Object3D): void {
    if (part.role === 'door') {
      const pivot = new THREE.Group()
      attachNode(part, pivot, parent)
      const mesh = new THREE.Mesh(
        makeGeometry(part),
        new THREE.MeshStandardMaterial({
          color: part.color,
          metalness: part.metalness ?? 0.3,
          roughness: part.roughness ?? 0.4,
          transparent: (part.roughness ?? 1) < 0.3,
          opacity: (part.roughness ?? 1) < 0.3 ? 0.55 : 1
        })
      )
      mesh.position.set(...(part.hingeOffset ?? [0, 0, 0]))
      mesh.userData.part = 'door'
      applyShapeScale(mesh, part)
      pivot.add(mesh)
      // Other parts (a handle) that name this door as their parent attach to the PIVOT, not the
      // mesh, so they swing together — a handle keeps its position relative to the hinge axis,
      // matching how the mesh's own hingeOffset already works.
      return
    }
    const mesh = new THREE.Mesh(
      makeGeometry(part),
      new THREE.MeshStandardMaterial({ color: part.color, metalness: part.metalness ?? 0.3, roughness: part.roughness ?? 0.4 })
    )
    mesh.userData.part = part.role ?? 'static'
    if (part.role === 'button') {
      mesh.userData.buttonRestZ = part.position[2]
    }
    applyShapeScale(mesh, part)
    attachNode(part, mesh, parent)
  }

  // Multi-pass resolution so parts can be listed in any order (matters most for AI-generated
  // JSON, which has no reason to output parents before children) — each pass attaches whatever
  // now has a resolved parent, until nothing changes; anything left over (a bad/cyclic parentId)
  // falls back to the root rather than silently vanishing.
  let progressed = true
  while (remaining.size > 0 && progressed) {
    progressed = false
    for (const [id, part] of Array.from(remaining.entries())) {
      const parentNode = part.parentId ? nodesById.get(part.parentId) : root
      if (part.parentId && !parentNode) continue
      buildPart(part, parentNode ?? root)
      remaining.delete(id)
      progressed = true
    }
  }
  for (const part of remaining.values()) buildPart(part, root)

  // A handle's hinge target is whichever door pivot its OWN parentId points at — resolved after
  // the tree is built since the handle and its door can be built in either order above.
  for (const part of blueprint.parts) {
    if (part.role !== 'handle' || !part.parentId) continue
    const handleNode = nodesById.get(part.id)
    const doorPivot = nodesById.get(part.parentId)
    if (handleNode && doorPivot) handleNode.userData.hingeTarget = doorPivot
  }

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
  private buttonFlash = new Map<THREE.Object3D, number>()
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

  spawn(blueprint: ArBlueprint): void {
    this.clear()
    this.object = buildFromBlueprint(blueprint)
    this.scene.add(this.object)
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
    this.buttonFlash.clear()
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
        const targetHit = this.hitTest(ndcX, ndcY)
        const part = targetHit?.userData.part as string | undefined
        if (part === 'handle') {
          const hingeTarget = targetHit?.userData.hingeTarget as THREE.Object3D | undefined
          if (hingeTarget) {
            this.grab = {
              mode: 'door',
              startHandX: handX,
              startHandY: handY,
              startObjectX: 0,
              startObjectY: 0,
              startRotationY: 0,
              startDoorAngle: hingeTarget.rotation.y,
              startSpread: spread,
              startScale: 1,
              doorTarget: hingeTarget
            }
          }
        } else if (part === 'button') {
          if (targetHit) this.buttonFlash.set(targetHit, performance.now())
        } else if (part !== undefined) {
          // Anything else grabbable (body, or any decorative/static part covering the front of
          // the object — a closed door's glass, a lampshade) moves the whole object. Real objects
          // don't have one narrow "correct" spot to grab; direct feedback confirmed a closed
          // door's glass alone covers most of a front face and needs to work as a grab target too.
          this.grab = {
            mode: 'move',
            startHandX: handX,
            startHandY: handY,
            startObjectX: this.object.position.x,
            startObjectY: this.object.position.y,
            startRotationY: 0,
            startDoorAngle: 0,
            startSpread: spread,
            startScale: this.object.scale.x,
            doorTarget: null
          }
        }
      } else if (pinchMiddle < PINCH_ENGAGE && hoveredPart === undefined) {
        // Rotate engages off its own hit test (needs the shared `hit` above to require BOTH
        // pinches released, so it doesn't steal a move-grab already in progress).
        const part = this.hitTest(ndcX, ndcY)?.userData.part as string | undefined
        if (part !== undefined && part !== 'handle' && part !== 'button') {
          this.grab = {
            mode: 'rotate',
            startHandX: handX,
            startHandY: handY,
            startObjectX: 0,
            startObjectY: 0,
            startRotationY: this.object.rotation.y,
            startDoorAngle: 0,
            startSpread: spread,
            startScale: 1,
            doorTarget: null
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
      } else if (this.grab.mode === 'door' && this.grab.doorTarget) {
        // A leftward drag (handX decreasing, dx negative) must DECREASE rotation.y — confirmed
        // live via a real interaction test: the opposite sign only ever clamped back to closed,
        // because pulling toward the hinge (the physically correct "open" motion) needs to swing
        // the pivot negative, not positive.
        const dx = handX - this.grab.startHandX
        this.grab.doorTarget.rotation.y = Math.min(
          0,
          Math.max(-DOOR_MAX_OPEN, this.grab.startDoorAngle + dx * DOOR_DRAG_SENSITIVITY)
        )
      }
    }
  }

  private loop = (): void => {
    if (this.disposed) return
    if (this.object) {
      const now = performance.now()
      this.object.traverse((child) => {
        if (child.userData.part !== 'button') return
        const pressedAt = this.buttonFlash.get(child)
        const restZ = child.userData.buttonRestZ as number
        if (pressedAt !== undefined && now - pressedAt < 220) {
          child.position.z = restZ - 0.025
        } else {
          child.position.z = restZ
          if (pressedAt !== undefined) this.buttonFlash.delete(child)
        }
      })
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
