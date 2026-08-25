import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { AgentConfig } from '@shared/types'

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function agentsPath(): string {
  return join(app.getPath('userData'), 'dalve-agents.json')
}

function id(): string {
  return `agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

// One-time cleanup for a shipping bug: an auto-seed that used to run here created these 4
// placeholder companions on any machine that happened to launch with no local agents file yet
// (e.g. after a crash mid-write), and cloud sync then treated them as real user data and synced
// them everywhere. The seed is gone; this fingerprint lets pruneKnownSeedArtifacts() find and
// permanently remove any that already got created, on every device, automatically.
const KNOWN_BAD_SEED_FINGERPRINTS: { name: string; color: string }[] = [
  { name: 'Email', color: '#d4af37' },
  { name: 'Finance', color: '#c9a227' },
  { name: 'Messaging', color: '#e0b84a' },
  { name: 'Builder', color: '#f2d06b' }
]

class AgentStore {
  private data: AgentConfig[]
  private changeListener: (() => void) | null = null
  private deleteListener: ((id: string) => void) | null = null
  /** True while applying a remote (cloud) update — suppresses re-pushing it right back to the
   *  cloud, which would otherwise ping-pong forever between devices. */
  private applyingRemote = false

  constructor() {
    this.data = this.load()
  }

  /** cloudSync registers this once signed in — called after every LOCAL mutation. */
  setChangeListener(cb: (() => void) | null): void {
    this.changeListener = cb
  }

  /** cloudSync registers this once signed in — called after every LOCAL permanent deletion, so
   *  it cascades to the cloud row instead of the union-merge resurrecting it on next sign-in. */
  setDeleteListener(cb: ((id: string) => void) | null): void {
    this.deleteListener = cb
  }

  private notifyChange(): void {
    if (!this.applyingRemote) this.changeListener?.()
    this.notifyRenderer()
  }

  /** Always fires, including for remote-applied changes — the whole point being that a change
   *  arriving from another device via cloud sync needs to show up on screen without the user
   *  having to sign out and back in to force a re-fetch. */
  private notifyRenderer(): void {
    win?.webContents.send('agents:changed')
  }

  /**
   * Applies an agent as received from the cloud (last-write-wins by updatedAt) without
   * re-triggering the change listener — this is how a change made on one device shows up on
   * another without the two devices fighting over who's "right."
   */
  applyRemote(agent: AgentConfig): void {
    this.applyingRemote = true
    try {
      const idx = this.data.findIndex((a) => a.id === agent.id)
      if (idx < 0) {
        this.data.push(agent)
      } else if (agent.updatedAt >= this.data[idx].updatedAt) {
        this.data[idx] = agent
      } else {
        return // local copy is newer, keep it — it'll get pushed back up on its own
      }
      this.persist()
      this.notifyRenderer()
    } finally {
      this.applyingRemote = false
    }
  }

  /** Full replace — used once, right after sign-in, when the cloud already has this account's
   *  agents and should be treated as authoritative over whatever was seeded locally. */
  replaceAll(agents: AgentConfig[]): void {
    this.applyingRemote = true
    try {
      this.data = agents
      this.persist()
      this.notifyRenderer()
    } finally {
      this.applyingRemote = false
    }
  }

  private load(): AgentConfig[] {
    const path = agentsPath()
    if (!existsSync(path)) return []
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return []
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(agentsPath(), JSON.stringify(this.data, null, 2), 'utf-8')
  }

  list(): AgentConfig[] {
    return this.data
  }

  get(agentId: string): AgentConfig | undefined {
    return this.data.find((a) => a.id === agentId)
  }

  create(partial: Partial<AgentConfig> & { name: string }): AgentConfig {
    const now = Date.now()
    const agent: AgentConfig = {
      id: id(),
      name: partial.name,
      type: partial.type ?? 'bot',
      parentId: partial.parentId ?? null,
      color: partial.color ?? '#d4af37',
      systemPrompt: partial.systemPrompt ?? '',
      toolScope: partial.toolScope ?? [],
      memory: partial.memory ?? '',
      voice: partial.voice ?? 'Kore',
      status: 'idle',
      archived: false,
      createdAt: now,
      updatedAt: now
    }
    this.data.push(agent)
    this.persist()
    this.notifyChange()
    return agent
  }

  update(agentId: string, patch: Partial<AgentConfig>): AgentConfig | undefined {
    const idx = this.data.findIndex((a) => a.id === agentId)
    if (idx < 0) return undefined
    this.data[idx] = { ...this.data[idx], ...patch, id: agentId, updatedAt: Date.now() }
    this.persist()
    this.notifyChange()
    return this.data[idx]
  }

  setArchived(agentId: string, archived: boolean): AgentConfig | undefined {
    return this.update(agentId, { archived })
  }

  setStatus(agentId: string, status: AgentConfig['status']): AgentConfig | undefined {
    return this.update(agentId, { status })
  }

  /** Permanent delete (unlike archive/restore, this cannot be undone from the UI). Cascades to
   *  the cloud row so it doesn't come back on the next sign-in reconciliation. */
  remove(agentId: string): boolean {
    const before = this.data.length
    this.data = this.data.filter((a) => a.id !== agentId)
    if (this.data.length === before) return false
    this.persist()
    if (!this.applyingRemote) this.deleteListener?.(agentId)
    this.notifyRenderer()
    return true
  }

  /** Applies a deletion that originated on another device — removes locally without cascading
   *  a redundant delete back to the cloud. */
  applyRemoteDelete(agentId: string): void {
    this.applyingRemote = true
    try {
      this.data = this.data.filter((a) => a.id !== agentId)
      this.persist()
      this.notifyRenderer()
    } finally {
      this.applyingRemote = false
    }
  }

  /** See KNOWN_BAD_SEED_FINGERPRINTS above. Returns the ids removed, if any. */
  pruneKnownSeedArtifacts(): string[] {
    const toRemove = this.data.filter(
      (a) =>
        a.type === 'companion' &&
        a.parentId === null &&
        a.toolScope.length === 0 &&
        KNOWN_BAD_SEED_FINGERPRINTS.some((f) => f.name === a.name && f.color === a.color)
    )
    for (const a of toRemove) this.remove(a.id)
    return toRemove.map((a) => a.id)
  }
}

// Lazily constructed — see the matching comment in settingsStore.ts for why: the constructor
// calls app.getPath('userData'), which must not run before main/index.ts sets the app name.
let _instance: AgentStore | null = null
export const agentStore = new Proxy({} as AgentStore, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new AgentStore()
    return Reflect.get(_instance, prop, receiver)
  }
})
