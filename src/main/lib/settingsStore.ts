import { app, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { ComposioConnection, McpServerConfig, SettingsState } from '@shared/types'
import { PRIORITY_COMPOSIO_APPS } from '@shared/types'

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

interface StoredSecrets {
  geminiApiKey?: string // base64-encoded, safeStorage-encrypted
  anthropicApiKey?: string // base64-encoded, safeStorage-encrypted
  composioApiKey?: string // base64-encoded, safeStorage-encrypted
  composioConnections: ComposioConnection[]
  composioAuthConfigIds: Record<string, string> // appKey -> Composio auth config id, created once and reused
  mcpServers: (Omit<McpServerConfig, 'authToken'> & { authToken?: string })[] // authToken is encrypted
  dalveVoice: string
  dalveMemory: string
  /** Local-only, deliberately not in SyncableSettings — this device's own last-seen version, so
   *  the "you just got updated to vX" popup can tell new-to-this-device apart from every launch. */
  lastSeenVersion?: string
  /** Local-only, deliberately not synced — a Telegram bot's long-poll (getUpdates) can only have
   *  one consumer at a time, so syncing this across devices would make two DALVE installs fight
   *  over the same bot's update stream. */
  telegramBotToken?: string // base64-encoded, safeStorage-encrypted
  /** The single chat allowed to issue remote commands — bound automatically to whichever chat
   *  first messages the bot after a token is saved, so a leaked/guessed bot token alone can't let
   *  a stranger control this PC. Cleared whenever the token changes. */
  telegramChatId?: string
  /** Local-only — OAuth client registration + tokens per MCP server (encrypted per-server JSON
   *  blob), keyed by server id. Never synced or exposed to the renderer; see mcpOAuth.ts. */
  mcpOAuthState: Record<string, string>
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
    dalveMemory: '',
    mcpOAuthState: {}
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

/** The subset of settings that syncs to the cloud. geminiApiKey/composioApiKey travel as
 *  plaintext here (the wire/cloud-row format) even though they're kept safeStorage-encrypted
 *  on disk locally — see cloudSync.ts for how that round-trip works. MCP auth tokens still stay
 *  device-local (per-server, less commonly needed on every machine, not asked for). */
export interface SyncableSettings {
  composioConnections: ComposioConnection[]
  mcpServers: StoredSecrets['mcpServers']
  dalveVoice: string
  dalveMemory: string
  geminiApiKey?: string
  anthropicApiKey?: string
  composioApiKey?: string
}

class SettingsStore {
  private data: StoredSecrets
  private changeListener: (() => void) | null = null
  private applyingRemote = false

  constructor() {
    this.data = this.load()
  }

  /** cloudSync registers this once signed in — called after every LOCAL settings mutation. */
  setChangeListener(cb: (() => void) | null): void {
    this.changeListener = cb
  }

  private notifyChange(): void {
    if (!this.applyingRemote) this.changeListener?.()
    this.notifyRenderer()
  }

  /** Always fires, including for remote-applied changes — so a settings change made on another
   *  device shows up on screen without needing to sign out and back in. */
  private notifyRenderer(): void {
    win?.webContents.send('settings:changed')
  }

  /** Applies settings received from the cloud without re-triggering a push back up. Only
   *  overwrites an API key locally if the remote actually has one — never wipes a key this
   *  device already has just because the cloud row hasn't caught up yet. */
  applyRemote(remote: SyncableSettings): void {
    this.applyingRemote = true
    try {
      this.data.composioConnections = remote.composioConnections
      this.data.mcpServers = remote.mcpServers
      this.data.dalveVoice = remote.dalveVoice
      this.data.dalveMemory = remote.dalveMemory
      if (remote.geminiApiKey) this.data.geminiApiKey = encrypt(remote.geminiApiKey)
      if (remote.anthropicApiKey) this.data.anthropicApiKey = encrypt(remote.anthropicApiKey)
      if (remote.composioApiKey) this.data.composioApiKey = encrypt(remote.composioApiKey)
      this.persist()
      this.notifyRenderer()
    } finally {
      this.applyingRemote = false
    }
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
      anthropicApiKeySet: !!this.data.anthropicApiKey,
      composioApiKeySet: !!this.data.composioApiKey,
      composioConnections: this.data.composioConnections,
      mcpServers: this.data.mcpServers.map((s) => ({ ...s, authToken: s.authToken ? '••••••••' : undefined })),
      dalveVoice: this.data.dalveVoice,
      dalveMemory: this.data.dalveMemory,
      telegramBotTokenSet: !!this.data.telegramBotToken,
      telegramChatBound: !!this.data.telegramChatId
    }
  }

  setDalveVoice(voice: string): void {
    this.data.dalveVoice = voice
    this.persist()
    this.notifyChange()
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
    this.notifyChange()
  }

  setDalveMemory(memory: string): void {
    this.data.dalveMemory = memory
    this.persist()
    this.notifyChange()
  }

  /**
   * Called once per launch. Compares the currently-running version against whatever this
   * device last recorded, so the UI can honestly say "just updated to vX" only when that's
   * actually true, instead of showing it on every single launch regardless.
   */
  checkVersionUpdate(currentVersion: string): { version: string; justUpdated: boolean; previousVersion?: string } {
    const previousVersion = this.data.lastSeenVersion
    const justUpdated = previousVersion !== undefined && previousVersion !== currentVersion
    this.data.lastSeenVersion = currentVersion
    this.persist()
    return { version: currentVersion, justUpdated, previousVersion }
  }

  setGeminiApiKey(key: string): void {
    this.data.geminiApiKey = key ? encrypt(key) : undefined
    this.persist()
    this.notifyChange()
  }

  setAnthropicApiKey(key: string): void {
    this.data.anthropicApiKey = key ? encrypt(key) : undefined
    this.persist()
    this.notifyChange()
  }

  setComposioApiKey(key: string): void {
    this.data.composioApiKey = key ? encrypt(key) : undefined
    this.persist()
    this.notifyChange()
  }

  /** Saving a new (or cleared) token invalidates any existing chat binding — a fresh token means
   *  a fresh bot, and the old binding shouldn't silently carry over to it. */
  setTelegramBotToken(token: string): void {
    this.data.telegramBotToken = token ? encrypt(token) : undefined
    this.data.telegramChatId = undefined
    this.persist()
    this.notifyChange()
  }

  getTelegramBotToken(): string | undefined {
    return this.data.telegramBotToken ? decrypt(this.data.telegramBotToken) : undefined
  }

  getTelegramChatId(): string | undefined {
    return this.data.telegramChatId
  }

  setTelegramChatId(chatId: string): void {
    this.data.telegramChatId = chatId
    this.persist()
  }

  /** Main-process-only accessor. Never exposed to the renderer over IPC. */
  getGeminiApiKey(): string | undefined {
    return this.data.geminiApiKey ? decrypt(this.data.geminiApiKey) : undefined
  }

  /** Main-process-only accessor. Never exposed to the renderer over IPC. */
  getAnthropicApiKey(): string | undefined {
    return this.data.anthropicApiKey ? decrypt(this.data.anthropicApiKey) : undefined
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
    this.notifyChange()
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
    this.notifyChange()
    return this.getState()
  }

  removeMcpServer(id: string): SettingsState {
    this.data.mcpServers = this.data.mcpServers.filter((s) => s.id !== id)
    this.persist()
    this.notifyChange()
    return this.getState()
  }

  /** Main-process-only accessor for the real (decrypted) MCP server record. */
  getMcpServerSecrets(id: string): { authHeader?: string; authToken?: string } | undefined {
    const s = this.data.mcpServers.find((s) => s.id === id)
    if (!s) return undefined
    return { authHeader: s.authHeader, authToken: s.authToken ? decrypt(s.authToken) : undefined }
  }

  /** Main-process-only: every stored server with its real (decrypted) auth token, for mcpClient.ts
   *  to actually connect with — getState()'s copy masks the token for the renderer. */
  getMcpServerConfigs(): McpServerConfig[] {
    return this.data.mcpServers.map((s) => ({ ...s, authToken: s.authToken ? decrypt(s.authToken) : undefined }))
  }

  /** Called by mcpClient.ts once a connection attempt (successful or not) resolves, so the
   *  Settings screen reflects real connection state instead of whatever addMcpServer initially
   *  guessed (always `connected: false` — nothing has actually tried connecting at that point). */
  updateMcpServerStatus(id: string, connected: boolean, tools: string[]): void {
    const s = this.data.mcpServers.find((s) => s.id === id)
    if (!s) return
    s.connected = connected
    s.tools = tools
    this.persist()
    this.notifyChange()
  }

  /** OAuth client registration + tokens for one MCP server, encrypted as a single blob — separate
   *  from the server's own record since this is main-process-only state (dynamically-registered
   *  client info, access/refresh tokens, a PKCE verifier mid-flow) that must never reach the
   *  renderer, unlike the rest of an McpServerConfig. */
  getMcpOAuthState(serverId: string): Record<string, unknown> | undefined {
    const encoded = this.data.mcpOAuthState[serverId]
    if (!encoded) return undefined
    try {
      return JSON.parse(decrypt(encoded)) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  setMcpOAuthState(serverId: string, state: Record<string, unknown>): void {
    this.data.mcpOAuthState[serverId] = encrypt(JSON.stringify(state))
    this.persist()
  }
}

// Lazily constructed: the constructor calls app.getPath('userData'), which depends on the
// app name. Building this eagerly at module-import time would run before main/index.ts gets
// a chance to call app.setName() — ES imports are hoisted ahead of all other statements
// regardless of source order, so "call setName first" in index.ts doesn't actually help unless
// nothing imported before it touches getPath(). A Proxy defers construction to first real use
// (inside an IPC handler, always after app.whenReady()) without changing any call site.
let _instance: SettingsStore | null = null
export const settingsStore = new Proxy({} as SettingsStore, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new SettingsStore()
    return Reflect.get(_instance, prop, receiver)
  }
})
