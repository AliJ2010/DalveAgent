import { Eye, Square } from 'lucide-react'
import { useScreenControlStore } from '../state/screenControlStore'
import { useVoiceStore } from '../state/voiceStore'

export function ScreenControlOverlay(): React.JSX.Element | null {
  const active = useScreenControlStore((s) => s.active)
  const toolActive = useVoiceStore((s) => s.toolActive)
  const toolActiveLabel = useVoiceStore((s) => s.toolActiveLabel)

  if (!active) return null

  return (
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
        background: 'rgba(212,175,55,0.14)',
        borderBottom: '1px solid var(--c-gold)',
        backdropFilter: 'blur(6px)'
      }}
    >
      <Eye size={14} color="var(--c-gold-bright)" />
      <span className="tracked-label" style={{ color: 'var(--c-text-1)', fontSize: 11 }}>
        DALVE CAN SEE AND CONTROL YOUR SCREEN
      </span>
      {toolActive && (
        <span
          className="tracked-label"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            color: '#6fe08a',
            animation: 'dalve-pulse 1.1s ease-in-out infinite'
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6fe08a' }} />
          WORKING{toolActiveLabel ? ` · ${toolActiveLabel}` : ''}
        </span>
      )}
      <button
        onClick={() => window.dalve.screenControl.stop()}
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
    </div>
  )
}
