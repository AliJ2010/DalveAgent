import { create } from 'zustand'

interface AutonomousTaskState {
  active: boolean
  goal: string | null
  log: string[]
  setActive: (active: boolean, goal: string | null) => void
  addLog: (text: string) => void
}

const MAX_LOG = 5

export const useAutonomousTaskStore = create<AutonomousTaskState>((set, get) => ({
  active: false,
  goal: null,
  log: [],
  setActive: (active, goal) => set({ active, goal, log: active ? get().log : [] }),
  addLog: (text) => set({ log: [...get().log, text].slice(-MAX_LOG) })
}))
