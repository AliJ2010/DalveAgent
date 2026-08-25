import { create } from 'zustand'

interface ScreenControlState {
  active: boolean
  setActive: (active: boolean) => void
}

export const useScreenControlStore = create<ScreenControlState>((set) => ({
  active: false,
  setActive: (active) => set({ active })
}))
