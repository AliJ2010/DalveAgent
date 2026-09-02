import { useEffect, useState } from 'react'
import { ParticleSphere } from './ParticleSphere'
import { BackgroundSpheres } from './BackgroundSpheres'
import { AgentSwitcher } from './AgentSwitcher'
import { useVoiceStore } from '../state/voiceStore'
import { useAutonomousTaskStore } from '../state/autonomousTaskStore'
import { useActiveAgentAccent } from '../lib/useActiveAgentAccent'
import { hexToRgbString } from '../lib/color'
import { formatActionLabel } from '../lib/formatLabel'

const TOPBAR_HEIGHT = 48
// A tool call or autonomous task already puts the sphere into its "busy" scattered look — this
// adds a purely ambient, unpredictable version of the same thing so it doesn't ONLY ever happen
// when something is actively running, per direct feedback. Random within a wide window so it
// never reads as a fixed interval.
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
            {/* The proven, lag-free Canvas2D sphere — a real GPU/WebGL replacement was tried and
                reverted after live testing: it lagged and its "explosion" either stayed confined
                to a small square or, once expanded, was too sparse/dim to visibly register. This
                keeps the same particle-sphere identity: a "busy" state now genuinely explodes
                across the whole app (ParticleSphere relocates its own canvas via a portal, sized
                to the real viewport) using the same cheap per-point loop, no WebGL involved. */}
            <ParticleSphere
              size={300}
              state={sessionState}
              color={sphereColor}
              pointCount={520}
              level={audioLevel}
              busy={autonomousActive || toolActive || randomBurst}
            />
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
        </div>

        {/* A normal flex child sharing the same `gap` as the switcher-to-orb spacing above, not
            an absolutely-positioned overlay glued to the orb's bottom edge — that overlay's
            visual gap depended on how much of the orb's own box the sphere actually fills, which
            reads as "too close" whenever the box size changes even though the offset itself
            never did. This way switcher→orb and orb→label are provably the same distance. */}
        <div
          className="tracked-label"
          style={{
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
  )
}
