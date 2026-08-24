import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AgentConfig, ComposioCatalogEntry, SettingsState, VoiceEvent } from '@shared/types'

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
