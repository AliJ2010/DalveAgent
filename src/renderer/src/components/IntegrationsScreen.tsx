import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Plug, Search } from 'lucide-react'
import { useSettingsStore } from '../state/settingsStore'
import type { ComposioAuthScheme, ComposioCatalogEntry, ComposioConnection } from '@shared/types'

export function IntegrationsScreen(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const refresh = useSettingsStore((s) => s.refresh)
  const catalog = useSettingsStore((s) => s.catalog)
  const catalogLoading = useSettingsStore((s) => s.catalogLoading)
  const catalogError = useSettingsStore((s) => s.catalogError)
  const loadCatalog = useSettingsStore((s) => s.loadCatalog)
  const connectingApp = useSettingsStore((s) => s.connectingApp)
  const connectComposioApp = useSettingsStore((s) => s.connectComposioApp)
  const connectComposioApiKeyApp = useSettingsStore((s) => s.connectComposioApiKeyApp)
  const disconnectComposioApp = useSettingsStore((s) => s.disconnectComposioApp)

  const [query, setQuery] = useState('')

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (settings?.composioApiKeySet) loadCatalog()
  }, [settings?.composioApiKeySet, loadCatalog])

  const connectionByKey = new Map((settings?.composioConnections ?? []).map((c) => [c.appKey, c]))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? catalog.filter((c) => c.name.toLowerCase().includes(q)) : catalog
  }, [catalog, query])

  const filteredEntries = useMemo(
    () => filtered.map((c) => mergeEntry(c.slug, c.name, c, connectionByKey.get(c.slug))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, settings?.composioConnections]
  )
  const connectedEntries = filteredEntries.filter((e) => e.connected)
  const otherEntries = filteredEntries.filter((e) => !e.connected)

  async function handleOAuthConnect(entry: MergedEntry): Promise<string | undefined> {
    try {
      await connectComposioApp(entry.slug, entry.name, entry.logo)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : 'Connection failed.'
    }
  }

  async function handleApiKeyConnect(entry: MergedEntry, apiKeyValue: string): Promise<string | undefined> {
    try {
      await connectComposioApiKeyApp(entry.slug, apiKeyValue, entry.name, entry.logo)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : 'Connection failed.'
    }
  }

  async function handleEnableNoAuth(entry: MergedEntry): Promise<void> {
    await window.dalve.settings.updateComposioConnection(entry.slug, {
      connected: true
    })
    await refresh()
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 40px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--c-text-1)', marginBottom: 4 }}>
          Integrations
        </h1>
        <p style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 20 }}>
          Connect any app in Composio's catalog. DALVE can only act on apps you've connected here.
        </p>

        {!settings?.composioApiKeySet && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid var(--c-panel-border-strong)',
              background: 'rgba(212,175,55,0.06)',
              color: 'var(--c-text-2)',
              fontSize: 13,
              marginBottom: 20
            }}
          >
            Add your Composio API key in Settings to browse and connect apps.
          </div>
        )}

        {settings?.composioApiKeySet && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 14px',
              borderRadius: 999,
              border: '1px solid var(--c-panel-border)',
              background: 'var(--c-panel)',
              marginBottom: 24
            }}
          >
            <Search size={14} color="var(--c-text-3)" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={catalogLoading ? 'Loading catalog…' : `Search ${catalog.length || '1000+'} apps...`}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--c-text-1)',
                fontSize: 13
              }}
            />
          </div>
        )}

        {catalogError && (
          <div style={{ fontSize: 12, color: '#e0785a', marginBottom: 16 }}>{catalogError}</div>
        )}

        {connectedEntries.length > 0 && (
          <>
            <div className="tracked-label" style={{ marginBottom: 10, color: 'var(--c-gold-bright)' }}>
              Connected ({connectedEntries.length})
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 12,
                marginBottom: 28
              }}
            >
              {connectedEntries.map((entry) => (
                <AppCard
                  key={entry.slug}
                  entry={entry}
                  connecting={connectingApp === entry.slug}
                  disabled={!settings?.composioApiKeySet}
                  onConnect={() => handleOAuthConnect(entry)}
                  onConnectWithApiKey={(key) => handleApiKeyConnect(entry, key)}
                  onEnableNoAuth={() => handleEnableNoAuth(entry)}
                  onDisconnect={() => disconnectComposioApp(entry.slug)}
                />
              ))}
            </div>
          </>
        )}

        <div className="tracked-label" style={{ marginBottom: 10 }}>
          {query ? `Results for "${query}"` : `All apps (${catalog.length})`}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12
          }}
        >
          {otherEntries.map((entry) => (
            <AppCard
              key={entry.slug}
              entry={entry}
              connecting={connectingApp === entry.slug}
              disabled={!settings?.composioApiKeySet}
              onConnect={() => handleOAuthConnect(entry)}
              onConnectWithApiKey={(key) => handleApiKeyConnect(entry, key)}
              onEnableNoAuth={() => handleEnableNoAuth(entry)}
              onDisconnect={() => disconnectComposioApp(entry.slug)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface MergedEntry {
  slug: string
  name: string
  logo?: string
  authScheme: ComposioAuthScheme
  connected: boolean
}

function mergeEntry(
  slug: string,
  fallbackName: string,
  catalogEntry: ComposioCatalogEntry | undefined,
  connection: ComposioConnection | undefined
): MergedEntry {
  return {
    slug,
    name: catalogEntry?.name ?? connection?.appName ?? fallbackName,
    logo: catalogEntry?.logo ?? connection?.logo,
    authScheme: catalogEntry?.authScheme ?? 'OAUTH2',
    connected: connection?.connected ?? false
  }
}

function AppCard({
  entry,
  connecting,
  disabled,
  onConnect,
  onConnectWithApiKey,
  onEnableNoAuth,
  onDisconnect
}: {
  entry: MergedEntry
  connecting: boolean
  disabled: boolean
  onConnect: () => Promise<string | undefined>
  onConnectWithApiKey: (apiKeyValue: string) => Promise<string | undefined>
  onEnableNoAuth: () => Promise<void>
  onDisconnect: () => void
}): React.JSX.Element {
  const [showKeyForm, setShowKeyForm] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)

  async function submitOAuth(): Promise<void> {
    setError(null)
    const err = await onConnect()
    if (err) setError(err)
  }

  async function submitApiKey(): Promise<void> {
    if (!apiKeyInput.trim()) return
    setError(null)
    const err = await onConnectWithApiKey(apiKeyInput.trim())
    if (err) setError(err)
    else setApiKeyInput('')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--c-panel-border)',
        background: 'var(--c-panel)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(212,175,55,0.1)',
              color: 'var(--c-gold)',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            {entry.logo && !logoFailed ? (
              <img
                src={entry.logo}
                alt=""
                width={20}
                height={20}
                style={{ objectFit: 'contain' }}
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <Plug size={15} />
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                color: 'var(--c-text-1)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {entry.name}
            </div>
            <div style={{ fontSize: 11, color: entry.connected ? '#6fe08a' : 'var(--c-text-3)' }}>
              {connecting ? 'Connecting…' : entry.connected ? 'Connected' : 'Not connected'}
            </div>
          </div>
        </div>

        {entry.connected ? (
          <button
            onClick={onDisconnect}
            style={{
              color: 'var(--c-text-2)',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0
            }}
          >
            <CheckCircle2 size={13} color="#6fe08a" /> Disconnect
          </button>
        ) : entry.authScheme === 'API_KEY' ? (
          <button
            onClick={() => setShowKeyForm((v) => !v)}
            disabled={disabled || connecting}
            className="tracked-label"
            style={connectButtonStyle(disabled)}
          >
            Connect
          </button>
        ) : entry.authScheme === 'NO_AUTH' || entry.authScheme === 'OTHER' ? (
          <button
            onClick={() => void onEnableNoAuth()}
            disabled={disabled || connecting}
            className="tracked-label"
            style={connectButtonStyle(disabled)}
          >
            Enable
          </button>
        ) : (
          <button
            onClick={submitOAuth}
            disabled={disabled || connecting}
            className="tracked-label"
            style={connectButtonStyle(disabled)}
          >
            Connect
          </button>
        )}
      </div>

      {!entry.connected && entry.authScheme === 'API_KEY' && showKeyForm && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            placeholder="API key"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitApiKey()}
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--c-panel-border)',
              borderRadius: 8,
              padding: '8px 10px',
              color: 'var(--c-text-1)',
              fontSize: 12
            }}
          />
          <button
            onClick={submitApiKey}
            disabled={connecting}
            className="tracked-label"
            style={{
              fontSize: 10,
              padding: '0 14px',
              borderRadius: 8,
              border: '1px solid var(--c-panel-border-strong)',
              color: 'var(--c-gold-bright)'
            }}
          >
            Save
          </button>
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: '#e0785a' }}>{error}</div>}
    </div>
  )
}

function connectButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 10,
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid var(--c-panel-border-strong)',
    color: disabled ? 'var(--c-text-3)' : 'var(--c-gold-bright)',
    flexShrink: 0
  }
}
