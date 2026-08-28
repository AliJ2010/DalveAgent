import { useEffect, useRef, useState } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { Hand, Square } from 'lucide-react'

// Pinned to the exact installed @mediapipe/tasks-vision version — jsdelivr serves each version
// at its own versioned path, confirmed live to exist for this one; bumping the npm dependency
// without updating this would silently 404 on next launch.
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task'
// Normalized (0-1, relative to hand size in frame) distance between thumb and index fingertip
// below which it counts as a pinch — picked as a reasonable middle ground, not measured against
// a real hand (no camera available to tune it against here).
const PINCH_THRESHOLD = 0.06

/**
 * Webcam hand-tracking cursor — invisible by default (just a hidden <video> element and a status
 * banner when active), turned on/off by voice via handTracking.ts in the main process. Camera
 * capture and MediaPipe's hand-landmark inference both have to happen here, not in the main
 * process — getUserMedia and WebAssembly vision models are browser-standard APIs with no main-
 * process equivalent in Electron. Every detected frame's index-fingertip position and pinch state
 * gets sent to the main process over IPC, which is what actually moves the OS cursor.
 */
export function HandTrackingController(): React.JSX.Element {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
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

  function loop(landmarker: HandLandmarker, video: HTMLVideoElement): void {
    const detect = (): void => {
      if (!runningRef.current) return
      if (video.readyState >= 2) {
        const result = landmarker.detectForVideo(video, performance.now())
        const hand = result.landmarks[0]
        if (hand) {
          const indexTip = hand[8]
          const thumbTip = hand[4]
          const dx = indexTip.x - thumbTip.x
          const dy = indexTip.y - thumbTip.y
          const pinching = Math.sqrt(dx * dx + dy * dy) < PINCH_THRESHOLD
          window.dalve.handTracking.sendFrame(indexTip.x, indexTip.y, pinching)
        }
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
            {error ? `HAND TRACKING FAILED: ${error}` : 'HAND TRACKING ACTIVE — PINCH TO CLICK'}
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
    </>
  )
}
