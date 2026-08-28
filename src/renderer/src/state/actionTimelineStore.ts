import { create } from 'zustand'

export interface TimelineEntry {
  id: string
  label: string
  detail?: string
  status: 'success' | 'error' | 'info'
  timestamp: number
  source: 'voice' | 'task'
}

interface ActionTimelineState {
  entries: TimelineEntry[]
  minimized: boolean
  addEntry: (entry: TimelineEntry) => void
  toggleMinimized: () => void
  clear: () => void
}

// Enough to scroll back through a genuinely long autonomous run without growing unbounded —
// old entries just roll off the front once this many have piled up.
const MAX_ENTRIES = 200

export const useActionTimelineStore = create<ActionTimelineState>((set, get) => ({
  entries: [],
  minimized: false,
  addEntry: (entry) => set({ entries: [...get().entries, entry].slice(-MAX_ENTRIES) }),
  toggleMinimized: () => set({ minimized: !get().minimized }),
  clear: () => set({ entries: [] })
}))
