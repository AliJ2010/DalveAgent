import { useEffect } from 'react'
import { useAgentsStore } from '../state/agentsStore'
import { useVoiceStore } from '../state/voiceStore'
import { switchActiveAgent } from '../lib/voiceSession'
import { ParticleSphere } from './ParticleSphere'
import { hexToRgbString } from '../lib/color'

const DALVE_GOLD = '#d4af37'

export function AgentSwitcher(): React.JSX.Element {
  const agents = useAgentsStore((s) => s.agents)
  const refresh = useAgentsStore((s) => s.refresh)
  const activeAgentId = useVoiceStore((s) => s.activeAgentId)

  useEffect(() => {
    refresh()
  }, [refresh])

  const companions = agents.filter((a) => !a.archived && a.type === 'companion')

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
      <SwitcherAvatar
        label="DALVE"
        color={DALVE_GOLD}
        active={activeAgentId === null}
        onClick={() => switchActiveAgent(null)}
      />
      {companions.map((a) => (
        <SwitcherAvatar
          key={a.id}
          label={a.name}
          color={a.color}
          active={activeAgentId === a.id}
          onClick={() => switchActiveAgent(a.id)}
        />
      ))}
    </div>
  )
}

function SwitcherAvatar({
  label,
  color,
  active,
  onClick
}: {
  label: string
  color: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={`Talk to ${label}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        borderRadius: 12,
        transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease',
        transform: active ? 'scale(1)' : 'scale(0.72)',
        opacity: active ? 1 : 0.45
      }}
    >
      <div
        style={{
          borderRadius: '50%',
          boxShadow: active ? `0 0 14px ${color}55` : 'none',
          transition: 'box-shadow 260ms ease'
        }}
      >
        <ParticleSphere size={active ? 46 : 34} color={hexToRgbString(color)} pointCount={90} speed={0.8} />
      </div>
      <span
        className="tracked-label"
        style={{ fontSize: 8, color: active ? 'var(--c-text-1)' : 'var(--c-text-3)' }}
      >
        {label}
      </span>
    </button>
  )
}
