import { create } from 'zustand'
import type { AgentConfig } from '@shared/types'

interface AgentsStoreState {
  agents: AgentConfig[]
  loading: boolean
  selectedAgentId: string | null
  showArchived: boolean
  refresh: () => Promise<void>
  createFromPrompt: (prompt: string, parentId: string | null) => Promise<AgentConfig>
  createChild: (parentId: string, name: string) => Promise<AgentConfig>
  update: (id: string, patch: Partial<AgentConfig>) => Promise<void>
  archive: (id: string) => Promise<void>
  restore: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setStatus: (id: string, status: AgentConfig['status']) => void
  selectAgent: (id: string | null) => void
  setShowArchived: (show: boolean) => void
}

export const useAgentsStore = create<AgentsStoreState>((set, get) => ({
  agents: [],
  loading: false,
  selectedAgentId: null,
  showArchived: false,

  refresh: async () => {
    set({ loading: true })
    const agents = await window.dalve.agents.list()
    set({ agents, loading: false })
  },

  createFromPrompt: async (prompt, parentId) => {
    const agent = await window.dalve.agents.createFromPrompt(prompt, parentId)
    set({ agents: [...get().agents, agent] })
    return agent
  },

  createChild: async (parentId, name) => {
    const agent = await window.dalve.agents.create({ name, parentId, type: 'bot' })
    set({ agents: [...get().agents, agent] })
    return agent
  },

  update: async (id, patch) => {
    const updated = await window.dalve.agents.update(id, patch)
    if (!updated) return
    set({ agents: get().agents.map((a) => (a.id === id ? updated : a)) })
  },

  archive: async (id) => {
    const updated = await window.dalve.agents.archive(id)
    if (!updated) return
    set({ agents: get().agents.map((a) => (a.id === id ? updated : a)) })
  },

  restore: async (id) => {
    const updated = await window.dalve.agents.restore(id)
    if (!updated) return
    set({ agents: get().agents.map((a) => (a.id === id ? updated : a)) })
  },

  remove: async (id) => {
    const ok = await window.dalve.agents.remove(id)
    if (!ok) return
    set({ agents: get().agents.filter((a) => a.id !== id) })
  },

  // Optimistic, in-memory only — used to visualize live run state; the orchestrator phase
  // will call this as sub-agents actually start/finish work, then persist via update().
  setStatus: (id, status) => {
    set({ agents: get().agents.map((a) => (a.id === id ? { ...a, status } : a)) })
  },

  selectAgent: (id) => set({ selectedAgentId: id }),
  setShowArchived: (show) => set({ showArchived: show })
}))
