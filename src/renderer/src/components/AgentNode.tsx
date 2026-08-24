import { Handle, Position } from 'reactflow'
import { Plus } from 'lucide-react'
import type { AgentConfig } from '@shared/types'

export interface AgentNodeData {
  agent: AgentConfig
  childCount: number
  isRoot?: boolean
  onOpen: (id: string) => void
  onAddChild: (parentId: string) => void
}

const STATUS_COLOR: Record<AgentConfig['status'], string> = {
  idle: 'var(--c-status-idle)',
  active: 'var(--c-status-active)',
  working: 'var(--c-status-working)'
}

export function AgentNode({ data }: { data: AgentNodeData }): React.JSX.Element {
  const { agent, childCount, isRoot, onOpen, onAddChild } = data

  if (isRoot) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 18px',
          borderRadius: 999,
          border: '1px solid var(--c-panel-border-strong)',
          background: 'rgba(212,175,55,0.12)',
          boxShadow: '0 0 24px rgba(212,175,55,0.15)'
        }}
      >
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        <span
          style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--c-gold)' }}
        />
        <span className="tracked-label" style={{ color: 'var(--c-gold-bright)', fontSize: 13 }}>
          DALVE
        </span>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        onClick={() => onOpen(agent.id)}
        style={{
          width: 190,
          padding: '12px 14px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--c-panel-border)',
          background: 'var(--c-panel)',
          backdropFilter: 'blur(10px)',
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: 4,
              background: agent.color,
              flexShrink: 0
            }}
          />
          <span
            style={{
              fontSize: 13.5,
              color: 'var(--c-text-1)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {agent.name}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="tracked-label" style={{ fontSize: 9, color: 'var(--c-text-3)' }}>
            {agent.type}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 9,
              letterSpacing: '0.1em',
              color: STATUS_COLOR[agent.status]
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: STATUS_COLOR[agent.status]
              }}
            />
            {agent.status.toUpperCase()}
          </span>
        </div>

        {childCount > 0 && (
          <div style={{ fontSize: 10, color: 'var(--c-text-3)', marginTop: 6 }}>
            {childCount} {agent.type === 'companion' && childCount === 1 ? 'bot' : agent.type === 'companion' ? 'bots' : 'children'}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      <button
        onClick={(e) => {
          e.stopPropagation()
          onAddChild(agent.id)
        }}
        title={`Spawn a bot under ${agent.name}`}
        style={{
          position: 'absolute',
          bottom: -12,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 22,
          height: 22,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--c-panel-border-strong)',
          background: 'var(--c-bg-soft)',
          color: 'var(--c-gold)'
        }}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
