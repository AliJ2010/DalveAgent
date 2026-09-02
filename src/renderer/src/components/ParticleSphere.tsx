import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { VoiceSessionState } from '@shared/types'

interface ParticleSphereProps {
  size: number
  state?: VoiceSessionState
  color?: string // base RGB triplet as "r,g,b"
  pointCount?: number
  speed?: number
  className?: string
  /** Real-time 0-1 amplitude of actual audio (mic input or Gemini's speech) — makes the sphere
   *  visibly breathe in sync with real voice activity, not a canned animation. Optional; sphere
   *  falls back to its normal state-driven pulse when omitted. */
  level?: number
  /** DALVE actively doing something (a tool call, an unattended autonomous task) — the sphere
   *  disintegrates and spreads across the WHOLE app window, then reconstructs once it ends. Still
   *  the same cheap per-point Canvas2D loop as the resting sphere (no WebGL, no shaders) — only
   *  the canvas's own size/position change. */
  busy?: boolean
}

interface Point {
  theta: number
  phi: number
  // Stable per-point randomness for the busy/scattered shape — computed once so the scatter
  // looks like a coordinated intentional shape forming, not particles jittering independently
  // every frame.
  seed: number
  jitterTheta: number
  jitterPhi: number
}

function fibonacciSphere(count: number): Point[] {
  const points: Point[] = []
  const offset = 2 / count
  const increment = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = i * offset - 1 + offset / 2
    const phi = i * increment
    const theta = Math.acos(y)
    points.push({
      theta,
      phi,
      seed: Math.random(),
      jitterTheta: (Math.random() - 0.5) * Math.PI,
      jitterPhi: (Math.random() - 0.5) * Math.PI * 2
    })
  }
  return points
}

// Below this, the explosion is visually settled enough to shrink the canvas back down without a
// visible pop — any lower and floating-point/frame-timing noise could flicker the transition.
const SETTLE_EPSILON = 0.02

export function ParticleSphere({
  size,
  state = 'idle',
  color = '212,175,55',
  pointCount = 420,
  speed = 1,
  className,
  level = 0,
  busy = false
}: ParticleSphereProps): React.JSX.Element {
  // A real, if unintuitive, React pitfall this hit live: conditionally wrapping the SAME JSX in
  // createPortal(...) vs. returning it directly is NOT a safe way to relocate a DOM node — a
  // portal is a structurally different element type than a plain host element at that same tree
  // position, so toggling between them makes React tear down and rebuild the whole subtree,
  // destroying the imperatively-created canvas inside it every single time "busy" changed
  // (confirmed live: the canvas vanished on every transition, leaving nothing rendered at all).
  // The fix is to ALWAYS portal to <body> and only ever change its CSS position/size — normal
  // prop/style updates, which React always handles correctly on an unchanging element type. A
  // lightweight placeholder stays in the component's real tree position purely to reserve the
  // same layout space (so gaps/centering elsewhere, e.g. VoiceView's flex column, are unaffected)
  // — the actual canvas is positioned to visually line up with wherever that placeholder is.
  const placeholderRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const levelRef = useRef(level)
  levelRef.current = level
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container!.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    if (!ctx) return () => container!.removeChild(canvas)

    const points = fibonacciSphere(pointCount)
    let angle = 0
    let raf = 0
    let pulse = 0
    let smoothedLevel = 0
    let busyEase = 0
    let dims = { width: size, height: size }
    let expanded = false

    function applyDims(width: number, height: number): void {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      dims = { width, height }
    }
    applyDims(size, size)

    /** Keeps the always-portaled container visually aligned with wherever the placeholder
     *  currently sits in normal layout flow — cheap (one getBoundingClientRect call) and run
     *  every frame so it stays correct through any layout change without a separate observer. */
    function positionToPlaceholder(): void {
      const placeholder = placeholderRef.current
      if (!placeholder) return
      const rect = placeholder.getBoundingClientRect()
      container!.style.left = `${rect.left}px`
      container!.style.top = `${rect.top}px`
      container!.style.width = `${rect.width}px`
      container!.style.height = `${rect.height}px`
    }

    container!.style.position = 'fixed'
    container!.style.pointerEvents = 'none'
    container!.style.zIndex = '1'
    positionToPlaceholder()

    function onWindowResize(): void {
      if (expanded) applyDims(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onWindowResize)

    function draw(): void {
      const s = stateRef.current
      const nowBusy = busyRef.current

      // Expand the instant a busy state starts (nothing's drawn out there yet at busyEase~0, so
      // the resize itself is invisible); only CONTRACT once the reconstruction has visually
      // finished, not the instant the flag flips, so the shrink-back doesn't cut off the animation.
      if (nowBusy && !expanded) {
        expanded = true
        container!.style.inset = '0'
        container!.style.left = ''
        container!.style.top = ''
        container!.style.width = ''
        container!.style.height = ''
        container!.style.zIndex = '4'
        container!.style.pointerEvents = 'none'
        applyDims(window.innerWidth, window.innerHeight)
      } else if (!nowBusy && expanded && busyEase < SETTLE_EPSILON) {
        expanded = false
        container!.style.inset = ''
        container!.style.zIndex = '1'
        container!.style.pointerEvents = 'none'
        applyDims(size, size)
      }
      if (!expanded) positionToPlaceholder()

      // Exponential smoothing: audio level arrives in irregular ~100-250ms bursts from a
      // completely different clock than this 60fps loop — reacting to it raw would visibly
      // stutter, so it eases toward the latest real reading instead of jumping to it.
      smoothedLevel += (levelRef.current - smoothedLevel) * 0.15
      // Rises faster than it falls — snapping into "busy" reads as an event, settling back reads
      // as calming down, matching the same rise/fall asymmetry the rest of this component uses.
      busyEase += ((nowBusy ? 1 : 0) - busyEase) * (nowBusy ? 0.08 : 0.05)
      const speedFactor = (s === 'listening' ? 1.6 : s === 'speaking' ? 1.15 : 0.35) + smoothedLevel * 0.8 + busyEase * 0.5
      angle += 0.0022 * speed * speedFactor
      pulse += s === 'speaking' ? 0.09 : s === 'listening' ? 0.05 : 0.015

      const { width, height } = dims
      ctx!.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      const radius = Math.min(width, height) * 0.38
      // How far a fully-scattered point (seed=1) can travel from center, as a multiple of
      // `radius` — enough to reach the farthest CORNER of the current canvas, so a full-screen
      // explosion genuinely covers the whole app instead of just becoming a bigger circle in the
      // middle. Reduces to a small, contained multiplier when not expanded.
      const maxReach = expanded ? Math.hypot(width, height) / 2 / radius : 1.5

      const pulseAmp =
        (s === 'speaking' ? 0.06 : s === 'listening' ? 0.03 : 0.012) + smoothedLevel * 0.14
      const breathe = 1 + Math.sin(pulse) * pulseAmp + smoothedLevel * 0.05

      const projected = points.map((p) => {
        // Scattering jitter fades in with busyEase — at rest (busyEase=0) this reduces to the
        // exact original theta/phi, so idle/listening/speaking look completely unchanged.
        const rotTheta = p.theta + p.jitterTheta * busyEase
        const rotPhi = p.phi + angle + p.jitterPhi * busyEase
        const x0 = Math.sin(rotTheta) * Math.cos(rotPhi)
        const y0 = Math.cos(rotTheta)
        const z0 = Math.sin(rotTheta) * Math.sin(rotPhi)

        // slight tilt for a more dynamic silhouette
        const tilt = 0.5
        const y = y0 * Math.cos(tilt) - z0 * Math.sin(tilt)
        const z = y0 * Math.sin(tilt) + z0 * Math.cos(tilt)
        const x = x0

        // Each point pushes out to its own distance while busy (seeded per point) rather than the
        // whole sphere uniformly inflating — a shared scale change reads as "it grew", per-point
        // variance reads as "it came apart".
        const scale = breathe * radius * (1 + busyEase * ((maxReach - 1) * (0.1 + p.seed * 0.9)))
        const perspective = 1 / (2 - z)
        return {
          x: cx + x * scale * perspective,
          y: cy + y * scale * perspective,
          z,
          perspective
        }
      })

      projected.sort((a, b) => a.z - b.z)

      for (const p of projected) {
        const depth = (p.z + 1) / 2 // 0 (back) .. 1 (front)
        const brightness = 0.15 + depth * 0.85
        const activeBoost = (s === 'idle' ? 0.7 : 1) + smoothedLevel * 0.3
        const alpha = Math.min(1, brightness * activeBoost)
        // Points get bigger as they spread out (busyEase-scaled) — spread across a whole screen
        // at the original small radius would read as "the orb vanished into faint dust" rather
        // than a deliberate explosion, the same visibility issue found and fixed in the earlier
        // WebGL version.
        const r = (1.1 + depth * 1.6 * p.perspective) * (1 + smoothedLevel * 0.35) * (1 + busyEase * 1.2)

        ctx!.beginPath()
        ctx!.fillStyle = `rgba(${color},${alpha.toFixed(3)})`
        ctx!.shadowColor = `rgba(${color},${(alpha * 0.6).toFixed(3)})`
        ctx!.shadowBlur = depth > 0.7 ? 4 : 0
        ctx!.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx!.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onWindowResize)
      container!.removeChild(canvas)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointCount, speed, color])

  return (
    <>
      <div ref={placeholderRef} className={className} style={{ width: size, height: size }} />
      {createPortal(<div ref={containerRef} style={{ position: 'fixed' }} />, document.body)}
    </>
  )
}
