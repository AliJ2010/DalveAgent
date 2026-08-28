import { shell } from 'electron'
import { createServer, type Server } from 'http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { settingsStore } from './settingsStore'

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationFull
  tokens?: OAuthTokens
  codeVerifier?: string
}

/**
 * A real OAuthClientProvider per MCP server — persists dynamically-registered client info and
 * tokens (encrypted, main-process-only) so the user only has to approve access once per server,
 * not on every connection. Deliberately does NOT complete the actual consent step itself:
 * redirectToAuthorization only opens the user's own real browser to the server's genuine login/
 * consent page — approving access there is the user's own unavoidable step (granting OAuth/SSO
 * permission is explicitly something DALVE must never do on someone's behalf), never something
 * this code attempts to click through or route around.
 */
export class DalveOAuthProvider implements OAuthClientProvider {
  // Named `stored`, not `state` — OAuthClientProvider already declares an optional `state()`
  // *method* (the OAuth CSRF state parameter), which a same-named field collides with.
  private stored: StoredOAuthState

  constructor(
    private serverId: string,
    private port: number
  ) {
    this.stored = (settingsStore.getMcpOAuthState(serverId) as StoredOAuthState | undefined) ?? {}
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DALVE',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.stored.clientInformation
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.stored.clientInformation = info
    this.persist()
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.stored.tokens = tokens
    this.persist()
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    void shell.openExternal(authorizationUrl.toString())
  }

  saveCodeVerifier(verifier: string): void {
    this.stored.codeVerifier = verifier
    this.persist()
  }

  codeVerifier(): string {
    return this.stored.codeVerifier ?? ''
  }

  private persist(): void {
    settingsStore.setMcpOAuthState(this.serverId, this.stored as unknown as Record<string, unknown>)
  }
}

/**
 * Starts a one-shot local server on an OS-assigned free port to catch the OAuth redirect after
 * the user approves access in their browser — the standard "loopback redirect" pattern for
 * native/desktop OAuth clients (RFC 8252), since a desktop app has no fixed web address of its
 * own for the authorization server to redirect back to.
 */
export function waitForAuthorizationCode(): Promise<{ port: number; code: Promise<string> }> {
  let resolveCode: (code: string) => void = () => undefined
  let rejectCode: (err: Error) => void = () => undefined
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  let server: Server
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const authCode = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      error
        ? `<h1>Authorization failed</h1><p>${error}</p><p>You can close this window and try again in DALVE.</p>`
        : `<h1>DALVE is connected</h1><p>You can close this window and go back to DALVE.</p>`
    )
    server.close()
    if (authCode) resolveCode(authCode)
    else rejectCode(new Error(error ?? 'No authorization code received.'))
  })

  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      setTimeout(
        () => {
          server.close()
          rejectCode(new Error('Timed out waiting for authorization (5 minutes) — try connecting again.'))
        },
        5 * 60 * 1000
      )
      resolvePort({ port, code })
    })
  })
}
