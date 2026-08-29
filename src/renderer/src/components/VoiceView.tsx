import { useEffect, useMemo, useState } from 'react'
import { ParticleOrb } from './ParticleOrb'
import type { OrbState } from '../particles/particleOrbEngine'
import { BackgroundSpheres } from './BackgroundSpheres'
import { AgentSwitcher } from './AgentSwitcher'
import { useVoiceStore } from '../state/voiceStore'
import { useAutonomousTaskStore } from '../state/autonomousTaskStore'
import { useActiveAgentAccent } from '../lib/useActiveAgentAccent'
import { hexToRgbString } from '../lib/color'
import { formatActionLabel } from '../lib/formatLabel'

const TOPBAR_HEIGHT = 48
// A real tool call or autonomous task already forces the orb into its full-screen unbound
// "explosion" — this adds a purely ambient, unpredictable version of the same thing so the orb
// doesn't ONLY ever explode when something is happening, per direct feedback. Random within a
// wide window so it never reads as a fixed interval.
const RANDOM_BURST_MIN_DELAY_MS = 18_000
const RANDOM_BURST_MAX_DELAY_MS = 55_000
const RANDOM_BURST_MIN_DURATION_MS = 2_500
const RANDOM_BURST_MAX_DURATION_MS = 4_500

export function VoiceView(): React.JSX.Element {
  const sessionState = useVoiceStore((s) => s.sessionState)
  const toolActive = useVoiceStore((s) => s.toolActive)
  const toolActiveLabel = useVoiceStore((s) => s.toolActiveLabel)
  const audioLevel = useVoiceStore((s) => s.audioLevel)
  const autonomousActive = useAutonomousTaskStore((s) => s.active)
  const accent = useActiveAgentAccent()
  const [randomBurst, setRandomBurst] = useState(false)

  const sphereColor = hexToRgbString(accent.hex)
  const activeLabel = accent.name.toUpperCase().split('').join(' ')

  useEffect(() => {
    let delayTimer: ReturnType<typeof setTimeout>
    let durationTimer: ReturnType<typeof setTimeout>
    function scheduleNext(): void {
      const delay = RANDOM_BURST_MIN_DELAY_MS + Math.random() * (RANDOM_BURST_MAX_DELAY_MS - RANDOM_BURST_MIN_DELAY_MS)
      delayTimer = setTimeout(() => {
        setRandomBurst(true)
        const duration =
          RANDOM_BURST_MIN_DURATION_MS + Math.random() * (RANDOM_BURST_MAX_DURATION_MS - RANDOM_BURST_MIN_DURATION_MS)
        durationTimer = setTimeout(() => {
          setRandomBurst(false)
          scheduleNext()
        }, duration)
      }, delay)
    }
    scheduleNext()
    return () => {
      clearTimeout(delayTimer)
      clearTimeout(durationTimer)
    }
  }, [])

  // Any real activity (a tool executing, an autonomous task running unattended) OR a random
  // ambient burst all drive the SAME full-screen unbound "explosion" — there's no separate boxed-
  // in "thinking" visual anymore. Direct feedback was that the action-triggered version stayed
  // confined to a small square instead of actually flying across the screen, and that it should
  // also happen unpredictably, not just when something is actually running.
  const orbState: OrbState = useMemo(() => {
    if (autonomousActive || toolActive || randomBurst) return 'unbound'
    return sessionState
  }, [autonomousActive, toolActive, randomBurst, sessionState])

  return (
    <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
      <BackgroundSpheres />

      {/*
        Centered on the VIEWPORT, not this box. This box's own width already excludes the
        56px sidebar (it's a flex sibling of it), so centering "within it" put the sphere
        28px right of true center — correct-looking at a glance, wrong under measurement.
        `left: 50vw` + `translateX(-50%)` on a `position: fixed` element resolves against
        the actual browser viewport (nothing in this tree sets a transform/filter on an
        ancestor, so no other element hijacks the containing block), and the element is
        left un-widened (only top/bottom set) so it shrink-wraps its content instead of
        stretching full-bleed — that shrink-wrapped box is what gets the -50%-of-itself
        shift, which is what actually centers it rather than just centering text inside a
        wide box. Vertical span still starts below the top bar so existing vertical
        placement (and the label positioned relative to it) is unchanged.
      */}
      <div
        style={{
          position: 'fixed',
          top: TOPBAR_HEIGHT,
          bottom: 0,
          left: '50vw',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          zIndex: 5
        }}
      >
        <AgentSwitcher />

        <div style={{ position: 'relative' }}>
          <div
            style={{
              animation: toolActive ? 'dalve-heartbeat 1.1s ease-in-out infinite' : 'none',
              transformOrigin: 'center'
            }}
          >
            <ParticleOrb size={240} state={orbState} color={sphereColor} level={audioLevel} />
          </div>

          {toolActive && (
            <div
              className="tracked-label"
              style={{
                position: 'absolute',
                top: -28,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 10,
                color: '#6fe08a',
                whiteSpace: 'nowrap'
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#6fe08a',
                  animation: 'dalve-pulse 1.1s ease-in-out infinite'
                }}
              />
              WORKING{toolActiveLabel ? ` · ${formatActionLabel(toolActiveLabel)}` : ''}
            </div>
          )}

          <div
            className="tracked-label"
            style={{
              position: 'absolute',
              bottom: -2,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 9,
              color: accent.hex,
              letterSpacing: '0.3em',
              transition: 'color 200ms ease',
              whiteSpace: 'nowrap'
            }}
          >
            {activeLabel}
          </div>
        </div>
      </div>
    </div>
  )
}
