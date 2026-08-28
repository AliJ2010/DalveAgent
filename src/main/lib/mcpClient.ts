import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import log from 'electron-log/main'
import { settingsStore } from './settingsStore'
import { DalveOAuthProvider, waitForAuthorizationCode } from './mcpOAuth'
import type { McpServerConfig } from '@shared/types'

/**
 * A real MCP client — connects to any server added in Settings (static-token or OAuth-protected),
 * fetches its tools, and exposes them to the live voice session as regular callable tools. This
 * is the piece that was actually missing: mcpServers in settingsStore was already real, saved
 * configuration, but nothing had ever connected to one — "add an MCP server" did nothing beyond
 * remembering the URL.
 */

interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface ConnectedServer {
  client: Client
  name: string
  tools: McpTool[]
}

const connections = new Map<string, ConnectedServer>()

export interface McpConnectResult {
  status: 'SUCCESS' | 'FAILED'
  message: string
}

/**
 * Connects to one configured MCP server. If it requires OAuth, this is where the real,
 * interactive part happens: the transport's own auth handling opens the user's browser to the
 * server's actual login/consent page (see mcpOAuth.ts's DalveOAuthProvider) and this function
 * waits for them to finish approving it there before completing the connection — an unavoidable
 * step only the user can take, not something skipped or automated here.
 */
export async function connectServer(config: McpServerConfig): Promise<McpConnectResult> {
  try {
    const client = new Client({ name: 'DALVE', version: '1.0.0' })
    const url = new URL(config.url)
    const headers: Record<string, string> =
      config.authHeader && config.authToken ? { [config.authHeader]: config.authToken } : {}

    // Started unconditionally — cheap, and StreamableHTTPClientTransport only actually uses the
    // provider (and thus this callback listener) if the server responds that it needs OAuth at
    // all; a static-token/no-auth server just connects normally and this sits idle until GC.
    const { port, code } = await waitForAuthorizationCode()
    const provider = new DalveOAuthProvider(config.id, port)
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      requestInit: Object.keys(headers).length ? { headers } : undefined
    })

    try {
      await client.connect(transport)
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err
      log.info(`[mcpClient] "${config.name}" needs OAuth — opened browser for the user to approve`)
      const authCode = await code
      await transport.finishAuth(authCode)
      await client.connect(transport)
    }

    const { tools } = await client.listTools()
    connections.set(config.id, { client, name: config.name, tools })
    settingsStore.updateMcpServerStatus(
      config.id,
      true,
      tools.map((t) => t.name)
    )
    log.info(`[mcpClient] connected to "${config.name}" (${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')})`)
    return { status: 'SUCCESS', message: `Connected to ${config.name} — ${tools.length} tool(s) available.` }
  } catch (err) {
    log.error(`[mcpClient] failed to connect "${config.name}":`, err)
    settingsStore.updateMcpServerStatus(config.id, false, [])
    return { status: 'FAILED', message: err instanceof Error ? err.message : String(err) }
  }
}

export function disconnectServer(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  void conn.client.close()
  connections.delete(id)
}

/** Every connected server's tools, in the same JSON-schema-based shape Gemini's
 *  FunctionDeclaration already uses — MCP's inputSchema is already directly compatible.
 *  Name-prefixed per server (mcp_<serverId>_<toolName>) since two different servers could
 *  otherwise expose identically-named tools (e.g. two servers both offering "search"). */
export function listToolDeclarations(): { name: string; description?: string; parametersJsonSchema: Record<string, unknown> }[] {
  const declarations: { name: string; description?: string; parametersJsonSchema: Record<string, unknown> }[] = []
  for (const [serverId, conn] of connections) {
    for (const tool of conn.tools) {
      declarations.push({
        name: `mcp_${serverId}_${tool.name}`,
        description: tool.description ? `[${conn.name}] ${tool.description}` : `Tool "${tool.name}" from ${conn.name}.`,
        parametersJsonSchema: tool.inputSchema
      })
    }
  }
  return declarations
}

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp_')
}

export async function callMcpTool(prefixedName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const withoutPrefix = prefixedName.slice('mcp_'.length)
  for (const [serverId, conn] of connections) {
    if (!withoutPrefix.startsWith(`${serverId}_`)) continue
    const toolName = withoutPrefix.slice(serverId.length + 1)
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args })
      return { result: JSON.stringify(result.content).slice(0, 4000) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { error: `No connected MCP tool matches "${prefixedName}".` }
}

/** Reconnects every previously-added server at app startup — "sign in once, stay connected",
 *  matching the expectation the rest of DALVE's integrations already set. A server that needs
 *  fresh OAuth approval (expired/revoked refresh token) will just fail quietly here and can be
 *  reconnected from Settings; this never pops a login browser window unprompted at launch for a
 *  server that's never been approved before. */
export async function reconnectAll(): Promise<void> {
  const servers = settingsStore.getMcpServerConfigs()
  for (const config of servers) {
    const hasPriorAuth = !!settingsStore.getMcpOAuthState(config.id) || !!config.authToken
    if (!hasPriorAuth) continue
    await connectServer(config).catch((err) => log.error(`[mcpClient] reconnect failed for "${config.name}":`, err))
  }
}
