import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Composio, AuthScheme, AuthConfigTypes } from '@composio/core'
import { settingsStore } from './settingsStore'
import type { ComposioAuthScheme, ComposioCatalogEntry } from '@shared/types'

// Single local identity — DALVE runs as one user's desktop assistant, not a multi-tenant service.
const COMPOSIO_USER_ID = 'dalve-local-user'

// Composio's full catalog is 1300+ apps with logos/descriptions — genuinely slow to fetch (real
// network + payload size, not a bug), so it's worth persisting to disk rather than re-fetching
// on every app launch. Refreshed automatically once a day, or immediately after the API key changes.
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function catalogCachePath(): string {
  return join(app.getPath('userData'), 'dalve-catalog-cache.json')
}

function loadCatalogFromDisk(): ComposioCatalogEntry[] | null {
  try {
    const path = catalogCachePath()
    if (!existsSync(path)) return null
    const { fetchedAt, entries } = JSON.parse(readFileSync(path, 'utf-8'))
    if (Date.now() - fetchedAt > CATALOG_CACHE_TTL_MS) return null
    return entries
  } catch {
    return null
  }
}

function saveCatalogToDisk(entries: ComposioCatalogEntry[]): void {
  try {
    writeFileSync(catalogCachePath(), JSON.stringify({ fetchedAt: Date.now(), entries }), 'utf-8')
  } catch (err) {
    console.error('[composio] failed to persist catalog cache:', err)
  }
}

export interface ComposioFunctionDeclaration {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
}

let client: Composio | null = null
let catalogCache: ComposioCatalogEntry[] | null = null

function getClient(): Composio {
  const apiKey = settingsStore.getComposioApiKey()
  if (!apiKey) {
    throw new Error('Add your Composio API key in Settings first.')
  }
  if (!client) {
    client = new Composio({ apiKey })
  }
  return client
}

/** Resets the cached client and catalog — call after the Composio API key changes. */
export function resetComposioClient(): void {
  client = null
  catalogCache = null
  try {
    if (existsSync(catalogCachePath())) writeFileSync(catalogCachePath(), '')
  } catch {
    // best-effort; a stale cache file just means one extra slow fetch, not a correctness issue
  }
}

/** Throws with a clear message if the given key is rejected by Composio. */
export async function validateApiKey(apiKey: string): Promise<void> {
  const test = new Composio({ apiKey })
  try {
    await test.toolkits.get({ limit: 1 })
  } catch (err) {
    console.error('[composio] API key validation failed:', err)
    throw new Error(
      "That Composio API key was rejected. Double-check you copied it correctly from app.composio.dev's API Keys page."
    )
  }
}

function pickAuthScheme(schemes: string[] | undefined, noAuth: boolean | undefined): ComposioAuthScheme {
  if (noAuth) return 'NO_AUTH'
  if (schemes && schemes.length > 0) {
    if (schemes.includes('OAUTH2') || schemes.includes('OAUTH1')) return 'OAUTH2'
    if (schemes.includes('API_KEY')) return 'API_KEY'
  }
  // The list/summary endpoint often omits per-toolkit auth scheme detail (only the single-toolkit
  // detail call reliably includes it). Defaulting unknown toolkits to OAUTH2 — the dominant scheme
  // across the catalog — means "Connect" attempts a real flow instead of silently faking success;
  // an app that actually needs an API key will surface a clear error from Composio when clicked.
  return 'OAUTH2'
}

interface RawToolkitItem {
  slug: string
  name: string
  meta?: { logo?: string; description?: string; categories?: { name: string }[] }
  auth_schemes?: string[]
  composio_managed_auth_schemes?: string[]
  no_auth?: boolean
}

interface RawToolkitListResponse {
  items: RawToolkitItem[]
  next_cursor?: string | null
}

interface RawComposioClient {
  toolkits: {
    list: (params: {
      limit?: number
      cursor?: string
      sort_by?: string
    }) => Promise<RawToolkitListResponse>
  }
}

/**
 * `@composio/core`'s convenience `Toolkits.get()` returns a flat, auto-transformed array with
 * no exposed pagination cursor — fine up to its own page-size ceiling (1000), but Composio's
 * live catalog is larger than that (1381 toolkits as of writing). Composio's `Composio` class
 * holds the lower-level `@composio/client` instance in a `protected client` field; TypeScript's
 * `protected` is a compile-time-only restriction; grabbing it here for real pagination via the
 * documented raw `items`/`next_cursor` contract is deliberate, not a language-guaranteed API.
 */
function getRawClient(): RawComposioClient {
  return (getClient() as unknown as { client: RawComposioClient }).client
}

/**
 * Fetches the full Composio toolkit catalog, each with a logo/auth scheme. Cached in memory for
 * the process lifetime, and on disk for up to a day, since the real fetch (1300+ apps with full
 * metadata) is genuinely slow over the network — this makes only the very first load slow.
 */
export async function listToolkitCatalog(): Promise<ComposioCatalogEntry[]> {
  if (catalogCache) return catalogCache

  const fromDisk = loadCatalogFromDisk()
  if (fromDisk) {
    catalogCache = fromDisk
    return fromDisk
  }

  const raw = getRawClient()
  const entries: ComposioCatalogEntry[] = []
  let cursor: string | undefined

  for (let page = 0; page < 10; page++) {
    const response = await raw.toolkits.list({ limit: 1000, cursor, sort_by: 'alphabetically' })
    for (const t of response.items) {
      entries.push({
        slug: t.slug,
        name: t.name,
        logo: t.meta?.logo,
        description: t.meta?.description,
        category: t.meta?.categories?.[0]?.name,
        authScheme: pickAuthScheme(t.composio_managed_auth_schemes ?? t.auth_schemes, t.no_auth)
      })
    }
    if (!response.next_cursor) break
    cursor = response.next_cursor
  }

  catalogCache = entries
  saveCatalogToDisk(entries)
  return entries
}

async function ensureAuthConfigId(toolkitSlug: string, forceFresh = false): Promise<string> {
  if (!forceFresh) {
    const cached = settingsStore.getComposioAuthConfigId(toolkitSlug)
    if (cached) return cached
  }

  const composio = getClient()
  const created = await composio.authConfigs.create(toolkitSlug, {
    name: `DALVE ${toolkitSlug}`,
    type: AuthConfigTypes.COMPOSIO_MANAGED
  })
  settingsStore.setComposioAuthConfigId(toolkitSlug, created.id)
  return created.id
}

function looksLikeStaleAuthConfig(err: unknown): boolean {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
  const text = `${err instanceof Error ? err.message : String(err)} ${cause instanceof Error ? cause.message : ''}`
  return /auth.?config/i.test(text) && /not.?found/i.test(text)
}

/** A real, confirmed case (Stripe MCP): some toolkits — usually MCP-wrapped variants of a normal
 *  app — have no Composio-managed OAuth app at all and need the CALLER's own client id/secret,
 *  which DALVE has no UI for yet. Surfaces as a raw "Default auth config not found... does not
 *  have managed credentials for this toolkit" 404 otherwise — this turns that into something
 *  actually actionable instead of a JSON dump. */
function looksLikeNoManagedCredentials(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return /does not have managed credentials/i.test(text) || /use_custom_auth/i.test(text)
}

/**
 * Runs a connect action against the cached auth config, and transparently retries once with a
 * freshly created one if the cached id has gone stale — e.g. deleted via Composio's own
 * dashboard, which happened here: disconnecting in-app only clears our local flag, so a user
 * who also deletes things on Composio's side is left with a locally-cached id pointing at
 * nothing. Without this, every future connect attempt for that toolkit fails forever with a
 * confusing "Auth config not found" error until someone notices and clears local state by hand.
 */
async function withAuthConfig<T>(
  toolkitSlug: string,
  fn: (authConfigId: string) => Promise<T>
): Promise<T> {
  try {
    const authConfigId = await ensureAuthConfigId(toolkitSlug)
    return await fn(authConfigId)
  } catch (err) {
    if (looksLikeNoManagedCredentials(err)) {
      throw new Error(
        `"${toolkitSlug}" doesn't have Composio-managed credentials available — it needs its own OAuth app (client ID/secret), which DALVE doesn't have a way to enter yet. If a plain version of this app exists without "MCP" in the name, try connecting that instead.`
      )
    }
    if (!looksLikeStaleAuthConfig(err)) throw err
    console.error(`[composio] cached auth config for ${toolkitSlug} is stale, recreating:`, err)
    const freshId = await ensureAuthConfigId(toolkitSlug, true)
    return fn(freshId)
  }
}

/** Starts an OAuth connection for a toolkit and returns the URL to open. */
export async function beginOAuthConnect(
  toolkitSlug: string
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const composio = getClient()
  return withAuthConfig(toolkitSlug, async (authConfigId) => {
    const connectionRequest = await composio.connectedAccounts.link(COMPOSIO_USER_ID, authConfigId)
    if (!connectionRequest.redirectUrl) {
      throw new Error('Composio did not return a connection URL.')
    }
    return { redirectUrl: connectionRequest.redirectUrl, connectedAccountId: connectionRequest.id }
  })
}

/** Connects an API-key-based app like Stripe directly, no browser popup needed. */
export async function connectWithApiKey(toolkitSlug: string, apiKeyValue: string): Promise<string> {
  const composio = getClient()
  return withAuthConfig(toolkitSlug, async (authConfigId) => {
    const connectionRequest = await composio.connectedAccounts.initiate(COMPOSIO_USER_ID, authConfigId, {
      config: AuthScheme.APIKey({ api_key: apiKeyValue })
    })
    await composio.connectedAccounts.waitForConnection(connectionRequest.id, 15000)
    return connectionRequest.id
  })
}

export async function waitForConnection(connectedAccountId: string, timeoutMs = 120000): Promise<boolean> {
  try {
    await getClient().connectedAccounts.waitForConnection(connectedAccountId, timeoutMs)
    return true
  } catch {
    return false
  }
}

/** Fetches Gemini-compatible function declarations for the given connected apps. */
export async function getToolsForApps(toolkitSlugs: string[]): Promise<ComposioFunctionDeclaration[]> {
  if (toolkitSlugs.length === 0) return []

  const composio = getClient()
  const rawTools = await composio.tools.getRawComposioTools({ toolkits: toolkitSlugs })

  return rawTools.map((tool) => ({
    name: tool.slug,
    description: tool.description ?? tool.name,
    parametersJsonSchema: tool.inputParameters ?? { type: 'object', properties: {} }
  }))
}

export async function executeComposioTool(slug: string, args: Record<string, unknown>): Promise<unknown> {
  const composio = getClient()
  const result = await composio.tools.execute(slug, {
    userId: COMPOSIO_USER_ID,
    arguments: args,
    dangerouslySkipVersionCheck: true
  })
  return result
}
