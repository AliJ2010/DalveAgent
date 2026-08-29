import { useEffect, useRef, useState } from 'react'
import { HandLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { Hand, Square, Move } from 'lucide-react'
import { SpatialEngine } from '../spatial/spatialEngine'
import type { ArBlueprint } from '@shared/types'

// Free-form panel geometry, not a fixed size-cycle — per direct request to "grow the camera as
// much as I want and move it and put it where I want". The canvas's internal draw resolution stays
// fixed (see CAPTURE_*) so the video/skeleton stay sharp; only the on-screen CSS box scales, the
// same way a <video> or <img> scales independent of its source resolution.
const CAPTURE_WIDTH = 640
const CAPTURE_HEIGHT = 480
const MIN_PANEL_WIDTH = 220
const MIN_PANEL_HEIGHT = 165
const MAX_PANEL_WIDTH = 1000
const MAX_PANEL_HEIGHT = 750
const DEFAULT_PANEL = { left: 20, top: 20, width: 360, height: 270 }
const PANEL_GEOMETRY_KEY = 'dalve-hand-tracking-panel-v2'

interface PanelGeometry {
  left: number
  top: number
  width: number
  height: number
}

function loadPanelGeometry(): PanelGeometry {
  try {
    const raw = localStorage.getItem(PANEL_GEOMETRY_KEY)
    if (!raw) return DEFAULT_PANEL
    const parsed = JSON.parse(raw) as Partial<PanelGeometry>
    if (
      typeof parsed.left === 'number' &&
      typeof parsed.top === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return parsed as PanelGeometry
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_PANEL
}

// Pinned to the exact installed @mediapipe/tasks-vision version — jsdelivr serves each version
// at its own versioned path, confirmed live to exist for this one; bumping the npm dependency
// without updating this would silently 404 on next launch.
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task'

// Hand landmark indices (MediaPipe's fixed 21-point hand model).
const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8
const MIDDLE_TIP = 12
const RING_TIP = 16
const PINKY_TIP = 20

function dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Average fingertip-to-wrist distance across the four non-thumb fingers — a "how open is the
 *  hand" signal that's robust to which specific finger moves, unlike a single two-point measure. */
function computeSpread(hand: NormalizedLandmark[]): number {
  const wrist = hand[WRIST]
  const tips = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]
  return tips.reduce((sum, i) => sum + dist(wrist, hand[i]), 0) / tips.length
}

/**
 * Webcam hand-tracking cursor — invisible until turned on by voice, then shows a live camera
 * preview with the tracked hand's skeleton drawn over it (purely for the user to see what DALVE
 * sees; all actual cursor/click/zoom decisions happen in the main process from the raw per-frame
 * geometry this sends over IPC). The same per-frame landmarks also drive an optional spatial AR
 * layer (see SpatialEngine) that composites a manipulable 3D object on top of this same feed —
 * one camera + one MediaPipe loop feeding two consumers, not two separate camera pipelines.
 * Camera capture and MediaPipe inference both have to happen here, not in the main process —
 * getUserMedia and WebAssembly vision models are browser-standard APIs with no main-process
 * equivalent in Electron.
 */
export function HandTrackingController(): React.JSX.Element {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelGeometry>(loadPanelGeometry)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const spatialContainerRef = useRef<HTMLDivElement | null>(null)
  const spatialEngineRef = useRef<SpatialEngine | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const panelRef = useRef(panel)
  panelRef.current = panel

  useEffect(() => {
    const unsubStart = window.dalve.handTracking.onStart(() => void startTracking())
    const unsubStop = window.dalve.handTracking.onStop(() => stopTracking())
    const unsubArSpawn = window.dalve.ar.onSpawn((blueprint) => {
      spatialEngineRef.current?.spawn(blueprint as ArBlueprint)
    })
    const unsubArClear = window.dalve.ar.onClear(() => {
      spatialEngineRef.current?.clear()
    })
    return () => {
      unsubStart()
      unsubStop()
      unsubArSpawn()
      unsubArClear()
      stopTracking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The spatial engine mounts once and lives for the component's whole lifetime (not just while
  // tracking is active) so a spawn arriving right as tracking starts never races an engine that
  // doesn't exist yet.
  useEffect(() => {
    const container = spatialContainerRef.current
    if (!container) return
    const engine = new SpatialEngine(container)
    spatialEngineRef.current = engine
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      engine.resize(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      engine.dispose()
      spatialEngineRef.current = null
    }
  }, [])

  function persistPanel(next: PanelGeometry): void {
    setPanel(next)
    try {
      localStorage.setItem(PANEL_GEOMETRY_KEY, JSON.stringify(next))
    } catch {
      // best-effort only
    }
  }

  function startDrag(e: React.PointerEvent): void {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, ...panelRef.current }
    function onMove(ev: PointerEvent): void {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const left = Math.min(Math.max(0, start.left + dx), window.innerWidth - 80)
      const top = Math.min(Math.max(0, start.top + dy), window.innerHeight - 40)
      persistPanel({ ...panelRef.current, left, top })
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startResize(e: React.PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, ...panelRef.current }
    function onMove(ev: PointerEvent): void {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const width = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, start.width + dx))
      const height = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, start.height + dy))
      persistPanel({ ...panelRef.current, width, height })
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  async function ensureLandmarker(): Promise<HandLandmarker> {
    if (landmarkerRef.current) return landmarkerRef.current
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    const landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: 'VIDEO',
      numHands: 1
    })
    landmarkerRef.current = landmarker
    return landmarker
  }

  async function startTracking(): Promise<void> {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('No video element to attach the camera to.')
      video.srcObject = stream
      await video.play()
      // A camera can die mid-session — permission revoked, device unplugged, OS reclaims it —
      // with nothing else here noticing. Without this, main process's "active" flag stays true
      // forever after that, so a later "is hand tracking on" claim has no way to be honest.
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => stopTracking()
      })

      const landmarker = await ensureLandmarker()
      runningRef.current = true
      setActive(true)
      loop(landmarker, video)
    } catch (err) {
      console.error('[handTracking] failed to start:', err)
      setError(err instanceof Error ? err.message : 'Could not start the camera.')
      stopTracking()
    }
  }

  function drawPreview(hand: NormalizedLandmark[] | undefined, video: HTMLVideoElement, pinchIndex: number, pinchMiddle: number): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    // Mirror the whole draw so the preview reads like looking in a mirror — matching the same
    // mirrored convention the actual cursor-mapping in the main process (and the spatial engine's
    // hand-to-world mapping) uses, so what the user sees here lines up with how their hand
    // controls the cursor and any placed 3D object.
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    if (hand) {
      ctx.strokeStyle = 'rgba(212, 175, 55, 0.8)'
      ctx.lineWidth = 2
      for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
        const a = hand[start]
        const b = hand[end]
        ctx.beginPath()
        ctx.moveTo(a.x * canvas.width, a.y * canvas.height)
        ctx.lineTo(b.x * canvas.width, b.y * canvas.height)
        ctx.stroke()
      }
      hand.forEach((pt, i) => {
        // Green when that finger's pinch is engaged — real visual confirmation of exactly when a
        // click registers, not just a generic skeleton overlay.
        const isIndexTip = i === INDEX_TIP
        const isMiddleTip = i === MIDDLE_TIP
        const engaged = (isIndexTip && pinchIndex < 0.06) || (isMiddleTip && pinchMiddle < 0.06)
        ctx.fillStyle = engaged ? '#6fe08a' : '#f2d06b'
        ctx.beginPath()
        ctx.arc(pt.x * canvas.width, pt.y * canvas.height, isIndexTip || isMiddleTip ? 5 : 3, 0, Math.PI * 2)
        ctx.fill()
      })
    }
    ctx.restore()
  }

  function loop(landmarker: HandLandmarker, video: HTMLVideoElement): void {
    const detect = (): void => {
      if (!runningRef.current) return
      if (video.readyState >= 2) {
        const result = landmarker.detectForVideo(video, performance.now())
        const hand = result.landmarks[0]
        let pinchIndex = 1
        let pinchMiddle = 1
        let spread = 0
        if (hand) {
          pinchIndex = dist(hand[THUMB_TIP], hand[INDEX_TIP])
          pinchMiddle = dist(hand[THUMB_TIP], hand[MIDDLE_TIP])
          spread = computeSpread(hand)
          window.dalve.handTracking.sendFrame({
            indexX: hand[INDEX_TIP].x,
            indexY: hand[INDEX_TIP].y,
            thumbIndexDist: pinchIndex,
            thumbMiddleDist: pinchMiddle,
            indexMiddleDist: dist(hand[INDEX_TIP], hand[MIDDLE_TIP]),
            spread,
            palmY: hand[WRIST].y
          })
        }
        spatialEngineRef.current?.updateHand({ hand, pinchIndex, pinchMiddle, spread })
        drawPreview(hand, video, pinchIndex, pinchMiddle)
      }
      rafRef.current = requestAnimationFrame(detect)
    }
    detect()
  }

  function stopTracking(): void {
    runningRef.current = false
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setActive(false)
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      {(active || error) && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '8px 16px',
            background: error ? 'rgba(224,90,90,0.14)' : 'rgba(212,175,55,0.14)',
            borderBottom: `1px solid ${error ? '#e05a5a' : 'var(--c-gold)'}`,
            backdropFilter: 'blur(6px)'
          }}
        >
          <Hand size={14} color={error ? '#e05a5a' : 'var(--c-gold-bright)'} />
          <span className="tracked-label" style={{ color: 'var(--c-text-1)', fontSize: 11 }}>
            {error
              ? `HAND TRACKING FAILED: ${error}`
              : 'HAND TRACKING ACTIVE — PINCH THUMB+INDEX TO CLICK (HOLD TO DRAG), THUMB+MIDDLE TO RIGHT-CLICK'}
          </span>
          {active && (
            <button
              onClick={() => void window.dalve.handTracking.stop()}
              className="tracked-label"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginLeft: 8,
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid #e05a5a',
                color: '#e05a5a',
                fontSize: 10
              }}
            >
              <Square size={10} fill="#e05a5a" />
              STOP
            </button>
          )}
        </div>
      )}
      {/* Always mounted (not just while `active`) so the spatial engine underneath is alive and
          ready the instant tracking starts, but visually hidden until then. */}
      <div
        style={{
          position: 'fixed',
          left: panel.left,
          top: panel.top,
          width: panel.width,
          height: panel.height,
          zIndex: 99,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--c-gold)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          display: active ? 'block' : 'none'
        }}
      >
        <canvas
          ref={canvasRef}
          width={CAPTURE_WIDTH}
          height={CAPTURE_HEIGHT}
          style={{ display: 'block', width: '100%', height: '100%' }}
        />
        {/* Transparent WebGL overlay for any placed 3D object, composited over the same mirrored
            video frame the 2D canvas above just drew — pointer-events stay off so it never
            intercepts drag/resize handling on the panel underneath it. */}
        <div
          ref={spatialContainerRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        />
        <div
          onPointerDown={startDrag}
          title="Drag to move"
          style={{
            position: 'absolute',
            top: 6,
            left: 6,
            display: 'flex',
            alignItems: 'center',
            padding: 4,
            borderRadius: 6,
            background: 'rgba(0,0,0,0.5)',
            color: 'var(--c-gold-bright)',
            cursor: 'move'
          }}
        >
          <Move size={12} />
        </div>
        <div
          onPointerDown={startResize}
          title="Drag to resize"
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 18,
            height: 18,
            cursor: 'nwse-resize',
            background:
              'linear-gradient(135deg, transparent 50%, rgba(212,175,55,0.6) 50%, rgba(212,175,55,0.6) 65%, transparent 65%, transparent 80%, rgba(212,175,55,0.6) 80%)'
          }}
        />
      </div>
    </>
  )
}
