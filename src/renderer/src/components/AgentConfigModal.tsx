import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useAgentsStore } from '../state/agentsStore'
import { useSettingsStore } from '../state/settingsStore'
import { hexToHue, hslToHex } from '../lib/color'
import { GEMINI_VOICES, PRIORITY_COMPOSIO_APPS } from '@shared/types'

type Tab = 'Prompt & Identity' | 'Skills' | 'Memory' | 'Voice'
const TABS: Tab[] = ['Prompt & Identity', 'Skills', 'Memory', 'Voice']

const STATUS_COLOR: Record<string, string> = {
  idle: 'var(--c-status-idle)',
  active: 'var(--c-status-active)',
  working: 'var(--c-status-working)'
}

export function AgentConfigModal(): React.JSX.Element | null {
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId)
  const selectAgent = useAgentsStore((s) => s.selectAgent)
  const agents = useAgentsStore((s) => s.agents)
  const update = useAgentsStore((s) => s.update)
  const settings = useSettingsStore((s) => s.settings)
  const elevenLabsVoices = useSettingsStore((s) => s.elevenLabsVoices)
  const loadElevenLabsVoices = useSettingsStore((s) => s.loadElevenLabsVoices)

  const agent = agents.find((a) => a.id === selectedAgentId)
  const [tab, setTab] = useState<Tab>('Prompt & Identity')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [memory, setMemory] = useState('')

  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setPrompt(agent.systemPrompt)
      setMemory(agent.memory)
      setTab('Prompt & Identity')
    }
  }, [agent?.id])

  // Auto-save name (debounced) — trimmed and never allowed to save empty, so a name field
  // mid-edit can't leave the agent with a blank name.
  useEffect(() => {
    if (!agent) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === agent.name) return
    const t = setTimeout(() => update(agent.id, { name: trimmed }), 600)
    return () => clearTimeout(t)
  }, [name, agent, update])

  // Auto-save system prompt (debounced)
  useEffect(() => {
    if (!agent || prompt === agent.systemPrompt) return
    const t = setTimeout(() => update(agent.id, { systemPrompt: prompt }), 600)
    return () => clearTimeout(t)
  }, [prompt, agent, update])

  // Auto-save memory (debounced)
  useEffect(() => {
    if (!agent || memory === agent.memory) return
    const t = setTimeout(() => update(agent.id, { memory }), 600)
    return () => clearTimeout(t)
  }, [memory, agent, update])

  useEffect(() => {
    if (settings?.elevenLabsApiKeySet) void loadElevenLabsVoices()
  }, [settings?.elevenLabsApiKeySet, loadElevenLabsVoices])

  const allElevenLabsVoices = useMemo(() => {
    const custom = settings?.elevenLabsCustomVoices ?? []
    const merged = [...elevenLabsVoices]
    for (const v of custom) {
      if (!merged.some((existing) => existing.voiceId === v.voiceId)) merged.push(v)
    }
    return merged
  }, [elevenLabsVoices, settings?.elevenLabsCustomVoices])

  const availableSkills = useMemo(() => {
    const composio = PRIORITY_COMPOSIO_APPS.map((a) => `composio:${a.key}`)
    const mcp = (settings?.mcpServers ?? []).flatMap((s) =>
      s.tools.length ? s.tools.map((t) => `mcp:${s.id}:${t}`) : [`mcp:${s.id}:*`]
    )
    return [...composio, ...mcp]
  }, [settings])

  function skillLabel(skill: string): string {
    if (skill.startsWith('composio:')) {
      const key = skill.slice('composio:'.length)
      return PRIORITY_COMPOSIO_APPS.find((a) => a.key === key)?.name ?? key
    }
    const parts = skill.split(':')
    const server = settings?.mcpServers.find((s) => s.id === parts[1])
    return `${server?.name ?? 'MCP server'} — ${parts[2] === '*' ? 'all tools' : parts[2]}`
  }

  if (!agent) return null

  function toggleSkill(skill: string): void {
    if (!agent) return
    const has = agent.toolScope.includes(skill)
    const toolScope = has
      ? agent.toolScope.filter((s) => s !== skill)
      : [...agent.toolScope, skill]
    update(agent.id, { toolScope })
  }

  return (
    <div
      onClick={() => selectAgent(null)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--c-panel-border-strong)',
          background: '#0c0a08',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--c-panel-border)'
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--c-text-1)' }}>
              {agent.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <span className="tracked-label" style={{ fontSize: 10 }}>
                {agent.type === 'companion' ? 'Companion' : 'Bot'}
              </span>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: '0.1em',
                  color: STATUS_COLOR[agent.status]
                }}
              >
                ● {agent.status.toUpperCase()}
              </span>
            </div>
          </div>
          <button onClick={() => selectAgent(null)} style={{ color: 'var(--c-text-2)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--c-panel-border)', padding: '0 20px' }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="tracked-label"
              style={{
                padding: '12px 14px',
                fontSize: 10,
                borderBottom: tab === t ? '2px solid var(--c-gold)' : '2px solid transparent',
                color: tab === t ? 'var(--c-gold-bright)' : 'var(--c-text-2)'
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {tab === 'Prompt & Identity' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <div
                  className="tracked-label"
                  style={{ color: 'var(--c-gold)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}
                >
                  <span>Name</span>
                  <span style={{ color: 'var(--c-text-3)' }}>Auto-saves</span>
                </div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--c-panel-border)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: 'var(--c-text-1)',
                    fontSize: 13
                  }}
                />
              </div>
              <div>
                <div
                  className="tracked-label"
                  style={{ color: 'var(--c-gold)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}
                >
                  <span>Color</span>
                  <span style={{ color: 'var(--c-text-3)', fontWeight: 400, letterSpacing: 0 }}>
                    Any color (incl. white) →
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    value={hexToHue(agent.color)}
                    onChange={(e) => update(agent.id, { color: hslToHex(Number(e.target.value), 75, 55) })}
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: 999,
                      appearance: 'none',
                      background:
                        'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)'
                    }}
                  />
                  {/* The slider above only ever varies hue at fixed saturation/lightness, so pure
                      white/black/gray are mathematically unreachable from it — this native picker
                      covers the full range including those. */}
                  <input
                    type="color"
                    value={agent.color}
                    onChange={(e) => update(agent.id, { color: e.target.value })}
                    style={{
                      width: 34,
                      height: 28,
                      padding: 0,
                      border: '1px solid var(--c-panel-border)',
                      borderRadius: 6,
                      background: 'transparent',
                      cursor: 'pointer',
                      flexShrink: 0
                    }}
                  />
                </div>
              </div>
              <div>
                <div
                  className="tracked-label"
                  style={{
                    color: 'var(--c-gold)',
                    marginBottom: 8,
                    display: 'flex',
                    justifyContent: 'space-between'
                  }}
                >
                  <span>System prompt</span>
                  <span style={{ color: 'var(--c-text-3)' }}>Auto-saves</span>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={10}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--c-panel-border)',
                    borderRadius: 8,
                    padding: 12,
                    color: 'var(--c-text-1)',
                    fontSize: 13,
                    lineHeight: 1.6
                  }}
                />
              </div>
            </div>
          )}

          {tab === 'Skills' && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginBottom: 14 }}>
                Choose which connected apps and MCP tools this agent may use.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {availableSkills.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--c-text-3)' }}>
                    Connect an app or MCP server in Settings to scope skills.
                  </div>
                )}
                {availableSkills.map((skill) => (
                  <label
                    key={skill}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                      color: 'var(--c-text-1)',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--c-panel-border)'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={agent.toolScope.includes(skill)}
                      onChange={() => toggleSkill(skill)}
                    />
                    {skillLabel(skill)}
                  </label>
                ))}
              </div>
            </div>
          )}

          {tab === 'Memory' && (
            <div>
              <div
                className="tracked-label"
                style={{
                  color: 'var(--c-gold)',
                  marginBottom: 8,
                  display: 'flex',
                  justifyContent: 'space-between'
                }}
              >
                <span>Persistent notes</span>
                <span style={{ color: 'var(--c-text-3)' }}>Auto-saves</span>
              </div>
              <textarea
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                rows={12}
                placeholder="Notes this agent should remember across tasks..."
                style={{
                  width: '100%',
                  resize: 'vertical',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--c-panel-border)',
                  borderRadius: 8,
                  padding: 12,
                  color: 'var(--c-text-1)',
                  fontSize: 13,
                  lineHeight: 1.6
                }}
              />
            </div>
          )}

          {tab === 'Voice' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              <div>
                <div className="tracked-label" style={{ color: 'var(--c-gold)', marginBottom: 8 }}>
                  Gemini Live voice
                </div>
                <select
                  value={agent.voice}
                  onChange={(e) => update(agent.id, { voice: e.target.value })}
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--c-panel-border)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: 'var(--c-text-1)',
                    fontSize: 13
                  }}
                >
                  {GEMINI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 10 }}>
                  Used when relaying this agent's work out loud while the voice engine is set to Gemini.
                </p>
              </div>

              <div>
                <div className="tracked-label" style={{ color: 'var(--c-gold)', marginBottom: 8 }}>
                  Groq + ElevenLabs voice
                </div>
                {settings?.elevenLabsApiKeySet ? (
                  <select
                    value={agent.elevenLabsVoiceId ?? ''}
                    onChange={(e) => {
                      if (!e.target.value) {
                        update(agent.id, { elevenLabsVoiceId: undefined, elevenLabsVoiceName: undefined })
                        return
                      }
                      const voice = allElevenLabsVoices.find((v) => v.voiceId === e.target.value)
                      if (voice) {
                        update(agent.id, { elevenLabsVoiceId: voice.voiceId, elevenLabsVoiceName: voice.name })
                      }
                    }}
                    style={{
                      width: '100%',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid var(--c-panel-border)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      color: 'var(--c-text-1)',
                      fontSize: 13
                    }}
                  >
                    <option value="">Use global default{settings.elevenLabsVoiceName ? ` (${settings.elevenLabsVoiceName})` : ''}</option>
                    {allElevenLabsVoices.map((v) => (
                      <option key={v.voiceId} value={v.voiceId}>
                        {v.name}
                        {v.category ? ` (${v.category})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--c-text-3)' }}>
                    Add an ElevenLabs API key in Settings to give this agent its own voice.
                  </p>
                )}
                <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 10 }}>
                  Used instead of the global default while the voice engine is set to Groq.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
