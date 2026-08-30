import { useEffect, useRef } from 'react'
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
   *  loosens into a more scattered, diffuse shell instead of its tight resting shape. Deliberately
   *  NOT a full-screen takeover: this is the same cheap per-point Canvas2D loop as everything
   *  else here, just re-projected further out and jittered, so it can never reintroduce the real
   *  lag a separate full-viewport WebGL re-render caused, and it can't fail to visually register
   *  either — every point's position genuinely changes, not just a shader uniform that might not
   *  visibly read as "different" once spread across an entire monitor. */
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const levelRef = useRef(level)
  levelRef.current = level
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const points = fibonacciSphere(pointCount)
    const radius = size * 0.38
    let angle = 0
    let raf = 0
    let pulse = 0
    let smoothedLevel = 0
    let busyEase = 0

    function draw(): void {
      if (!ctx) return
      const s = stateRef.current
      // Exponential smoothing: audio level arrives in irregular ~100-250ms bursts from a
      // completely different clock than this 60fps loop — reacting to it raw would visibly
      // stutter, so it eases toward the latest real reading instead of jumping to it.
      smoothedLevel += (levelRef.current - smoothedLevel) * 0.15
      // Rises faster than it falls — snapping into "busy" reads as an event, settling back reads
      // as calming down, matching the same rise/fall asymmetry the rest of this component uses.
      busyEase += ((busyRef.current ? 1 : 0) - busyEase) * (busyRef.current ? 0.08 : 0.05)
      const speedFactor = (s === 'listening' ? 1.6 : s === 'speaking' ? 1.15 : 0.35) + smoothedLevel * 0.8 + busyEase * 0.5
      angle += 0.0022 * speed * speedFactor
      pulse += s === 'speaking' ? 0.09 : s === 'listening' ? 0.05 : 0.015

      ctx.clearRect(0, 0, size, size)
      const cx = size / 2
      const cy = size / 2

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
        // variance reads as "it came apart". Capped low enough to stay inside this canvas's own
        // pixel bounds (a canvas clips its own drawing at its edge, unlike a DOM element) — this
        // is a deliberately CONTAINED effect, not a full-viewport one.
        const scale = breathe * radius * (1 + busyEase * (0.15 + p.seed * 0.35))
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
        const r = (1.1 + depth * 1.6 * p.perspective) * (1 + smoothedLevel * 0.35)

        ctx.beginPath()
        ctx.fillStyle = `rgba(${color},${alpha.toFixed(3)})`
        ctx.shadowColor = `rgba(${color},${(alpha * 0.6).toFixed(3)})`
        ctx.shadowBlur = depth > 0.7 ? 4 : 0
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size, pointCount, speed, color])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, display: 'block' }}
    />
  )
}
