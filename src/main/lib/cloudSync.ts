import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from '@shared/supabaseConfig'
import { agentStore } from './agentStore'
import { settingsStore } from './settingsStore'
import * as journal from './journal'
import type { AgentConfig } from '@shared/types'

let client: SupabaseClient | null = null
let channel: RealtimeChannel | null = null
let currentUserId: string | null = null

export function isConfigured(): boolean {
  return isSupabaseConfigured()
}

function authSessionPath(): string {
  return join(app.getPath('userData'), 'dalve-auth-session.json')
}

/** supabase-js persists the session via `localStorage` by default, which doesn't exist in an
 *  Electron main process (there's no `window`) — without this it silently falls back to an
 *  in-memory store, so the app forgot who was signed in on every single restart. This is the
 *  "remember me" fix: a plain file next to the other local stores, read/written synchronously
 *  since auth-js expects this API to behave synchronously-ish (it awaits, but never overlaps
 *  calls in practice here — one Electron process, one client). */
function readAuthFile(): Record<string, string> {
  try {
    const path = authSessionPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeAuthFile(data: Record<string, string>): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(authSessionPath(), JSON.stringify(data), 'utf-8')
}

const fileSessionStorage = {
  getItem: (key: string): string | null => readAuthFile()[key] ?? null,
  setItem: (key: string, value: string): void => {
    const data = readAuthFile()
    data[key] = value
    writeAuthFile(data)
  },
  removeItem: (key: string): void => {
    const data = readAuthFile()
    delete data[key]
    writeAuthFile(data)
  }
}

function getClient(): SupabaseClient {
  if (!client) {
    if (!isSupabaseConfigured()) {
      throw new Error('Cloud sync is not configured yet — add the Supabase project URL and anon key.')
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: fileSessionStorage
      }
    })
  }
  return client
}

export function isSignedIn(): boolean {
  return currentUserId !== null
}

/** Called at app startup — resumes an existing session (Supabase persists it locally between
 *  launches) and re-establishes sync, so the user doesn't have to sign in every single time. */
export async function getCurrentSession(): Promise<{ signedIn: boolean; email?: string }> {
  if (!isSupabaseConfigured()) return { signedIn: false }
  const { data } = await getClient().auth.getSession()
  if (data.session) {
    currentUserId = data.session.user.id
    await onSignedIn()
    return { signedIn: true, email: data.session.user.email }
  }
  return { signedIn: false }
}

export async function signUp(email: string, password: string): Promise<{ error?: string }> {
  const { data, error } = await getClient().auth.signUp({ email, password })
  if (error) return { error: error.message }
  if (data.session) {
    currentUserId = data.session.user.id
    await onSignedIn()
  }
  return {}
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password })
  if (error) return { error: error.message }
  currentUserId = data.session.user.id
  await onSignedIn()
  return {}
}

export async function signOut(): Promise<void> {
  if (client) await client.auth.signOut()
  currentUserId = null
  agentStore.setChangeListener(null)
  agentStore.setDeleteListener(null)
  settingsStore.setChangeListener(null)
  if (channel) {
    await getClient().removeChannel(channel)
    channel = null
  }
}

// --- Agents ---

function agentToRow(a: AgentConfig, userId: string) {
  return {
    id: a.id,
    user_id: userId,
    name: a.name,
    type: a.type,
    parent_id: a.parentId,
    color: a.color,
    system_prompt: a.systemPrompt,
    tool_scope: a.toolScope,
    memory: a.memory,
    voice: a.voice,
    status: a.status,
    archived: a.archived,
    created_at: a.createdAt,
    updated_at: a.updatedAt
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAgent(r: any): AgentConfig {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    color: r.color,
    systemPrompt: r.system_prompt,
    toolScope: r.tool_scope ?? [],
    memory: r.memory ?? '',
    voice: r.voice,
    status: r.status,
    archived: r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

async function pushAllAgents(): Promise<void> {
  if (!currentUserId) return
  const rows = agentStore.list().map((a) => agentToRow(a, currentUserId as string))
  if (rows.length === 0) return
  const { error } = await getClient().from('agents').upsert(rows)
  if (error) console.error('[cloudSync] failed to push agents:', error)
}

async function deleteAgentCloud(id: string): Promise<void> {
  if (!currentUserId) return
  const { error } = await getClient().from('agents').delete().eq('id', id)
  if (error) console.error('[cloudSync] failed to delete agent:', error)
}

async function pushSettings(): Promise<void> {
  if (!currentUserId) return
  const s = settingsStore.getState()
  const { error } = await getClient()
    .from('settings')
    .upsert({
      user_id: currentUserId,
      composio_connections: s.composioConnections,
      mcp_servers: s.mcpServers,
      dalve_voice: s.dalveVoice,
      dalve_memory: s.dalveMemory,
      // Plaintext in the cloud row (RLS-protected, same as every other row) so a key entered on
      // one device shows up "set" on every other device signed into this account.
      gemini_api_key: settingsStore.getGeminiApiKey() ?? null,
      composio_api_key: settingsStore.getComposioApiKey() ?? null,
      updated_at: Date.now()
    })
  if (error) console.error('[cloudSync] failed to push settings:', error)
}

/**
 * Runs once right after sign-in: reconciles local vs. cloud state. If the cloud account already
 * has agents (this is a second device, or returning to an existing account), the cloud wins and
 * local gets replaced — per the "cloud is the authoritative state" requirement. If the cloud is
 * empty (brand new account), whatever's local right now gets pushed up as the starting point.
 */
async function onSignedIn(): Promise<void> {
  if (!currentUserId) return
  const supa = getClient()

  // First-sync reconciliation is a UNION, never an overwrite: if this account was already used
  // on another device with its own agents (e.g. signing in on the Mac after the Windows PC
  // already pushed Atlas/Scout up), neither side's agents disappear — anything only-local gets
  // pushed up, anything only-cloud gets pulled down. Real per-agent edits after this point use
  // last-write-wins (see agentStore.applyRemote), which is fine once both sides agree on what
  // exists; it's only this very first reconciliation where blindly picking one side would
  // silently destroy the other device's work.
  const { data: cloudAgentRows, error: agentsErr } = await supa.from('agents').select('*')
  if (agentsErr) {
    console.error('[cloudSync] failed to fetch cloud agents:', agentsErr)
  } else {
    const cloudAgents = (cloudAgentRows ?? []).map(rowToAgent)
    const cloudIds = new Set(cloudAgents.map((a) => a.id))
    const localAgents = agentStore.list()
    const localIds = new Set(localAgents.map((a) => a.id))

    const localOnly = localAgents.filter((a) => !cloudIds.has(a.id))
    const cloudOnly = cloudAgents.filter((a) => !localIds.has(a.id))

    for (const agent of cloudOnly) agentStore.applyRemote(agent)
    if (localOnly.length > 0) {
      const { error } = await supa.from('agents').upsert(localOnly.map((a) => agentToRow(a, currentUserId as string)))
      if (error) console.error('[cloudSync] failed to push local-only agents during first sync:', error)
    }
  }

  const { data: cloudSettings, error: settingsErr } = await supa
    .from('settings')
    .select('*')
    .eq('user_id', currentUserId)
    .maybeSingle()
  if (settingsErr) {
    console.error('[cloudSync] failed to fetch cloud settings:', settingsErr)
  } else if (cloudSettings) {
    // Same reasoning as agents: memory is a append-only-ish list of remembered facts, so merge
    // distinct lines from both sides rather than letting whichever device happens to sign in
    // second silently erase the other's remembered facts.
    const localMemory = settingsStore.getDalveMemory()
    const cloudMemory = (cloudSettings.dalve_memory as string) ?? ''
    const mergedMemoryLines = Array.from(
      new Set(
        [...localMemory.split('\n'), ...cloudMemory.split('\n')].map((l) => l.trim()).filter(Boolean)
      )
    )

    // Composio connection status should be identical either way (same underlying Composio
    // account) — union by appKey just in case one device connected something the other hasn't
    // seen yet, preferring whichever copy says connected.
    const localConnections = settingsStore.getState().composioConnections
    const cloudConnections = (cloudSettings.composio_connections ?? []) as typeof localConnections
    const byAppKey = new Map(localConnections.map((c) => [c.appKey, c]))
    for (const c of cloudConnections) {
      const existing = byAppKey.get(c.appKey)
      if (!existing || (c.connected && !existing.connected)) byAppKey.set(c.appKey, c)
    }

    // Same idea for API keys: whichever side actually has a value wins, preferring the cloud's
    // (in case a third device already updated it) but falling back to local so a key already
    // sitting on this machine never gets wiped out by an empty/legacy cloud row.
    settingsStore.applyRemote({
      composioConnections: Array.from(byAppKey.values()),
      mcpServers: cloudSettings.mcp_servers ?? [],
      dalveVoice: cloudSettings.dalve_voice,
      dalveMemory: mergedMemoryLines.join('\n'),
      geminiApiKey: (cloudSettings.gemini_api_key as string) || settingsStore.getGeminiApiKey(),
      composioApiKey: (cloudSettings.composio_api_key as string) || settingsStore.getComposioApiKey()
    })
    // The merge just produced a state neither side had exactly — write it back up so the cloud
    // (and thus every other device) sees the merged result too, not just this one.
    await pushSettings()
  } else {
    await pushSettings()
  }

  agentStore.setChangeListener(() => void pushAllAgents())
  agentStore.setDeleteListener((id) => void deleteAgentCloud(id))
  settingsStore.setChangeListener(() => void pushSettings())

  // Bug cleanup (see KNOWN_BAD_SEED_FINGERPRINTS in agentStore.ts): the union-merge above may
  // have just pulled down stale seed-artifact agents from another device, or this device may
  // already have its own local ones. Listeners are wired above, so any removal here correctly
  // cascades a delete to the cloud row too instead of it reappearing on the next sign-in.
  const pruned = agentStore.pruneKnownSeedArtifacts()
  if (pruned.length > 0) {
    console.log(`[cloudSync] removed ${pruned.length} stale seed-artifact agent(s) from this account`)
  }

  channel = supa
    .channel('dalve-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'agents', filter: `user_id=eq.${currentUserId}` },
      (payload) => {
        if (payload.eventType === 'DELETE') {
          const oldId = (payload.old as { id?: string } | null)?.id
          if (oldId) agentStore.applyRemoteDelete(oldId)
          return
        }
        agentStore.applyRemote(rowToAgent(payload.new))
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'settings', filter: `user_id=eq.${currentUserId}` },
      (payload) => {
        if (payload.eventType === 'DELETE') return
        const row = payload.new as Record<string, unknown>
        settingsStore.applyRemote({
          composioConnections: (row.composio_connections as never) ?? [],
          mcpServers: (row.mcp_servers as never) ?? [],
          dalveVoice: row.dalve_voice as string,
          dalveMemory: (row.dalve_memory as string) ?? '',
          geminiApiKey: (row.gemini_api_key as string) || undefined,
          composioApiKey: (row.composio_api_key as string) || undefined
        })
      }
    )
    .subscribe()
}

/** Journal sync runs on a simpler pull/push basis (not realtime) since it's append-mostly and
 *  read at session-start, not something that needs to feel instantaneous across devices. */
export async function syncJournalNow(): Promise<void> {
  if (!currentUserId) return
  const supa = getClient()
  const localDays = journal.getAllDays()

  const { data: cloudDays, error } = await supa.from('journal_entries').select('*').eq('user_id', currentUserId)
  if (error) {
    console.error('[cloudSync] failed to fetch cloud journal:', error)
    return
  }

  const cloudByDate = new Map((cloudDays ?? []).map((d) => [d.date, d]))
  const merged = journal.mergeDays(
    localDays,
    (cloudDays ?? []).map((d) => ({ date: d.date, lines: d.lines ?? [] }))
  )
  journal.replaceAllDays(merged)

  const rows = merged
    .filter((d) => {
      const cloud = cloudByDate.get(d.date)
      return !cloud || JSON.stringify(cloud.lines) !== JSON.stringify(d.lines)
    })
    .map((d) => ({ user_id: currentUserId, date: d.date, lines: d.lines, updated_at: Date.now() }))
  if (rows.length > 0) {
    const { error: upsertErr } = await supa.from('journal_entries').upsert(rows)
    if (upsertErr) console.error('[cloudSync] failed to push journal:', upsertErr)
  }
}
