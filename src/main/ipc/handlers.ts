import { ipcMain, shell, BrowserWindow } from 'electron'
import { settingsStore } from '../lib/settingsStore'
import { agentStore } from '../lib/agentStore'
import { generateAgentFromPrompt } from '../lib/agentGenerator'
import * as geminiLive from '../lib/geminiLive'
import * as composio from '../lib/composio'
import type { AgentConfig } from '@shared/types'

export function registerIpcHandlers(): void {
  // --- Settings ---
  ipcMain.handle('settings:get', () => settingsStore.getState())

  ipcMain.handle('settings:setGeminiKey', (_e, key: string) => {
    settingsStore.setGeminiApiKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setComposioKey', async (_e, key: string) => {
    if (key) {
      await composio.validateApiKey(key)
    }
    settingsStore.setComposioApiKey(key)
    composio.resetComposioClient()
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setDalveVoice', (_e, voice: string) => {
    settingsStore.setDalveVoice(voice)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setDalveMemory', (_e, memory: string) => {
    settingsStore.setDalveMemory(memory)
    return settingsStore.getState()
  })

  ipcMain.handle(
    'settings:updateComposioConnection',
    (_e, appKey: string, patch: { connected?: boolean; connectedAccountId?: string }) =>
      settingsStore.updateComposioConnection(appKey, patch)
  )

  ipcMain.handle('composio:listCatalog', () => composio.listToolkitCatalog())

  // Real Composio-hosted OAuth flow — works for any toolkit slug from the catalog.
  ipcMain.handle(
    'settings:connectComposioApp',
    async (_e, appKey: string, appName: string, logo?: string) => {
      const { redirectUrl, connectedAccountId } = await composio.beginOAuthConnect(appKey)

      const authWindow = new BrowserWindow({
        width: 480,
        height: 720,
        title: `Connect ${appName}`,
        autoHideMenuBar: true,
        webPreferences: { sandbox: true }
      })

      let windowClosedEarly = false
      authWindow.on('closed', () => {
        windowClosedEarly = true
      })

      authWindow.loadURL(redirectUrl)

      let connected = await composio.waitForConnection(connectedAccountId, 120000)
      if (!connected && windowClosedEarly) {
        // The window may have closed right as the OAuth flow finished server-side — check once more.
        connected = await composio.waitForConnection(connectedAccountId, 3000)
      }

      if (!authWindow.isDestroyed()) authWindow.close()

      if (connected) {
        return settingsStore.updateComposioConnection(appKey, {
          appName,
          logo,
          connected: true,
          connectedAccountId
        })
      }
      console.error(`[composio] ${appKey} connection did not complete`)
      return settingsStore.getState()
    }
  )

  // Direct API-key connection for apps like Stripe — no OAuth popup needed.
  ipcMain.handle(
    'settings:connectComposioApiKeyApp',
    async (_e, appKey: string, apiKeyValue: string, appName?: string, logo?: string) => {
      try {
        const connectedAccountId = await composio.connectWithApiKey(appKey, apiKeyValue)
        return settingsStore.updateComposioConnection(appKey, {
          appName: appName ?? appKey,
          logo,
          connected: true,
          connectedAccountId
        })
      } catch (err) {
        console.error(`[composio] API key connect failed for ${appKey}:`, err)
        throw err
      }
    }
  )

  ipcMain.handle(
    'settings:addMcpServer',
    (_e, server: { name: string; url: string; authHeader?: string; authToken?: string }) =>
      settingsStore.addMcpServer(server)
  )

  ipcMain.handle('settings:removeMcpServer', (_e, id: string) => settingsStore.removeMcpServer(id))

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // --- Agents ---
  ipcMain.handle('agents:list', () => agentStore.list())

  ipcMain.handle('agents:create', (_e, partial: Partial<AgentConfig> & { name: string }) =>
    agentStore.create(partial)
  )

  ipcMain.handle('agents:createFromPrompt', (_e, prompt: string, parentId: string | null) => {
    const generated = generateAgentFromPrompt(prompt, parentId)
    return agentStore.create(generated)
  })

  ipcMain.handle('agents:update', (_e, id: string, patch: Partial<AgentConfig>) =>
    agentStore.update(id, patch)
  )

  ipcMain.handle('agents:archive', (_e, id: string) => agentStore.setArchived(id, true))

  ipcMain.handle('agents:restore', (_e, id: string) => agentStore.setArchived(id, false))

  // --- Voice (Gemini Live) ---
  ipcMain.handle('voice:start', async (_e, agentId?: string | null) => {
    try {
      await geminiLive.startVoiceSession(agentId ?? null)
    } catch (err) {
      console.error('[voice:start] failed:', err)
      throw err
    }
  })

  ipcMain.handle('voice:stop', () => {
    geminiLive.stopVoiceSession()
  })

  ipcMain.handle('voice:sendText', (_e, text: string) => {
    geminiLive.sendText(text)
  })

  ipcMain.on('voice:audioChunk', (_e, base64: string) => {
    geminiLive.sendAudioChunk(base64)
  })
}
