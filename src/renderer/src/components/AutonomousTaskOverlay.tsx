import { Bot, Square, CheckSquare, X } from 'lucide-react'
import { useAutonomousTaskStore } from '../state/autonomousTaskStore'

export function AutonomousTaskOverlay(): React.JSX.Element | null {
  const active = useAutonomousTaskStore((s) => s.active)
  const goal = useAutonomousTaskStore((s) => s.goal)
  const log = useAutonomousTaskStore((s) => s.log)
  const subtasks = useAutonomousTaskStore((s) => s.subtasks)
  const lastSummary = useAutonomousTaskStore((s) => s.lastSummary)
  const setSummary = useAutonomousTaskStore((s) => s.setSummary)

  // Stays visible after stopping so the user actually sees the final result, not just a panel
  // that vanishes the instant the task completes — dismissed manually via the close button below.
  if (!active && !lastSummary) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: 24,
        zIndex: 100,
        maxWidth: 360,
        borderRadius: 14,
        border: '1px solid var(--c-gold)',
        background: 'rgba(20,16,8,0.92)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 0 30px rgba(212,175,55,0.2)',
        padding: '14px 16px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Bot size={14} color="var(--c-gold-bright)" />
        <span className="tracked-label" style={{ color: 'var(--c-gold-bright)', fontSize: 10 }}>
          {active ? 'RUNNING UNATTENDED' : 'TASK COMPLETE'}
        </span>
        {active ? (
          <button
            onClick={() => window.dalve.autonomousTask.stop()}
            className="tracked-label"
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 999,
              border: '1px solid #e05a5a',
              color: '#e05a5a',
              fontSize: 9
            }}
          >
            <Square size={9} fill="#e05a5a" />
            STOP
          </button>
        ) : (
          <button onClick={() => setSummary(null)} style={{ marginLeft: 'auto', color: 'var(--c-text-3)' }}>
            <X size={14} />
          </button>
        )}
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--c-text-1)', lineHeight: 1.4, marginBottom: 8 }}>{goal}</p>

      {subtasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {subtasks.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              {s.done ? (
                <CheckSquare size={12} color="#6fe08a" style={{ marginTop: 1, flexShrink: 0 }} />
              ) : (
                <Square size={12} color="var(--c-text-3)" style={{ marginTop: 1, flexShrink: 0 }} />
              )}
              <span
                style={{
                  fontSize: 11.5,
                  color: s.done ? 'var(--c-text-3)' : 'var(--c-text-1)',
                  textDecoration: s.done ? 'line-through' : 'none',
                  lineHeight: 1.4
                }}
              >
                {s.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {lastSummary && (
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--c-gold-bright)',
            lineHeight: 1.45,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(212,175,55,0.1)',
            marginBottom: log.length ? 8 : 0
          }}
        >
          {lastSummary}
        </p>
      )}

      {active && log.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {log.map((line, i) => (
            <p key={i} style={{ fontSize: 11, color: 'var(--c-text-3)', lineHeight: 1.4 }}>
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
