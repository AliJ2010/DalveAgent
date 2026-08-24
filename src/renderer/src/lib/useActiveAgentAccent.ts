import { useVoiceStore } from '../state/voiceStore'
import { useAgentsStore } from '../state/agentsStore'

const DALVE_GOLD = '#d4af37'

export interface ActiveAgentAccent {
  name: string
  hex: string
}

/** Resolves the display name + accent color for whoever the live session is currently talking to. */
export function useActiveAgentAccent(): ActiveAgentAccent {
  const activeAgentId = useVoiceStore((s) => s.activeAgentId)
  const agents = useAgentsStore((s) => s.agents)
  const agent = activeAgentId ? agents.find((a) => a.id === activeAgentId) : undefined
  return agent ? { name: agent.name, hex: agent.color } : { name: 'DALVE', hex: DALVE_GOLD }
}
