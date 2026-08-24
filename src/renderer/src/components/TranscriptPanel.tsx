import { useEffect, useRef, useState } from 'react'
import { Mic, Type, Settings as SettingsIcon, Minus, MessageSquare } from 'lucide-react'
import { useVoiceStore } from '../state/voiceStore'
import { useUiStore } from '../state/uiStore'
import { useAgentsStore } from '../state/agentsStore'
import { sendTypedMessage, toggleVoiceSession } from '../lib/voiceSession'

const TABS = ['DALVE', 'AGENTS', 'SETTINGS'] as const

const MIN_SIZE = { width: 280, height: 300 }
const MAX_SIZE = { width: 640, height: 760 }
const DEFAULT_SIZE = { width: 340, height: 420 }

export function TranscriptPanel(): React.JSX.Element {
  const transcript = useVoiceStore((s) => s.transcript)
  const sessionState = useVoiceStore((s) => s.sessionState)
  const activeAgentId = useVoiceStore((s) => s.activeAgentId)
  const activeTab = useVoiceStore((s) => s.activeTab)
  const setActiveTab = useVoiceStore((s) => s.setActiveTab)
  const setScreen = useUiStore((s) => s.setScreen)
  const agents = useAgentsStore((s) => s.agents)

  const activeAgentName = activeAgentId ? agents.find((a) => a.id === activeAgentId)?.name : undefined

  function labelFor(entryAgentId: string | null | undefined): string {
    if (!entryAgentId) return 'DALVE'
    return agents.find((a) => a.id === entryAgentId)?.name.toUpperCase() ?? 'DALVE'
  }

  function colorFor(entryAgentId: string | null | undefined): string {
    if (!entryAgentId) return 'var(--c-gold)'
    return agents.find((a) => a.id === entryAgentId)?.color ?? 'var(--c-gold)'
  }

  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const listRef = useRef<HTMLDivElement>(null)
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [transcript, activeTab])

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!resizeStart.current) return
      const { x, y, width, height } = resizeStart.current
      const nextWidth = Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, width - (e.clientX - x)))
      const nextHeight = Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, height - (e.clientY - y)))
      setSize({ width: nextWidth, height: nextHeight })
    }
    function onUp(): void {
      resizeStart.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    resizeStart.current = { x: e.clientX, y: e.clientY, width: size.width, height: size.height }
  }

  function submitDraft(): void {
    const text = draft.trim()
    if (!text) return
    void sendTypedMessage(text)
    setDraft('')
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Expand chat"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          borderRadius: 999,
          border: '1px solid var(--c-panel-border)',
          background: 'var(--c-panel)',
          backdropFilter: 'blur(16px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          color: 'var(--c-text-1)'
        }}
      >
        <MessageSquare size={14} color="var(--c-gold)" />
        <span className="tracked-label" style={{ fontSize: 10 }}>
          {activeAgentName ?? 'DALVE'}
        </span>
      </button>
    )
  }

  return (
    <div
      style={{
        width: size.width,
        height: size.height,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--c-panel-border)',
        background: 'var(--c-panel)',
        backdropFilter: 'blur(16px)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
          zIndex: 5
        }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--c-panel-border)',
          padding: '10px 8px 0 12px'
        }}
      >
        <div style={{ display: 'flex' }}>
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => (tab === 'SETTINGS' ? setScreen('settings') : setActiveTab(tab))}
              className="tracked-label"
              style={{
                padding: '6px 10px 10px',
                borderBottom:
                  activeTab === tab ? '2px solid var(--c-gold)' : '2px solid transparent',
                color: activeTab === tab ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
                fontSize: 10
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCollapsed(true)}
          title="Minimize"
          style={{ color: 'var(--c-text-3)', padding: '2px 4px 8px' }}
        >
          <Minus size={14} />
        </button>
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 8px' }}>
        {activeTab === 'DALVE' &&
          transcript.map((entry) => (
            <div key={entry.id} style={{ marginBottom: 12 }}>
              {entry.delegation ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    color: 'var(--c-text-2)'
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: entry.delegation.agentColor
                    }}
                  />
                  delegating to {entry.delegation.agentName}
                </div>
              ) : (
                <div>
                  <div
                    className="tracked-label"
                    style={{
                      fontSize: 9,
                      color:
                        entry.speaker === 'user'
                          ? 'var(--c-text-3)'
                          : entry.speaker === 'system'
                            ? '#e0a63a'
                            : colorFor(entry.agentId),
                      marginBottom: 2
                    }}
                  >
                    {entry.speaker === 'user'
                      ? 'YOU'
                      : entry.speaker === 'system'
                        ? 'SYSTEM'
                        : labelFor(entry.agentId)}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      color: entry.speaker === 'system' ? '#e0a63a' : 'var(--c-text-1)',
                      background:
                        entry.speaker === 'user' ? 'rgba(255,255,255,0.04)' : 'transparent',
                      padding: entry.speaker === 'user' ? '8px 10px' : 0,
                      borderRadius: 8,
                      lineHeight: 1.5
                    }}
                  >
                    {entry.text}
                  </div>
                </div>
              )}
            </div>
          ))}

        {activeTab === 'AGENTS' && (
          <div style={{ fontSize: 13, color: 'var(--c-text-3)', paddingTop: 20, textAlign: 'center' }}>
            No delegated tasks yet.
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--c-panel-border)', padding: 12 }}>
        {typing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft()
                if (e.key === 'Escape') setTyping(false)
              }}
              placeholder={`Message ${activeAgentName ?? 'DALVE'}...`}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--c-panel-border)',
                borderRadius: 8,
                padding: '8px 10px',
                color: 'var(--c-text-1)',
                fontSize: 13
              }}
            />
            <button
              onClick={() => setTyping(false)}
              title="Switch to voice"
              style={{ color: 'var(--c-text-2)' }}
            >
              <Mic size={16} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => void toggleVoiceSession()}
              title={sessionState === 'idle' || sessionState === 'error' ? 'Start talking' : 'Stop'}
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid var(--c-panel-border-strong)',
                color:
                  sessionState === 'idle' || sessionState === 'error'
                    ? 'var(--c-text-2)'
                    : 'var(--c-gold-bright)',
                background:
                  sessionState === 'idle' || sessionState === 'error'
                    ? 'transparent'
                    : 'rgba(212,175,55,0.12)',
                flexShrink: 0
              }}
            >
              <Mic size={14} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--c-text-2)' }}>
                {sessionState === 'connecting'
                  ? 'Connecting...'
                  : sessionState === 'error'
                    ? 'Something went wrong — try again'
                    : `You're talking to ${activeAgentName ?? 'DALVE'} through voice`}
              </div>
              <div style={{ fontSize: 10, color: 'var(--c-text-3)' }}>
                Voice responses may be inaccurate or delayed.
              </div>
            </div>
            <button onClick={() => setTyping(true)} title="Type instead" style={{ color: 'var(--c-text-2)' }}>
              <Type size={15} />
            </button>
            <button onClick={() => setScreen('settings')} title="Settings" style={{ color: 'var(--c-text-3)' }}>
              <SettingsIcon size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
