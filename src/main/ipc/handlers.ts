import { app, ipcMain, shell, BrowserWindow, dialog } from 'electron'
import log from 'electron-log/main'
import { readFileSync } from 'fs'
import { settingsStore } from '../lib/settingsStore'
import { agentStore } from '../lib/agentStore'
import { generateAgentFromPrompt } from '../lib/agentGenerator'
import * as geminiLive from '../lib/geminiLive'
import * as groqVoice from '../lib/groqVoice'
import * as composio from '../lib/composio'
import * as screenControl from '../lib/screenControl'
import * as autonomousTask from '../lib/autonomousTask'
import * as cloudSync from '../lib/cloudSync'
import * as handTracking from '../lib/handTracking'
import * as arObjects from '../lib/arObjects'
import * as mcpClient from '../lib/mcpClient'
import { scheduleStore } from '../lib/scheduleStore'
import type { AgentConfig, BuiltinWakeWord, DalveTone, HandFrame, ScheduleItem, ScheduleRecurrence } from '@shared/types'

export function registerIpcHandlers(): void {
  // Lets the UI show the real running version, e.g. to confirm an auto-update actually landed
  // instead of just trusting that it did.
  ipcMain.handle('app:getVersion', () => app.getVersion())
  // Called once at launch to drive the "you're on vX" / "just updated to vX" startup popup.
  ipcMain.handle('app:checkVersionUpdate', () => settingsStore.checkVersionUpdate(app.getVersion()))

  // --- Logs (an in-app viewer so the user doesn't need to hand a log file over to debug) ---
  ipcMain.handle('logs:read', (_e, filter: 'all' | 'warnErr', maxLines: number) => {
    try {
      const path = log.transports.file.getFile().path
      const raw = readFileSync(path, 'utf-8')
      let lines = raw.split(/\r?\n/).filter(Boolean)
      if (filter === 'warnErr') lines = lines.filter((l) => /\[(warn|error)\]/i.test(l))
      return { path, lines: lines.slice(-maxLines) }
    } catch (err) {
      return { path: '', lines: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  // --- Settings ---
  ipcMain.handle('settings:get', () => settingsStore.getState())

  ipcMain.handle('settings:setGeminiKey', (_e, key: string) => {
    settingsStore.setGeminiApiKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setAnthropicKey', (_e, key: string) => {
    settingsStore.setAnthropicApiKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setTelegramBotToken', (_e, token: string) => {
    settingsStore.setTelegramBotToken(token)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setGroqKey', (_e, key: string) => {
    settingsStore.setGroqApiKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setElevenLabsKey', (_e, key: string) => {
    settingsStore.setElevenLabsApiKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setElevenLabsVoice', (_e, voiceId: string, voiceName: string) => {
    settingsStore.setElevenLabsVoice(voiceId, voiceName)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setVoiceEngine', (_e, engine: 'gemini' | 'groq') => {
    settingsStore.setVoiceEngine(engine)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setDalveTone', (_e, tone: DalveTone) => {
    settingsStore.setDalveTone(tone)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setPicovoiceAccessKey', (_e, key: string) => {
    settingsStore.setPicovoiceAccessKey(key)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setWakeWordEnabled', (_e, enabled: boolean) => {
    settingsStore.setWakeWordEnabled(enabled)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:setWakeWordKeyword', (_e, keyword: BuiltinWakeWord | 'custom', customPath?: string) => {
    settingsStore.setWakeWordKeyword(keyword, customPath)
    return settingsStore.getState()
  })

  ipcMain.handle('settings:pickWakeWordFile', async (_e) => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Porcupine keyword file', extensions: ['ppn'] }] })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Porcupine keyword file', extensions: ['ppn'] }] })
    return result.canceled ? null : result.filePaths[0]
  })

  // Lets a voice be added by ID directly — needed for shared/library ElevenLabs voices that
  // never show up via /v2/voices for this account but are still usable for TTS by id.
  ipcMain.handle('settings:addElevenLabsCustomVoice', (_e, voiceId: string, name: string) => {
    return settingsStore.addElevenLabsCustomVoice(voiceId, name)
  })

  ipcMain.handle('settings:removeElevenLabsCustomVoice', (_e, voiceId: string) => {
    return settingsStore.removeElevenLabsCustomVoice(voiceId)
  })

  // Real ElevenLabs voice list, fetched with whatever key is currently saved — lets the Settings
  // screen offer an actual picker instead of asking the user to paste a raw voice ID by hand.
  ipcMain.handle('settings:listElevenLabsVoices', async () => {
    const apiKey = settingsStore.getElevenLabsApiKey()
    if (!apiKey) throw new Error('Add your ElevenLabs API key first.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let res: Response
    try {
      res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', {
        headers: { 'xi-api-key': apiKey },
        signal: controller.signal
      })
    } catch (err) {
      throw err instanceof Error && err.name === 'AbortError'
        ? new Error('ElevenLabs took too long to respond.')
        : err
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`ElevenLabs voice list failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { voices: { voice_id: string; name: string; category?: string }[] }
    return data.voices.map((v) => ({ voiceId: v.voice_id, name: v.name, category: v.category }))
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
    anthropicApiKey: settingsStore.getAnthropicApiKey() ?? null,
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
    async (_e, server: { name: string; url: string; authHeader?: string; authToken?: string }) => {
      const state = settingsStore.addMcpServer(server)
      const added = state.mcpServers[state.mcpServers.length - 1]
      const config = settingsStore.getMcpServerConfigs().find((s) => s.id === added.id)
      if (config) void mcpClient.connectServer(config) // connects async — Settings reflects the real result once it resolves, not a guess made here
      return state
    }
  )

  ipcMain.handle('settings:removeMcpServer', (_e, id: string) => {
    mcpClient.disconnectServer(id)
    return settingsStore.removeMcpServer(id)
  })

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

  // --- Schedule (calendar tab: reminders + recurring messages) ---
  ipcMain.handle('schedule:list', () => scheduleStore.list())

  ipcMain.handle(
    'schedule:add',
    (
      _e,
      item: { title: string; type: 'reminder' | 'message'; instruction?: string; dueAt: number; recurrence: ScheduleRecurrence }
    ) => scheduleStore.add(item)
  )

  ipcMain.handle('schedule:update', (_e, id: string, patch: Partial<ScheduleItem>) => scheduleStore.update(id, patch))

  ipcMain.handle('schedule:remove', (_e, id: string) => scheduleStore.remove(id))

  // --- Voice (Gemini Live, or Groq+ElevenLabs — see settingsStore.voiceEngine) ---
  // Kept as two full, independent engines rather than one merged with branches throughout —
  // Gemini Live is a true bidirectional streaming session or none at all, while the Groq engine
  // is a record/transcribe/reason/synthesize cascade with its own VAD; forcing one code path to
  // cover both would leak one engine's assumptions into the other everywhere.
  function activeEngine(): typeof geminiLive | typeof groqVoice {
    return settingsStore.getVoiceEngine() === 'groq' ? groqVoice : geminiLive
  }

  ipcMain.handle('voice:start', async (_e, agentId?: string | null) => {
    try {
      await activeEngine().startVoiceSession(agentId ?? null)
    } catch (err) {
      console.error('[voice:start] failed:', err)
      throw err
    }
  })

  ipcMain.handle('voice:stop', () => {
    activeEngine().stopVoiceSession()
  })

  ipcMain.handle('voice:sendText', (_e, text: string) => {
    activeEngine().sendText(text)
  })

  ipcMain.on('voice:audioChunk', (_e, base64: string) => {
    activeEngine().sendAudioChunk(base64)
  })

  // --- Screen control ---
  // The global kill-switch: revokes standing permission and stops sharing immediately,
  // regardless of what DALVE is mid-way through doing.
  ipcMain.handle('screenControl:stop', () => screenControl.stopAll())

  // --- Hand tracking ---
  ipcMain.handle('handTracking:stop', () => handTracking.stop())
  // High-frequency (per-frame) — ipcMain.on, not handle, since there's nothing to await or
  // return per frame and a round-trip Promise per frame would just add latency to the cursor.
  ipcMain.on('handTracking:frame', (_e, frame: HandFrame) => {
    handTracking.onFrame(frame)
  })
  ipcMain.on('handTracking:rendererStopped', () => handTracking.reportStopped())

  // --- Spatial AR objects ---
  ipcMain.handle('ar:clear', () => arObjects.clear())

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
