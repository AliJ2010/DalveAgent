import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentConfig,
  AutonomousTaskEvent,
  ComposioCatalogEntry,
  ScreenControlEvent,
  SettingsState,
  VoiceEvent
} from '@shared/types'

const dalveApi = {
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    setGeminiKey: (key: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setGeminiKey', key),
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
      ipcRenderer.invoke('settings:removeMcpServer', id)
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
    restore: (id: string): Promise<AgentConfig> => ipcRenderer.invoke('agents:restore', id)
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
