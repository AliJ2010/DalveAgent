import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentConfig,
  AutonomousTaskEvent,
  ComposioCatalogEntry,
  HandFrame,
  ScreenControlEvent,
  SettingsState,
  VoiceEvent
} from '@shared/types'

const dalveApi = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
    checkVersionUpdate: (): Promise<{ version: string; justUpdated: boolean; previousVersion?: string }> =>
      ipcRenderer.invoke('app:checkVersionUpdate')
  },
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    setGeminiKey: (key: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setGeminiKey', key),
    setAnthropicKey: (key: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setAnthropicKey', key),
    setTelegramBotToken: (token: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setTelegramBotToken', token),
    setGroqKey: (key: string): Promise<SettingsState> => ipcRenderer.invoke('settings:setGroqKey', key),
    setElevenLabsKey: (key: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setElevenLabsKey', key),
    setElevenLabsVoice: (voiceId: string, voiceName: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setElevenLabsVoice', voiceId, voiceName),
    setVoiceEngine: (engine: 'gemini' | 'groq'): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setVoiceEngine', engine),
    listElevenLabsVoices: (): Promise<{ voiceId: string; name: string; category?: string }[]> =>
      ipcRenderer.invoke('settings:listElevenLabsVoices'),
    addElevenLabsCustomVoice: (voiceId: string, name: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:addElevenLabsCustomVoice', voiceId, name),
    removeElevenLabsCustomVoice: (voiceId: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:removeElevenLabsCustomVoice', voiceId),
    setComposioKey: (key: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setComposioKey', key),
    setDalveVoice: (voice: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setDalveVoice', voice),
    setDalveMemory: (memory: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setDalveMemory', memory),
    updateComposioConnection: (
      appKey: string,
      patch: { connected?: boolean; connectedAccountId?: string }
    ): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:updateComposioConnection', appKey, patch),
    connectComposioApp: (appKey: string, appName: string, logo?: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:connectComposioApp', appKey, appName, logo),
    connectComposioApiKeyApp: (
      appKey: string,
      apiKeyValue: string,
      appName?: string,
      logo?: string
    ): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:connectComposioApiKeyApp', appKey, apiKeyValue, appName, logo),
    listComposioCatalog: (): Promise<ComposioCatalogEntry[]> =>
      ipcRenderer.invoke('composio:listCatalog'),
    addMcpServer: (server: {
      name: string
      url: string
      authHeader?: string
      authToken?: string
    }): Promise<SettingsState> => ipcRenderer.invoke('settings:addMcpServer', server),
    removeMcpServer: (id: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:removeMcpServer', id),
    /** Manual device-to-device key transfer — call from DevTools console on the device that HAS
     *  the key, then paste the values into the Settings screen on the device that doesn't. */
    getRawKeys: (): Promise<{
      geminiApiKey: string | null
      anthropicApiKey: string | null
      composioApiKey: string | null
    }> => ipcRenderer.invoke('settings:getRawKeys'),
    /** Fires whenever settings change for ANY reason, including a remote update arriving via
     *  cloud sync from another device — that's what makes cross-device sync show up live. */
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
  },
  agents: {
    list: (): Promise<AgentConfig[]> => ipcRenderer.invoke('agents:list'),
    create: (partial: Partial<AgentConfig> & { name: string }): Promise<AgentConfig> =>
      ipcRenderer.invoke('agents:create', partial),
    createFromPrompt: (prompt: string, parentId: string | null): Promise<AgentConfig> =>
      ipcRenderer.invoke('agents:createFromPrompt', prompt, parentId),
    update: (id: string, patch: Partial<AgentConfig>): Promise<AgentConfig> =>
      ipcRenderer.invoke('agents:update', id, patch),
    archive: (id: string): Promise<AgentConfig> => ipcRenderer.invoke('agents:archive', id),
    restore: (id: string): Promise<AgentConfig> => ipcRenderer.invoke('agents:restore', id),
    /** Permanent delete — unlike archive/restore this cannot be undone. */
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('agents:remove', id),
    /** Fires whenever agents change for ANY reason, including a remote update arriving via
     *  cloud sync from another device. */
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('agents:changed', listener)
      return () => ipcRenderer.removeListener('agents:changed', listener)
    }
  },
  voice: {
    start: (agentId?: string | null): Promise<void> => ipcRenderer.invoke('voice:start', agentId),
    stop: (): Promise<void> => ipcRenderer.invoke('voice:stop'),
    sendText: (text: string): Promise<void> => ipcRenderer.invoke('voice:sendText', text),
    sendAudioChunk: (base64Pcm16: string): void =>
      ipcRenderer.send('voice:audioChunk', base64Pcm16),
    onEvent: (callback: (event: VoiceEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: VoiceEvent): void =>
        callback(payload)
      ipcRenderer.on('voice:event', listener)
      return () => ipcRenderer.removeListener('voice:event', listener)
    }
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  screenControl: {
    stop: (): Promise<void> => ipcRenderer.invoke('screenControl:stop'),
    onEvent: (callback: (event: ScreenControlEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: ScreenControlEvent): void =>
        callback(payload)
      ipcRenderer.on('screenControl:event', listener)
      return () => ipcRenderer.removeListener('screenControl:event', listener)
    }
  },
  wake: {
    onTriggered: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('wake:triggered', listener)
      return () => ipcRenderer.removeListener('wake:triggered', listener)
    }
  },
  autonomousTask: {
    stop: (): Promise<void> => ipcRenderer.invoke('autonomousTask:stop'),
    getState: (): Promise<{ active: boolean; goal: string | null }> =>
      ipcRenderer.invoke('autonomousTask:getState'),
    onEvent: (callback: (event: AutonomousTaskEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AutonomousTaskEvent): void =>
        callback(payload)
      ipcRenderer.on('autonomousTask:event', listener)
      return () => ipcRenderer.removeListener('autonomousTask:event', listener)
    }
  },
  handTracking: {
    stop: (): Promise<{ status: 'SUCCESS'; message: string }> => ipcRenderer.invoke('handTracking:stop'),
    sendFrame: (frame: HandFrame): void => ipcRenderer.send('handTracking:frame', frame),
    onStart: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('handTracking:start', listener)
      return () => ipcRenderer.removeListener('handTracking:start', listener)
    },
    onStop: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('handTracking:stop', listener)
      return () => ipcRenderer.removeListener('handTracking:stop', listener)
    }
  },
  cloud: {
    isConfigured: (): Promise<boolean> => ipcRenderer.invoke('cloud:isConfigured'),
    getSession: (): Promise<{ signedIn: boolean; email?: string }> => ipcRenderer.invoke('cloud:getSession'),
    signUp: (email: string, password: string): Promise<{ error?: string }> =>
      ipcRenderer.invoke('cloud:signUp', email, password),
    signIn: (email: string, password: string): Promise<{ error?: string }> =>
      ipcRenderer.invoke('cloud:signIn', email, password),
    signOut: (): Promise<void> => ipcRenderer.invoke('cloud:signOut')
  }
}

export type DalveApi = typeof dalveApi

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('dalve', dalveApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.dalve = dalveApi
}
