import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2, Bell, MessageSquare, X } from 'lucide-react'
import { useScheduleStore } from '../state/scheduleStore'
import type { ScheduleItem, ScheduleRecurrence } from '@shared/types'

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const RECURRENCE_LABELS: Record<ScheduleRecurrence, string> = {
  none: 'Once',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly'
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function defaultDueAt(): number {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 60, 0, 0)
  return d.getTime()
}

interface DraftState {
  id: string | null
  title: string
  type: 'reminder' | 'message'
  instruction: string
  dueAtLocal: string
  recurrence: ScheduleRecurrence
}

function blankDraft(dueAt = defaultDueAt()): DraftState {
  return { id: null, title: '', type: 'reminder', instruction: '', dueAtLocal: toDatetimeLocalValue(dueAt), recurrence: 'none' }
}

export function CalendarScreen(): React.JSX.Element {
  const items = useScheduleStore((s) => s.items)
  const refresh = useScheduleStore((s) => s.refresh)
  const add = useScheduleStore((s) => s.add)
  const update = useScheduleStore((s) => s.update)
  const remove = useScheduleStore((s) => s.remove)

  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d
  })
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enabledItems = useMemo(() => items.filter((i) => i.enabled), [items])

  const grid = useMemo(() => {
    const firstOfMonth = new Date(viewMonth)
    const startOffset = firstOfMonth.getDay()
    const gridStart = new Date(firstOfMonth)
    gridStart.setDate(gridStart.getDate() - startOffset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart)
      d.setDate(d.getDate() + i)
      return d
    })
  }, [viewMonth])

  const today = new Date()

  function itemsOnDay(day: Date): ScheduleItem[] {
    return enabledItems.filter((i) => sameDay(new Date(i.dueAt), day))
  }

  const upcoming = useMemo(() => [...enabledItems].sort((a, b) => a.dueAt - b.dueAt).slice(0, 20), [enabledItems])

  function openAddForDay(day: Date): void {
    const dueAt = new Date(day)
    const now = new Date()
    dueAt.setHours(sameDay(day, now) ? now.getHours() + 1 : 9, 0, 0, 0)
    setDraft(blankDraft(dueAt.getTime()))
  }

  function openEdit(item: ScheduleItem): void {
    setDraft({
      id: item.id,
      title: item.title,
      type: item.type,
      instruction: item.instruction ?? '',
      dueAtLocal: toDatetimeLocalValue(item.dueAt),
      recurrence: item.recurrence
    })
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return
    const title = draft.title.trim()
    if (!title) return
    const dueAt = new Date(draft.dueAtLocal).getTime()
    if (Number.isNaN(dueAt)) return
    if (draft.type === 'message' && !draft.instruction.trim()) return

    if (draft.id) {
      await update(draft.id, {
        title,
        type: draft.type,
        instruction: draft.type === 'message' ? draft.instruction.trim() : undefined,
        dueAt,
        recurrence: draft.recurrence,
        enabled: true
      })
    } else {
      await add({
        title,
        type: draft.type,
        instruction: draft.type === 'message' ? draft.instruction.trim() : undefined,
        dueAt,
        recurrence: draft.recurrence
      })
    }
    setDraft(null)
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 40px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <CalendarDays size={18} color="var(--c-gold)" strokeWidth={1.5} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--c-text-1)' }}>Calendar</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 24 }}>
          Reminders and recurring messages. DALVE can add these by voice too ("remind me tomorrow at 3pm to...") — this
          is where they all live. Only fires while DALVE is running.
        </p>

        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Month grid */}
          <div style={{ flex: '1 1 420px', minWidth: 320 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <button
                onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                style={{ color: 'var(--c-text-2)', padding: 4 }}
              >
                <ChevronLeft size={16} />
              </button>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-1)' }}>
                {viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </span>
              <button
                onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                style={{ color: 'var(--c-text-2)', padding: 4 }}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
              {WEEKDAY_LABELS.map((w, i) => (
                <div key={i} style={{ textAlign: 'center', fontSize: 10, color: 'var(--c-text-3)', letterSpacing: '0.05em' }}>
                  {w}
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
              {grid.map((day, i) => {
                const inMonth = day.getMonth() === viewMonth.getMonth()
                const isToday = sameDay(day, today)
                const isSelected = selectedDate && sameDay(day, selectedDate)
                const dayItems = itemsOnDay(day)
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(isSelected ? null : new Date(day))}
                    onDoubleClick={() => openAddForDay(day)}
                    title="Click to view, double-click to add"
                    style={{
                      aspectRatio: '1',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 3,
                      borderRadius: 8,
                      border: isSelected ? '1px solid var(--c-gold)' : '1px solid transparent',
                      background: isToday ? 'rgba(212,175,55,0.12)' : 'transparent',
                      opacity: inMonth ? 1 : 0.35
                    }}
                  >
                    <span style={{ fontSize: 12.5, color: isToday ? 'var(--c-gold-bright)' : 'var(--c-text-1)' }}>{day.getDate()}</span>
                    {dayItems.length > 0 && (
                      <div style={{ display: 'flex', gap: 2 }}>
                        {dayItems.slice(0, 3).map((it) => (
                          <div
                            key={it.id}
                            style={{
                              width: 4,
                              height: 4,
                              borderRadius: 999,
                              background: it.type === 'message' ? '#6fb8e0' : 'var(--c-gold)'
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>

            {selectedDate && (
              <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--c-panel-border)', background: 'var(--c-panel)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--c-text-1)', fontWeight: 600 }}>
                    {selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                  </span>
                  <button
                    onClick={() => openAddForDay(selectedDate)}
                    className="tracked-label"
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--c-gold-bright)' }}
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
                {itemsOnDay(selectedDate).length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--c-text-3)' }}>Nothing scheduled — double-click a day or use Add.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {itemsOnDay(selectedDate).map((it) => (
                      <ScheduleRow key={it.id} item={it} onEdit={() => openEdit(it)} onRemove={() => remove(it.id)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Upcoming list */}
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span className="tracked-label" style={{ color: 'var(--c-gold)', fontSize: 10 }}>
                UPCOMING
              </span>
              <button
                onClick={() => setDraft(blankDraft())}
                className="tracked-label"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  padding: '5px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--c-panel-border-strong)',
                  color: 'var(--c-gold-bright)'
                }}
              >
                <Plus size={13} /> Add
              </button>
            </div>

            {upcoming.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 0', color: 'var(--c-text-3)' }}>
                <CalendarDays size={22} strokeWidth={1.2} />
                <p style={{ fontSize: 12.5 }}>No reminders yet.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {upcoming.map((it) => (
                  <ScheduleRow key={it.id} item={it} onEdit={() => openEdit(it)} onRemove={() => remove(it.id)} showDate />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {draft && (
        <div
          onClick={() => setDraft(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 420,
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--c-panel-border-strong)',
              background: '#0c0a08',
              boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
              padding: 20
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text-1)' }}>
                {draft.id ? 'Edit' : 'New'} {draft.type === 'reminder' ? 'reminder' : 'scheduled message'}
              </span>
              <button onClick={() => setDraft(null)} style={{ color: 'var(--c-text-2)' }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-3)', display: 'block', marginBottom: 6 }}>Title</label>
                <input
                  autoFocus
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="e.g. Call the dentist"
                  style={inputStyle}
                />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {(['reminder', 'message'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setDraft({ ...draft, type: t })}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      borderRadius: 8,
                      fontSize: 12,
                      border: draft.type === t ? '1px solid var(--c-gold)' : '1px solid var(--c-panel-border)',
                      color: draft.type === t ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
                      background: draft.type === t ? 'rgba(212,175,55,0.08)' : 'transparent'
                    }}
                  >
                    {t === 'reminder' ? 'Reminder' : 'Send a message'}
                  </button>
                ))}
              </div>

              {draft.type === 'message' && (
                <div>
                  <label style={{ fontSize: 11, color: 'var(--c-text-3)', display: 'block', marginBottom: 6 }}>
                    What should DALVE actually do when this fires?
                  </label>
                  <textarea
                    value={draft.instruction}
                    onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
                    placeholder="e.g. Send Ali on WhatsApp: don't forget the meeting"
                    rows={3}
                    style={{ ...inputStyle, resize: 'vertical' }}
                  />
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-3)', display: 'block', marginBottom: 6 }}>Date &amp; time</label>
                <input
                  type="datetime-local"
                  value={draft.dueAtLocal}
                  onChange={(e) => setDraft({ ...draft, dueAtLocal: e.target.value })}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: 11, color: 'var(--c-text-3)', display: 'block', marginBottom: 6 }}>Repeat</label>
                <select
                  value={draft.recurrence}
                  onChange={(e) => setDraft({ ...draft, recurrence: e.target.value as ScheduleRecurrence })}
                  style={inputStyle}
                >
                  {(Object.keys(RECURRENCE_LABELS) as ScheduleRecurrence[]).map((r) => (
                    <option key={r} value={r}>
                      {RECURRENCE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {draft.id && (
                  <button
                    onClick={() => {
                      remove(draft.id!)
                      setDraft(null)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '9px 14px',
                      borderRadius: 8,
                      border: '1px solid rgba(224,90,90,0.4)',
                      color: '#e05a5a',
                      fontSize: 12
                    }}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                )}
                <button
                  onClick={saveDraft}
                  style={{
                    flex: 1,
                    padding: '9px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'var(--c-gold)',
                    color: '#1a1305',
                    fontWeight: 600,
                    fontSize: 12
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--c-panel-border)',
  borderRadius: 8,
  padding: '10px 12px',
  color: 'var(--c-text-1)',
  fontSize: 13
}

function ScheduleRow({
  item,
  onEdit,
  onRemove,
  showDate
}: {
  item: ScheduleItem
  onEdit: () => void
  onRemove: () => void
  showDate?: boolean
}): React.JSX.Element {
  const due = new Date(item.dueAt)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--c-panel-border)',
        background: 'var(--c-panel)'
      }}
    >
      {item.type === 'message' ? (
        <MessageSquare size={13} color="#6fb8e0" style={{ flexShrink: 0 }} />
      ) : (
        <Bell size={13} color="var(--c-gold)" style={{ flexShrink: 0 }} />
      )}
      <button onClick={onEdit} style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div style={{ fontSize: 12.5, color: 'var(--c-text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.title}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--c-text-3)', marginTop: 1 }}>
          {showDate ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' : ''}
          {due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          {item.recurrence !== 'none' ? ` · ${RECURRENCE_LABELS[item.recurrence]}` : ''}
        </div>
      </button>
      <button onClick={onRemove} style={{ color: 'var(--c-text-3)', flexShrink: 0 }}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}
