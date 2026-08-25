import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { settingsStore } from '../lib/settingsStore'
import { agentStore } from '../lib/agentStore'
import { generateAgentFromPrompt } from '../lib/agentGenerator'
import * as geminiLive from '../lib/geminiLive'
import * as composio from '../lib/composio'
import * as screenControl from '../lib/screenControl'
import * as autonomousTask from '../lib/autonomousTask'
import * as cloudSync from '../lib/cloudSync'
import type { AgentConfig } from '@shared/types'

export function registerIpcHandlers(): void {
  // Lets the UI show the real running version, e.g. to confirm an auto-update actually landed
  // instead of just trusting that it did.
  ipcMain.handle('app:getVersion', () => app.getVersion())
  // Called once at launch to drive the "you're on vX" / "just updated to vX" startup popup.
  ipcMain.handle('app:checkVersionUpdate', () => settingsStore.checkVersionUpdate(app.getVersion()))

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

  // Manual device-to-device key transfer: read this on the device that HAS the key (DevTools
  // console -> `await window.dalve.settings.getRawKeys()`), paste the values into the Settings
  // screen on the device that doesn't. Exists because cloud sync of these two fields needs a
  // Supabase schema change the user has to apply by hand first — this works regardless of that.
  ipcMain.handle('settings:getRawKeys', () => ({
    geminiApiKey: settingsStore.getGeminiApiKey() ?? null,
    composioApiKey: settingsStore.getComposioApiKey() ?? null
  }))

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

      authWindow.loadURL(redirectUrl)

      const windowClosedByUser = new Promise<void>((resolve) => {
        authWindow.once('closed', () => resolve())
      })

      // Give the real flow room to breathe — multi-step OAuth (e.g. WhatsApp's Meta embedded
      // signup: login, business selection, phone verification) can easily run past a couple
      // of minutes. Previously this force-closed the window at 120s regardless of progress,
      // which is very likely why "Composio said connected" but the app still showed
      // disconnected — the user was still completing the flow when we yanked the window.
      // Only give up this early if the user (or an auto-closing success page) closes it.
      const connectionSettled = composio.waitForConnection(connectedAccountId, 10 * 60 * 1000)

      const raceResult = await Promise.race([
        connectionSettled.then((ok) => ({ ok, viaClose: false })),
        windowClosedByUser.then(() => ({ ok: false, viaClose: true }))
      ])

      let connected = raceResult.ok
      if (!connected && raceResult.viaClose) {
        // The window may have closed right as the OAuth flow finished server-side — check once more.
        connected = await composio.waitForConnection(connectedAccountId, 4000)
      }

      if (!authWindow.isDestroyed()) authWindow.close()

      // If we gave up via the window closing but the long-running check is still in flight,
      // let it keep going in the background and update the connection if it eventually lands —
      // so a flow that genuinely just needed more time doesn't silently require a full retry.
      if (!connected) {
        void connectionSettled.then((ok) => {
          if (ok) {
            settingsStore.updateComposioConnection(appKey, { appName, logo, connected: true, connectedAccountId })
          }
        })
      }

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

  ipcMain.handle('agents:remove', (_e, id: string) => agentStore.remove(id))

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

  // --- Screen control ---
  // The global kill-switch: revokes standing permission and stops sharing immediately,
  // regardless of what DALVE is mid-way through doing.
  ipcMain.handle('screenControl:stop', () => screenControl.stopAll())

  // --- Autonomous task ---
  ipcMain.handle('autonomousTask:stop', () => autonomousTask.stopAutonomousTask('stopped by user'))
  ipcMain.handle('autonomousTask:getState', () => ({
    active: autonomousTask.isActive(),
    goal: autonomousTask.getGoal()
  }))

  // --- Cloud account / sync ---
  ipcMain.handle('cloud:isConfigured', () => cloudSync.isConfigured())
  ipcMain.handle('cloud:getSession', () => cloudSync.getCurrentSession())
  ipcMain.handle('cloud:signUp', (_e, email: string, password: string) => cloudSync.signUp(email, password))
  ipcMain.handle('cloud:signIn', (_e, email: string, password: string) => cloudSync.signIn(email, password))
  ipcMain.handle('cloud:signOut', () => cloudSync.signOut())
}
