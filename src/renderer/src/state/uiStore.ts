import { create } from 'zustand'

export type Screen = 'home' | 'integrations' | 'agents' | 'knowledge' | 'settings'

interface UiState {
  screen: Screen
  detailed: boolean
  setScreen: (screen: Screen) => void
  toggleDetailed: () => void
}

export const useUiStore = create<UiState>((set) => ({
  screen: 'home',
  detailed: true,
  setScreen: (screen) => set({ screen }),
  toggleDetailed: () => set((s) => ({ detailed: !s.detailed }))
}))
