import { useEffect, useState } from 'react'
import { useUiStore } from '../state/uiStore'
import { useVoiceStore } from '../state/voiceStore'
import { useActiveAgentAccent } from '../lib/useActiveAgentAccent'

function formatClock(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })
}

export function TopBar(): React.JSX.Element {
  const detailed = useUiStore((s) => s.detailed)
  const toggleDetailed = useUiStore((s) => s.toggleDetailed)
  const sessionState = useVoiceStore((s) => s.sessionState)
  const toolActive = useVoiceStore((s) => s.toolActive)
  const toolActiveLabel = useVoiceStore((s) => s.toolActiveLabel)
  const accent = useActiveAgentAccent()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const statusLabel =
    sessionState === 'speaking'
      ? 'SPEAKING'
      : sessionState === 'listening'
        ? 'LISTENING'
        : sessionState === 'connecting'
          ? 'CONNECTING'
          : sessionState === 'error'
            ? 'ERROR'
            : 'SPACEBAR FOR VOICE'

  const dotColor =
    sessionState === 'speaking'
      ? accent.hex
      : sessionState === 'listening'
        ? '#6fe08a'
        : sessionState === 'error'
          ? '#e05a5a'
          : 'var(--c-text-3)'

  const pillBorder = sessionState === 'idle' || sessionState === 'error' ? 'var(--c-panel-border-strong)' : `${accent.hex}66`

  return (
    <div
      style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        zIndex: 20,
        position: 'relative'
      }}
    >
      <div
        className="tracked-label"
        style={{ color: 'var(--c-gold)', fontSize: 13, letterSpacing: '0.2em' }}
      >
        DALVE_OS<span style={{ fontSize: 8, verticalAlign: 'super' }}>™</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 14px',
            borderRadius: 999,
            border: `1px solid ${pillBorder}`,
            background: 'rgba(212,175,55,0.06)',
            transition: 'border-color 200ms ease'
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: dotColor,
              boxShadow: sessionState !== 'idle' ? `0 0 6px ${dotColor}` : 'none'
            }}
          />
          <span className="tracked-label" style={{ color: 'var(--c-text-1)' }}>
            {statusLabel}
          </span>
        </div>

        {toolActive && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 14px',
              borderRadius: 999,
              border: '1px solid #6fe08a66',
              background: 'rgba(111,224,138,0.08)',
              animation: 'dalve-pulse 1.1s ease-in-out infinite'
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6fe08a' }} />
            <span className="tracked-label" style={{ color: 'var(--c-text-1)' }}>
              WORKING{toolActiveLabel ? ` · ${toolActiveLabel}` : ''}
            </span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button
          onClick={toggleDetailed}
          className="tracked-label"
          style={{
            border: '1px solid var(--c-panel-border-strong)',
            borderRadius: 999,
            padding: '5px 12px',
            color: detailed ? 'var(--c-gold-bright)' : 'var(--c-text-2)'
          }}
        >
          {detailed ? 'DETAILED' : 'SUMMARY'}
        </button>
        <span className="tracked-label" style={{ color: 'var(--c-text-2)', minWidth: 84, textAlign: 'right' }}>
          {formatClock(now)}
        </span>
      </div>
    </div>
  )
}
