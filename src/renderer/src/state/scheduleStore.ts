import { create } from 'zustand'
import type { ScheduleItem, ScheduleRecurrence } from '@shared/types'

interface ScheduleStoreState {
  items: ScheduleItem[]
  loading: boolean
  refresh: () => Promise<void>
  add: (item: { title: string; type: 'reminder' | 'message'; instruction?: string; dueAt: number; recurrence: ScheduleRecurrence }) => Promise<void>
  update: (id: string, patch: Partial<ScheduleItem>) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useScheduleStore = create<ScheduleStoreState>((set, get) => ({
  items: [],
  loading: false,

  refresh: async () => {
    set({ loading: true })
    const items = await window.dalve.schedule.list()
    set({ items, loading: false })
  },

  add: async (item) => {
    const created = await window.dalve.schedule.add(item)
    set({ items: [...get().items, created] })
  },

  update: async (id, patch) => {
    const updated = await window.dalve.schedule.update(id, patch)
    if (!updated) return
    set({ items: get().items.map((i) => (i.id === id ? updated : i)) })
  },

  remove: async (id) => {
    const ok = await window.dalve.schedule.remove(id)
    if (!ok) return
    set({ items: get().items.filter((i) => i.id !== id) })
  }
}))
