import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { ComposioConnection, McpServerConfig, SettingsState } from '@shared/types'
import { PRIORITY_COMPOSIO_APPS } from '@shared/types'

interface StoredSecrets {
  geminiApiKey?: string // base64-encoded, safeStorage-encrypted
  composioApiKey?: string // base64-encoded, safeStorage-encrypted
  composioConnections: ComposioConnection[]
  composioAuthConfigIds: Record<string, string> // appKey -> Composio auth config id, created once and reused
  mcpServers: (Omit<McpServerConfig, 'authToken'> & { authToken?: string })[] // authToken is encrypted
  dalveVoice: string
  dalveMemory: string
}

function defaultStore(): StoredSecrets {
  return {
    composioConnections: PRIORITY_COMPOSIO_APPS.map((a) => ({
      appKey: a.key,
      appName: a.name,
      connected: false
    })),
    composioAuthConfigIds: {},
    mcpServers: [],
    dalveVoice: 'Kore',
    dalveMemory: ''
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'dalve-settings.json')
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secret encryption is not available on this machine.')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(encoded: string): string {
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
}

class SettingsStore {
  private data: StoredSecrets

  constructor() {
    this.data = this.load()
  }

  private load(): StoredSecrets {
    const path = settingsPath()
    if (!existsSync(path)) return defaultStore()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      return { ...defaultStore(), ...raw }
    } catch {
      return defaultStore()
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(this.data, null, 2), 'utf-8')
  }

  getState(): SettingsState {
    return {
      geminiApiKeySet: !!this.data.geminiApiKey,
      composioApiKeySet: !!this.data.composioApiKey,
      composioConnections: this.data.composioConnections,
      mcpServers: this.data.mcpServers.map((s) => ({ ...s, authToken: s.authToken ? '••••••••' : undefined })),
      dalveVoice: this.data.dalveVoice,
      dalveMemory: this.data.dalveMemory
    }
  }

  setDalveVoice(voice: string): void {
    this.data.dalveVoice = voice
    this.persist()
  }

  getDalveVoice(): string {
    return this.data.dalveVoice
  }

  getDalveMemory(): string {
    return this.data.dalveMemory
  }

  appendDalveMemory(fact: string): void {
    this.data.dalveMemory = this.data.dalveMemory ? `${this.data.dalveMemory}\n- ${fact}` : `- ${fact}`
    this.persist()
  }

  setDalveMemory(memory: string): void {
    this.data.dalveMemory = memory
    this.persist()
  }

  setGeminiApiKey(key: string): void {
    this.data.geminiApiKey = key ? encrypt(key) : undefined
    this.persist()
  }

  setComposioApiKey(key: string): void {
    this.data.composioApiKey = key ? encrypt(key) : undefined
    this.persist()
  }

  /** Main-process-only accessor. Never exposed to the renderer over IPC. */
  getGeminiApiKey(): string | undefined {
    return this.data.geminiApiKey ? decrypt(this.data.geminiApiKey) : undefined
  }

  /** Main-process-only accessor. Never exposed to the renderer over IPC. */
  getComposioApiKey(): string | undefined {
    return this.data.composioApiKey ? decrypt(this.data.composioApiKey) : undefined
  }

  getComposioAuthConfigId(appKey: string): string | undefined {
    return this.data.composioAuthConfigIds[appKey]
  }

  setComposioAuthConfigId(appKey: string, authConfigId: string): void {
    this.data.composioAuthConfigIds[appKey] = authConfigId
    this.persist()
  }

  updateComposioConnection(appKey: string, patch: Partial<ComposioConnection>): SettingsState {
    const idx = this.data.composioConnections.findIndex((c) => c.appKey === appKey)
    if (idx >= 0) {
      this.data.composioConnections[idx] = { ...this.data.composioConnections[idx], ...patch }
    } else {
      this.data.composioConnections.push({
        appKey,
        appName: patch.appName ?? appKey,
        logo: patch.logo,
        connected: patch.connected ?? false,
        connectedAccountId: patch.connectedAccountId
      })
    }
    this.persist()
    return this.getState()
  }

  addMcpServer(server: { name: string; url: string; authHeader?: string; authToken?: string }): SettingsState {
    const id = `mcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    this.data.mcpServers.push({
      id,
      name: server.name,
      url: server.url,
      authHeader: server.authHeader,
      authToken: server.authToken ? encrypt(server.authToken) : undefined,
      connected: false,
      tools: []
    })
    this.persist()
    return this.getState()
  }

  removeMcpServer(id: string): SettingsState {
    this.data.mcpServers = this.data.mcpServers.filter((s) => s.id !== id)
    this.persist()
    return this.getState()
  }

  /** Main-process-only accessor for the real (decrypted) MCP server record. */
  getMcpServerSecrets(id: string): { authHeader?: string; authToken?: string } | undefined {
    const s = this.data.mcpServers.find((s) => s.id === id)
    if (!s) return undefined
    return { authHeader: s.authHeader, authToken: s.authToken ? decrypt(s.authToken) : undefined }
  }
}

export const settingsStore = new SettingsStore()
