import { useEffect, useState } from 'react'
import { BookOpen, Trash2, Plus } from 'lucide-react'
import { useSettingsStore } from '../state/settingsStore'

function parseFacts(memory: string): string[] {
  return memory
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

function serializeFacts(facts: string[]): string {
  return facts.map((f) => `- ${f}`).join('\n')
}

export function KnowledgeScreen(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const refresh = useSettingsStore((s) => s.refresh)
  const setDalveMemory = useSettingsStore((s) => s.setDalveMemory)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    refresh()
  }, [refresh])

  const facts = parseFacts(settings?.dalveMemory ?? '')

  function addFact(): void {
    const text = draft.trim()
    if (!text) return
    setDalveMemory(serializeFacts([...facts, text]))
    setDraft('')
  }

  function removeFact(index: number): void {
    setDalveMemory(serializeFacts(facts.filter((_, i) => i !== index)))
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 40px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <BookOpen size={18} color="var(--c-gold)" strokeWidth={1.5} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--c-text-1)' }}>Knowledge</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 24 }}>
          Facts DALVE has saved to remember — she writes here herself when you tell her something
          worth keeping (your name, preferences, anything you say to remember). You can add or
          remove things directly too.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFact()}
            placeholder="Add something for DALVE to remember..."
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--c-panel-border)',
              borderRadius: 8,
              padding: '10px 12px',
              color: 'var(--c-text-1)',
              fontSize: 13
            }}
          />
          <button
            onClick={addFact}
            className="tracked-label"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              padding: '0 16px',
              borderRadius: 8,
              border: '1px solid var(--c-panel-border-strong)',
              color: 'var(--c-gold-bright)'
            }}
          >
            <Plus size={13} /> Add
          </button>
        </div>

        {facts.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: '48px 0',
              color: 'var(--c-text-3)'
            }}
          >
            <BookOpen size={24} strokeWidth={1.2} />
            <p style={{ fontSize: 13 }}>Nothing saved yet — tell DALVE something to remember.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {facts.map((fact, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--c-panel-border)',
                  background: 'var(--c-panel)'
                }}
              >
                <span style={{ fontSize: 13.5, color: 'var(--c-text-1)' }}>{fact}</span>
                <button onClick={() => removeFact(i)} style={{ color: 'var(--c-text-3)', flexShrink: 0 }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
