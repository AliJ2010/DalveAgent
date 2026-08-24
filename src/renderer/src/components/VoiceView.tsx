import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ParticleSphere } from './ParticleSphere'
import { BackgroundSpheres } from './BackgroundSpheres'
import { AgentSwitcher } from './AgentSwitcher'
import { useVoiceStore } from '../state/voiceStore'
import { useActiveAgentAccent } from '../lib/useActiveAgentAccent'
import { hexToRgbString } from '../lib/color'

const VIEWS = ['KNOWLEDGE_VIEW', 'MEMORY_VIEW', 'SKILLS_VIEW']
const TOPBAR_HEIGHT = 48

export function VoiceView(): React.JSX.Element {
  const sessionState = useVoiceStore((s) => s.sessionState)
  const accent = useActiveAgentAccent()
  const [viewIdx, setViewIdx] = useState(0)

  const sphereColor = hexToRgbString(accent.hex)
  const activeLabel = accent.name.toUpperCase().split('').join(' ')

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
        placement (and the nav/label positioned relative to it) is unchanged.
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
          <ParticleSphere size={360} state={sessionState} color={sphereColor} pointCount={520} />

          <div
            style={{
              position: 'absolute',
              bottom: 34,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              whiteSpace: 'nowrap'
            }}
          >
            <button
              onClick={() => setViewIdx((i) => (i - 1 + VIEWS.length) % VIEWS.length)}
              style={{ color: 'var(--c-text-3)' }}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="tracked-label" style={{ color: 'var(--c-text-2)', fontSize: 10 }}>
              {VIEWS[viewIdx]}
            </span>
            <button
              onClick={() => setViewIdx((i) => (i + 1) % VIEWS.length)}
              style={{ color: 'var(--c-text-3)' }}
            >
              <ChevronRight size={14} />
            </button>
          </div>

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
