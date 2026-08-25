import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { AgentConfig } from '@shared/types'

function agentsPath(): string {
  return join(app.getPath('userData'), 'dalve-agents.json')
}

function id(): string {
  return `agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

function defaultCompanions(): AgentConfig[] {
  const now = Date.now()
  const base = (
    name: string,
    color: string,
    systemPrompt: string,
    voice: string
  ): AgentConfig => ({
    id: id(),
    name,
    type: 'companion',
    parentId: null,
    color,
    systemPrompt,
    toolScope: [],
    memory: '',
    voice,
    status: 'idle',
    archived: false,
    createdAt: now,
    updatedAt: now
  })

  return [
    base(
      'Email',
      '#d4af37',
      'You are Email, DALVE’s companion for inbox triage and correspondence. You read, summarize, draft, and send email on the user’s behalf via Gmail. You are precise about who a message is from, what it asks for, and what reply (if any) is warranted. You never send anything without being clearly asked to.',
      'Kore'
    ),
    base(
      'Finance',
      '#c9a227',
      'You are Finance, DALVE’s companion for money matters. You check balances, payments, invoices, and transaction activity via Stripe and related tools. You report numbers exactly as retrieved, flag anything unusual, and never take an action that moves money without explicit confirmation.',
      'Charon'
    ),
    base(
      'Messaging',
      '#e0b84a',
      'You are Messaging, DALVE’s companion for chat and messaging apps like WhatsApp. You read recent conversations, summarize them, and send messages on the user’s behalf when clearly instructed. You preserve the user’s tone and never send anything without being clearly asked to.',
      'Puck'
    ),
    base(
      'Builder',
      '#f2d06b',
      'You are Builder, a product and engineering strategist obsessed with shipping. You think in systems — architecture, roadmaps, technical debt, go-to-market strategy. You own the vision of what gets built and why. You work backward from outcomes: what does the user need to win? What’s blocking it? You communicate with clarity and conviction.',
      'Fenrir'
    )
  ]
}

class AgentStore {
  private data: AgentConfig[]
  private changeListener: (() => void) | null = null
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

  private notifyChange(): void {
    if (!this.applyingRemote) this.changeListener?.()
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
    } finally {
      this.applyingRemote = false
    }
  }

  private load(): AgentConfig[] {
    const path = agentsPath()
    if (!existsSync(path)) {
      const seeded = defaultCompanions()
      this.data = seeded
      this.persist()
      return seeded
    }
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return defaultCompanions()
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
