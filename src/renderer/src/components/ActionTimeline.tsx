import { useEffect, useRef, useState } from 'react'
import { ListChecks, ChevronDown, ChevronUp, CheckCircle2, XCircle, X } from 'lucide-react'
import { useActionTimelineStore } from '../state/actionTimelineStore'

const POSITION_KEY = 'dalve-action-timeline-position'
const PANEL_WIDTH = 320
const DRAG_THRESHOLD_PX = 4

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number' ? parsed : null
  } catch {
    return null
  }
}

function savePosition(pos: { x: number; y: number }): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(pos))
  } catch {
    // best-effort only — a failed write just means the position resets next launch
  }
}

/**
 * A persistent, minimizable, DRAGGABLE log of every real action DALVE has taken — live voice
 * tool calls and background autonomous-task steps both feed the same list (see
 * actionTimelineStore.ts) — so the user can see "Opened Chrome → Found WhatsApp → Opened chat →
 * ..." as it happens instead of only finding out from DALVE's spoken summary afterward. Every
 * entry reuses that action's own real result/error text; nothing here is a guessed description
 * of what probably happened.
 */
export function ActionTimeline(): React.JSX.Element | null {
  const entries = useActionTimelineStore((s) => s.entries)
  const minimized = useActionTimelineStore((s) => s.minimized)
  const toggleMinimized = useActionTimelineStore((s) => s.toggleMinimized)
  const clear = useActionTimelineStore((s) => s.clear)
  const listRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadSavedPosition())
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; dragged: boolean } | null>(null)

  useEffect(() => {
    if (!minimized) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [entries, minimized])

  function onHeaderMouseDown(e: React.MouseEvent): void {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos?.x ?? rect.left, origY: pos?.y ?? rect.top, dragged: false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e: MouseEvent): void {
    const d = dragState.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) d.dragged = true
    if (!d.dragged) return
    const next = {
      x: Math.min(Math.max(0, d.origX + dx), window.innerWidth - PANEL_WIDTH),
      y: Math.min(Math.max(0, d.origY + dy), window.innerHeight - 40)
    }
    setPos(next)
  }

  function onMouseUp(): void {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    if (!dragState.current?.dragged) {
      dragState.current = null
      return
    }
    setPos((p) => {
      if (p) savePosition(p)
      return p
    })
    // Defer clearing so the click handler (fired right after mouseup) can still see "was dragging"
    // and skip toggling minimize — a real drag shouldn't also collapse/expand the panel.
    setTimeout(() => {
      dragState.current = null
    }, 0)
  }

  function onHeaderClick(): void {
    if (dragState.current?.dragged) return
    toggleMinimized()
  }

  if (entries.length === 0) return null

  const positionStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : { bottom: 20, right: 20 }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        ...positionStyle,
        zIndex: 99,
        width: PANEL_WIDTH,
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
        onMouseDown={onHeaderMouseDown}
        onClick={onHeaderClick}
        title="Drag to move, click to expand/collapse"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: minimized ? 'none' : '1px solid var(--c-panel-border)',
          cursor: 'grab',
          userSelect: 'none'
        }}
      >
        <ListChecks size={13} color="var(--c-gold-bright)" />
        <span className="tracked-label" style={{ color: 'var(--c-text-1)', fontSize: 10 }}>
          ACTION TIMELINE
        </span>
        <span style={{ fontSize: 10, color: 'var(--c-text-3)' }}>({entries.length})</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onMouseDown={(e) => e.stopPropagation()}
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
