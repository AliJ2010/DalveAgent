import { useEffect, useRef, useState } from 'react'
import { HandLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { Hand, Square, Maximize2, Minimize2 } from 'lucide-react'

// Real pixel dimensions of the preview canvas, not just its on-screen CSS size — drawing at a
// higher resolution when "large" is picked keeps the bigger preview sharp instead of just
// upscaling a small blurry buffer.
const PREVIEW_SIZES = { small: { width: 240, height: 180 }, large: { width: 480, height: 360 } } as const

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
 * Webcam hand-tracking cursor — invisible until turned on by voice, then shows a small live
 * camera preview with the tracked hand's skeleton drawn over it (purely for the user to see what
 * DALVE sees; all actual cursor/click/zoom decisions happen in the main process from the raw
 * per-frame geometry this sends over IPC). Camera capture and MediaPipe's hand-landmark inference
 * both have to happen here, not in the main process — getUserMedia and WebAssembly vision models
 * are browser-standard APIs with no main-process equivalent in Electron.
 */
export function HandTrackingController(): React.JSX.Element {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [large, setLarge] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    const unsubStart = window.dalve.handTracking.onStart(() => void startTracking())
    const unsubStop = window.dalve.handTracking.onStop(() => stopTracking())
    return () => {
      unsubStart()
      unsubStop()
      stopTracking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('No video element to attach the camera to.')
      video.srcObject = stream
      await video.play()

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
    // mirrored convention the actual cursor-mapping in the main process uses, so what the user
    // sees here lines up with how their hand actually controls the cursor.
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
        if (hand) {
          pinchIndex = dist(hand[THUMB_TIP], hand[INDEX_TIP])
          pinchMiddle = dist(hand[THUMB_TIP], hand[MIDDLE_TIP])
          window.dalve.handTracking.sendFrame({
            indexX: hand[INDEX_TIP].x,
            indexY: hand[INDEX_TIP].y,
            thumbIndexDist: pinchIndex,
            thumbMiddleDist: pinchMiddle,
            spread: computeSpread(hand),
            palmY: hand[WRIST].y
          })
        }
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
      {active && (
        <div
          style={{
            position: 'fixed',
            bottom: 20,
            left: 20,
            zIndex: 99,
            borderRadius: 12,
            overflow: 'hidden',
            border: '1px solid var(--c-gold)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
          }}
        >
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZES[large ? 'large' : 'small'].width}
            height={PREVIEW_SIZES[large ? 'large' : 'small'].height}
            style={{ display: 'block' }}
          />
          <button
            onClick={() => setLarge((v) => !v)}
            title={large ? 'Shrink preview' : 'Enlarge preview'}
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 6,
              border: '1px solid rgba(212,175,55,0.5)',
              background: 'rgba(0,0,0,0.5)',
              color: 'var(--c-gold-bright)',
              cursor: 'pointer'
            }}
          >
            {large ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      )}
    </>
  )
}
