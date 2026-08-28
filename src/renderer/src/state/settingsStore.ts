import { create } from 'zustand'
import type { ComposioCatalogEntry, SettingsState } from '@shared/types'

interface SettingsStoreState {
  settings: SettingsState | null
  loading: boolean
  refresh: () => Promise<void>
  setGeminiKey: (key: string) => Promise<void>
  setAnthropicKey: (key: string) => Promise<void>
  setTelegramBotToken: (token: string) => Promise<void>
  setGroqKey: (key: string) => Promise<void>
  setElevenLabsKey: (key: string) => Promise<void>
  setElevenLabsVoice: (voiceId: string, voiceName: string) => Promise<void>
  addElevenLabsCustomVoice: (voiceId: string, name: string) => Promise<void>
  removeElevenLabsCustomVoice: (voiceId: string) => Promise<void>
  setVoiceEngine: (engine: 'gemini' | 'groq') => Promise<void>
  elevenLabsVoices: { voiceId: string; name: string; category?: string }[]
  elevenLabsVoicesError: string | null
  loadElevenLabsVoices: (force?: boolean) => Promise<void>
  setComposioKey: (key: string) => Promise<void>
  setDalveVoice: (voice: string) => Promise<void>
  setDalveMemory: (memory: string) => Promise<void>
  connectingApp: string | null
  connectComposioApp: (appKey: string, appName: string, logo?: string) => Promise<void>
  connectComposioApiKeyApp: (
    appKey: string,
    apiKeyValue: string,
    appName?: string,
    logo?: string
  ) => Promise<void>
  disconnectComposioApp: (appKey: string) => Promise<void>
  addMcpServer: (server: {
    name: string
    url: string
    authHeader?: string
    authToken?: string
  }) => Promise<void>
  removeMcpServer: (id: string) => Promise<void>

  catalog: ComposioCatalogEntry[]
  catalogLoading: boolean
  catalogError: string | null
  loadCatalog: () => Promise<void>
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: null,
  loading: false,
  connectingApp: null,
  catalog: [],
  catalogLoading: false,
  catalogError: null,
  elevenLabsVoices: [],
  elevenLabsVoicesError: null,

  refresh: async () => {
    set({ loading: true })
    const settings = await window.dalve.settings.get()
    set({ settings, loading: false })
  },

  setGeminiKey: async (key) => {
    const settings = await window.dalve.settings.setGeminiKey(key)
    set({ settings })
  },

  setAnthropicKey: async (key) => {
    const settings = await window.dalve.settings.setAnthropicKey(key)
    set({ settings })
  },

  setTelegramBotToken: async (token) => {
    const settings = await window.dalve.settings.setTelegramBotToken(token)
    set({ settings })
  },

  setGroqKey: async (key) => {
    const settings = await window.dalve.settings.setGroqKey(key)
    set({ settings })
  },

  setElevenLabsKey: async (key) => {
    const settings = await window.dalve.settings.setElevenLabsKey(key)
    set({ settings })
  },

  setElevenLabsVoice: async (voiceId, voiceName) => {
    const settings = await window.dalve.settings.setElevenLabsVoice(voiceId, voiceName)
    set({ settings })
  },

  addElevenLabsCustomVoice: async (voiceId, name) => {
    const settings = await window.dalve.settings.addElevenLabsCustomVoice(voiceId, name)
    set({ settings })
  },

  removeElevenLabsCustomVoice: async (voiceId) => {
    const settings = await window.dalve.settings.removeElevenLabsCustomVoice(voiceId)
    set({ settings })
  },

  setVoiceEngine: async (engine) => {
    const settings = await window.dalve.settings.setVoiceEngine(engine)
    set({ settings })
  },

  loadElevenLabsVoices: async (force = false) => {
    if (!force && get().elevenLabsVoices.length > 0) return
    set({ elevenLabsVoicesError: null })
    try {
      const voices = await window.dalve.settings.listElevenLabsVoices()
      set({ elevenLabsVoices: voices })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load voices.'
      console.error('[settings] failed to load ElevenLabs voices:', err)
      set({ elevenLabsVoicesError: message })
    }
  },

  setComposioKey: async (key) => {
    const settings = await window.dalve.settings.setComposioKey(key)
    set({ settings, catalog: [], catalogError: null })
  },

  setDalveVoice: async (voice) => {
    const settings = await window.dalve.settings.setDalveVoice(voice)
    set({ settings })
  },

  setDalveMemory: async (memory) => {
    const settings = await window.dalve.settings.setDalveMemory(memory)
    set({ settings })
  },

  connectComposioApp: async (appKey, appName, logo) => {
    set({ connectingApp: appKey })
    try {
      const settings = await window.dalve.settings.connectComposioApp(appKey, appName, logo)
      set({ settings })
    } finally {
      set({ connectingApp: null })
    }
    await get().refresh()
  },

  connectComposioApiKeyApp: async (appKey, apiKeyValue, appName, logo) => {
    set({ connectingApp: appKey })
    try {
      const settings = await window.dalve.settings.connectComposioApiKeyApp(
        appKey,
        apiKeyValue,
        appName,
        logo
      )
      set({ settings })
    } finally {
      set({ connectingApp: null })
    }
    await get().refresh()
  },

  disconnectComposioApp: async (appKey) => {
    const settings = await window.dalve.settings.updateComposioConnection(appKey, {
      connected: false,
      connectedAccountId: undefined
    })
    set({ settings })
  },

  addMcpServer: async (server) => {
    const settings = await window.dalve.settings.addMcpServer(server)
    set({ settings })
  },

  removeMcpServer: async (id) => {
    const settings = await window.dalve.settings.removeMcpServer(id)
    set({ settings })
  },

  loadCatalog: async () => {
    if (get().catalog.length > 0 || get().catalogLoading) return
    set({ catalogLoading: true, catalogError: null })
    try {
      const catalog = await window.dalve.settings.listComposioCatalog()
      set({ catalog, catalogLoading: false })
    } catch (err) {
      set({
        catalogLoading: false,
        catalogError: err instanceof Error ? err.message : 'Failed to load the app catalog.'
      })
    }
  }
}))
