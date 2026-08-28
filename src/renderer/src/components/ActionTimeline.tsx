import { useEffect, useRef } from 'react'
import { ListChecks, ChevronDown, ChevronUp, CheckCircle2, XCircle, X } from 'lucide-react'
import { useActionTimelineStore } from '../state/actionTimelineStore'

/**
 * A persistent, minimizable log of every real action DALVE has taken — live voice tool calls and
 * background autonomous-task steps both feed the same list (see actionTimelineStore.ts) — so the
 * user can see "Opened Chrome → Found WhatsApp → Opened chat → ..." as it happens instead of only
 * finding out from DALVE's spoken summary afterward. Every entry reuses that action's own real
 * result/error text; nothing here is a guessed description of what probably happened.
 */
export function ActionTimeline(): React.JSX.Element | null {
  const entries = useActionTimelineStore((s) => s.entries)
  const minimized = useActionTimelineStore((s) => s.minimized)
  const toggleMinimized = useActionTimelineStore((s) => s.toggleMinimized)
  const clear = useActionTimelineStore((s) => s.clear)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!minimized) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [entries, minimized])

  if (entries.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 99,
        width: 320,
        maxHeight: minimized ? 'auto' : 360,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        border: '1px solid var(--c-panel-border-strong)',
        background: 'rgba(12,10,8,0.92)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: minimized ? 'none' : '1px solid var(--c-panel-border)',
          cursor: 'pointer'
        }}
        onClick={toggleMinimized}
      >
        <ListChecks size={13} color="var(--c-gold-bright)" />
        <span className="tracked-label" style={{ color: 'var(--c-text-1)', fontSize: 10 }}>
          ACTION TIMELINE
        </span>
        <span style={{ fontSize: 10, color: 'var(--c-text-3)' }}>({entries.length})</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              clear()
            }}
            title="Clear"
            style={{ color: 'var(--c-text-3)', padding: 2 }}
          >
            <X size={13} />
          </button>
          {minimized ? <ChevronUp size={14} color="var(--c-text-3)" /> : <ChevronDown size={14} color="var(--c-text-3)" />}
        </div>
      </div>

      {!minimized && (
        <div ref={listRef} style={{ overflowY: 'auto', padding: '8px 12px 12px' }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ display: 'flex', gap: 8, padding: '5px 0', alignItems: 'flex-start' }}>
              {entry.status === 'error' ? (
                <XCircle size={13} color="#e05a5a" style={{ marginTop: 2, flexShrink: 0 }} />
              ) : entry.status === 'success' ? (
                <CheckCircle2 size={13} color="#6fe08a" style={{ marginTop: 2, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 13, height: 13, marginTop: 2, flexShrink: 0 }} />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--c-text-1)', wordBreak: 'break-word' }}>{entry.label}</div>
                {entry.detail && (
                  <div style={{ fontSize: 11, color: 'var(--c-text-3)', wordBreak: 'break-word', marginTop: 1 }}>
                    {entry.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
