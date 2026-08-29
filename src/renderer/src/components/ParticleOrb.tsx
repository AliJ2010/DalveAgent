import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ParticleOrbEngine, type OrbState } from '../particles/particleOrbEngine'

interface ParticleOrbProps {
  size: number
  state?: OrbState
  color?: string
  pointCount?: number
  className?: string
  /** Real-time 0-1 amplitude of actual audio (mic input or DALVE's own speech) — the sphere
   *  visibly breathes in sync with real voice activity, not a canned animation. */
  level?: number
}

/**
 * GPU (WebGL/Three.js) replacement for the old Canvas2D ParticleSphere — same default look for
 * idle/listening/speaking (see particleOrbEngine.ts's port of the original speed/pulse/breathe
 * formulas), plus real states a CPU-bound per-frame ctx.arc() loop couldn't scale to: 'thinking'
 * (particles peel into a swirling orbit) and 'unbound' (the sphere disintegrates and spreads
 * across the whole interface — this component itself expands to fill the viewport for that state
 * so the particles have real room to roam, then shrinks back once reconstruction finishes).
 */
export function ParticleOrb({
  size,
  state = 'idle',
  color = '212,175,55',
  pointCount = 1800,
  className,
  level = 0
}: ParticleOrbProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ParticleOrbEngine | null>(null)
  const unbound = state === 'unbound'

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const engine = new ParticleOrbEngine(container, { pointCount, color })
    engineRef.current = engine

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      engine.resize(width, height)
      // Spread scales with however much room the container actually has right now, so "unbound"
      // fills whatever the real viewport is rather than a hardcoded distance.
      engine.setSpread((Math.min(width, height) / size) * 3.2)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      engine.dispose()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointCount])

  useEffect(() => {
    engineRef.current?.setState(state)
  }, [state])

  useEffect(() => {
    engineRef.current?.setAudioLevel(level)
  }, [level])

  useEffect(() => {
    engineRef.current?.setColor(color)
  }, [color])

  const content = (
    <div
      ref={containerRef}
      className={className}
      style={
        unbound
          ? { position: 'fixed', inset: 0, zIndex: 4, transition: 'opacity 200ms ease', pointerEvents: 'none' }
          : { width: size, height: size, transition: 'opacity 200ms ease' }
      }
    />
  )

  // `position: fixed` only anchors to the real viewport if no ancestor has its own transform —
  // VoiceView's centering wrapper does, which would otherwise trap "unbound" inside that
  // wrapper's small bounding box instead of actually filling the screen. A portal moves the same
  // DOM node (and the WebGL canvas already appended inside it) straight to <body> without
  // unmounting the Three.js engine, so the transition is seamless either direction.
  return unbound ? createPortal(content, document.body) : content
}
