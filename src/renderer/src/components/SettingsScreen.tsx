import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useSettingsStore } from '../state/settingsStore'
import { useUiStore } from '../state/uiStore'
import { useAuthStore } from '../state/authStore'
import { GEMINI_VOICES } from '@shared/types'

export function SettingsScreen(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const refresh = useSettingsStore((s) => s.refresh)
  const setGeminiKey = useSettingsStore((s) => s.setGeminiKey)
  const setAnthropicKey = useSettingsStore((s) => s.setAnthropicKey)
  const setTelegramBotToken = useSettingsStore((s) => s.setTelegramBotToken)
  const setGroqKey = useSettingsStore((s) => s.setGroqKey)
  const setElevenLabsKey = useSettingsStore((s) => s.setElevenLabsKey)
  const setElevenLabsVoice = useSettingsStore((s) => s.setElevenLabsVoice)
  const setVoiceEngine = useSettingsStore((s) => s.setVoiceEngine)
  const elevenLabsVoices = useSettingsStore((s) => s.elevenLabsVoices)
  const loadElevenLabsVoices = useSettingsStore((s) => s.loadElevenLabsVoices)
  const setComposioKey = useSettingsStore((s) => s.setComposioKey)
  const setDalveVoice = useSettingsStore((s) => s.setDalveVoice)
  const addMcpServer = useSettingsStore((s) => s.addMcpServer)
  const removeMcpServer = useSettingsStore((s) => s.removeMcpServer)
  const setScreen = useUiStore((s) => s.setScreen)
  const authEmail = useAuthStore((s) => s.email)
  const authStatus = useAuthStore((s) => s.status)
  const signOut = useAuthStore((s) => s.signOut)

  const [geminiInput, setGeminiInput] = useState('')
  const [anthropicInput, setAnthropicInput] = useState('')
  const [telegramInput, setTelegramInput] = useState('')
  const [groqInput, setGroqInput] = useState('')
  const [elevenLabsInput, setElevenLabsInput] = useState('')
  const [composioInput, setComposioInput] = useState('')
  const [composioError, setComposioError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const [mcpName, setMcpName] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpAuthHeader, setMcpAuthHeader] = useState('')
  const [mcpAuthToken, setMcpAuthToken] = useState('')
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    refresh()
    void window.dalve.app.getVersion().then(setAppVersion)
  }, [refresh])

  useEffect(() => {
    if (settings?.elevenLabsApiKeySet) void loadElevenLabsVoices()
  }, [settings?.elevenLabsApiKeySet, loadElevenLabsVoices])

  function flash(msg: string): void {
    setSavedNotice(msg)
    setTimeout(() => setSavedNotice(null), 2000)
  }

  async function saveGemini(): Promise<void> {
    if (!geminiInput.trim()) return
    await setGeminiKey(geminiInput.trim())
    setGeminiInput('')
    flash('Gemini API key saved')
  }

  async function saveAnthropic(): Promise<void> {
    if (!anthropicInput.trim()) return
    await setAnthropicKey(anthropicInput.trim())
    setAnthropicInput('')
    flash('Claude API key saved')
  }

  async function saveTelegram(): Promise<void> {
    if (!telegramInput.trim()) return
    await setTelegramBotToken(telegramInput.trim())
    setTelegramInput('')
    flash('Telegram bot token saved — message the bot once to link this device.')
  }

  async function saveGroq(): Promise<void> {
    if (!groqInput.trim()) return
    await setGroqKey(groqInput.trim())
    setGroqInput('')
    flash('Groq API key saved')
  }

  async function saveElevenLabs(): Promise<void> {
    if (!elevenLabsInput.trim()) return
    await setElevenLabsKey(elevenLabsInput.trim())
    setElevenLabsInput('')
    flash('ElevenLabs API key saved')
    void loadElevenLabsVoices()
  }

  async function saveComposio(): Promise<void> {
    if (!composioInput.trim()) return
    setComposioError(null)
    try {
      await setComposioKey(composioInput.trim())
      setComposioInput('')
      flash('Composio API key saved')
    } catch (err) {
      setComposioError(err instanceof Error ? err.message : 'That key was rejected.')
    }
  }

  async function submitMcp(): Promise<void> {
    if (!mcpName.trim() || !mcpUrl.trim()) return
    await addMcpServer({
      name: mcpName.trim(),
      url: mcpUrl.trim(),
      authHeader: mcpAuthHeader.trim() || undefined,
      authToken: mcpAuthToken.trim() || undefined
    })
    setMcpName('')
    setMcpUrl('')
    setMcpAuthHeader('')
    setMcpAuthToken('')
    flash('MCP server added')
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 40px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--c-text-1)', marginBottom: 4 }}>
            Settings
          </h1>
          <p style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
            Keys are encrypted at rest and synced to your account so every signed-in device has them.
          </p>
        </div>

        {savedNotice && (
          <div style={{ fontSize: 12, color: '#6fe08a', marginTop: -20 }}>{savedNotice}</div>
        )}

        {authStatus === 'signedIn' && (
          <Section title="Account">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--c-text-1)' }}>{authEmail}</div>
                <div style={{ fontSize: 11, color: '#6fe08a', marginTop: 2 }}>Synced across devices</div>
              </div>
              <button
                onClick={() => void signOut()}
                className="tracked-label"
                style={{
                  fontSize: 10,
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: '1px solid var(--c-panel-border-strong)',
                  color: 'var(--c-text-2)'
                }}
              >
                Sign Out
              </button>
            </div>
          </Section>
        )}

        <Section title="Gemini API key">
          <KeyRow
            placeholder={settings?.geminiApiKeySet ? 'Key saved — enter a new key to replace it' : 'Paste your Gemini API key'}
            value={geminiInput}
            onChange={setGeminiInput}
            onSubmit={saveGemini}
            saved={settings?.geminiApiKeySet}
          />
        </Section>

        <Section title="Claude (Anthropic) API key">
          <KeyRow
            placeholder={
              settings?.anthropicApiKeySet
                ? 'Key saved — enter a new key to replace it'
                : 'Paste your Anthropic API key'
            }
            value={anthropicInput}
            onChange={setAnthropicInput}
            onSubmit={saveAnthropic}
            saved={settings?.anthropicApiKeySet}
          />
          <p style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 6 }}>
            Used as the reasoning engine for autonomous background tasks (screen/browser control).
          </p>
        </Section>

        <Section title="Telegram remote control">
          <KeyRow
            placeholder={
              settings?.telegramBotTokenSet
                ? 'Token saved — enter a new one to replace it'
                : 'Paste your Telegram bot token (from @BotFather)'
            }
            value={telegramInput}
            onChange={setTelegramInput}
            onSubmit={saveTelegram}
            saved={settings?.telegramBotTokenSet}
          />
          <p style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 6 }}>
            {settings?.telegramBotTokenSet
              ? settings.telegramChatBound
                ? 'Linked — message your bot on Telegram any time to run a command on this PC.'
                : "Saved. Message your bot once on Telegram to link this device — the first chat to message it becomes the only one DALVE will listen to."
              : 'Message @BotFather on Telegram, create a bot, and paste the token it gives you here.'}
          </p>
        </Section>

        <Section title="Voice engine">
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {(['gemini', 'groq'] as const).map((engine) => (
              <button
                key={engine}
                onClick={() => void setVoiceEngine(engine)}
                className="tracked-label"
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 8,
                  fontSize: 11,
                  border: `1px solid ${settings?.voiceEngine === engine ? 'var(--c-gold)' : 'var(--c-panel-border)'}`,
                  background: settings?.voiceEngine === engine ? 'rgba(212,175,55,0.14)' : 'var(--c-panel)',
                  color: settings?.voiceEngine === engine ? 'var(--c-gold-bright)' : 'var(--c-text-2)'
                }}
              >
                {engine === 'gemini' ? 'Gemini Live' : 'Groq + ElevenLabs'}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--c-text-3)', marginBottom: 4 }}>
            Groq + ElevenLabs is a cheaper, turn-based alternative — DALVE listens, waits for you
            to stop talking, then replies. You can still interrupt her mid-reply.
          </p>
        </Section>

        <Section title="Groq API key">
          <KeyRow
            placeholder={settings?.groqApiKeySet ? 'Key saved — enter a new key to replace it' : 'Paste your Groq API key'}
            value={groqInput}
            onChange={setGroqInput}
            onSubmit={saveGroq}
            saved={settings?.groqApiKeySet}
          />
          <p style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 6 }}>
            Used for speech-to-text and reasoning when the voice engine above is set to Groq.
          </p>
        </Section>

        <Section title="ElevenLabs API key & voice">
          <KeyRow
            placeholder={settings?.elevenLabsApiKeySet ? 'Key saved — enter a new key to replace it' : 'Paste your ElevenLabs API key'}
            value={elevenLabsInput}
            onChange={setElevenLabsInput}
            onSubmit={saveElevenLabs}
            saved={settings?.elevenLabsApiKeySet}
          />
          {settings?.elevenLabsApiKeySet && (
            <select
              value={settings.elevenLabsVoiceId ?? ''}
              onChange={(e) => {
                const voice = elevenLabsVoices.find((v) => v.voiceId === e.target.value)
                if (voice) void setElevenLabsVoice(voice.voiceId, voice.name)
              }}
              style={{
                width: '100%',
                marginTop: 8,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--c-panel-border)',
                borderRadius: 8,
                padding: '10px 12px',
                color: 'var(--c-text-1)',
                fontSize: 13
              }}
            >
              <option value="" disabled>
                {elevenLabsVoices.length === 0 ? 'Loading voices…' : 'Choose a voice'}
              </option>
              {elevenLabsVoices.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name}
                  {v.category ? ` (${v.category})` : ''}
                </option>
              ))}
            </select>
          )}
          <p style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 6 }}>
            Used to speak DALVE's replies when the voice engine above is set to Groq.
          </p>
        </Section>

        <Section title="Composio API key">
          <KeyRow
            placeholder={settings?.composioApiKeySet ? 'Key saved — enter a new key to replace it' : 'Paste your Composio API key'}
            value={composioInput}
            onChange={setComposioInput}
            onSubmit={saveComposio}
            saved={settings?.composioApiKeySet}
          />
          {composioError && (
            <div style={{ fontSize: 12, color: '#e0785a', marginTop: 6 }}>{composioError}</div>
          )}
        </Section>

        <Section title="DALVE's voice">
          <select
            value={settings?.dalveVoice ?? 'Kore'}
            onChange={(e) => setDalveVoice(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--c-panel-border)',
              borderRadius: 8,
              padding: '10px 12px',
              color: 'var(--c-text-1)',
              fontSize: 13
            }}
          >
            {GEMINI_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 8 }}>
            Takes effect on your next voice session.
          </p>
        </Section>

        <Section title="DALVE's memory">
          <button
            onClick={() => setScreen('knowledge')}
            className="tracked-label"
            style={{
              fontSize: 11,
              padding: '9px 16px',
              borderRadius: 999,
              border: '1px solid var(--c-panel-border-strong)',
              color: 'var(--c-gold-bright)'
            }}
          >
            View in Knowledge
          </button>
          <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 8 }}>
            Facts DALVE has saved live on the Knowledge screen.
          </p>
        </Section>

        <Section title="Global shortcut">
          <p style={{ fontSize: 13, color: 'var(--c-text-1)' }}>
            Press <strong>Ctrl+Alt+D</strong> anywhere, anytime — DALVE jumps to your third
            monitor, goes fullscreen, and starts listening immediately.
          </p>
          <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 8 }}>
            Works even when the window is hidden in the tray or another app has focus. Voice
            wake-word ("Hey DALVE") was tried but wasn't reliable enough, so this hotkey is the
            replacement — instant, free, and doesn't depend on speech recognition at all.
          </p>
        </Section>

        <Section title="Connected apps">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(settings?.composioConnections ?? [])
              .filter((c) => c.connected)
              .map((c) => (
                <div
                  key={c.appKey}
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--c-text-2)' }}
                >
                  <span>{c.appName}</span>
                  <span style={{ color: '#6fe08a' }}>Connected</span>
                </div>
              ))}
            {(settings?.composioConnections ?? []).filter((c) => c.connected).length === 0 && (
              <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>Nothing connected yet.</span>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 8 }}>
            Manage connections from the Integrations screen.
          </p>
        </Section>

        <Section title="Custom MCP servers">
          <p style={{ fontSize: 12, color: 'var(--c-text-3)', marginBottom: 12 }}>
            Remote servers only (HTTP/SSE). Their tools are merged into DALVE's tool list.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {(settings?.mcpServers ?? []).map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--c-panel-border)',
                  background: 'var(--c-panel)'
                }}
              >
                <div>
                  <div style={{ fontSize: 13, color: 'var(--c-text-1)' }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--c-text-3)' }}>{s.url}</div>
                  <div style={{ fontSize: 11, color: s.connected ? '#6fe08a' : 'var(--c-text-3)', marginTop: 2 }}>
                    {s.connected ? `Connected — ${s.tools.length} tool(s)` : 'Not connected'}
                  </div>
                </div>
                <button onClick={() => removeMcpServer(s.id)} style={{ color: 'var(--c-text-3)' }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Input placeholder="Server name" value={mcpName} onChange={setMcpName} />
            <Input placeholder="https://example.com/mcp" value={mcpUrl} onChange={setMcpUrl} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="Auth header (optional)" value={mcpAuthHeader} onChange={setMcpAuthHeader} />
              <Input placeholder="Auth token (optional)" value={mcpAuthToken} onChange={setMcpAuthToken} type="password" />
            </div>
            <button
              onClick={submitMcp}
              className="tracked-label"
              style={{
                alignSelf: 'flex-start',
                fontSize: 11,
                padding: '8px 16px',
                borderRadius: 999,
                border: '1px solid var(--c-panel-border-strong)',
                color: 'var(--c-gold-bright)'
              }}
            >
              Add server
            </button>
            <p style={{ fontSize: 11, color: 'var(--c-text-3)' }}>
              Leave the auth fields blank for a server that uses its own login (like Lovable) —
              DALVE will open your browser to sign in and approve access the first time it connects.
            </p>
          </div>
        </Section>

        {appVersion && (
          <div style={{ fontSize: 11, color: 'var(--c-text-3)', textAlign: 'center' }}>
            DALVE v{appVersion}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="tracked-label" style={{ marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Input({
  placeholder,
  value,
  onChange,
  type = 'text'
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  type?: string
}): React.JSX.Element {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 1,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--c-panel-border)',
        borderRadius: 8,
        padding: '9px 12px',
        color: 'var(--c-text-1)',
        fontSize: 13
      }}
    />
  )
}

function KeyRow({
  placeholder,
  value,
  onChange,
  onSubmit,
  saved
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  saved?: boolean
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        style={{
          flex: 1,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--c-panel-border)',
          borderRadius: 8,
          padding: '10px 12px',
          color: 'var(--c-text-1)',
          fontSize: 13
        }}
      />
      <button
        onClick={onSubmit}
        className="tracked-label"
        style={{
          fontSize: 11,
          padding: '9px 16px',
          borderRadius: 999,
          border: '1px solid var(--c-panel-border-strong)',
          color: 'var(--c-gold-bright)'
        }}
      >
        Save
      </button>
      {saved && <span style={{ fontSize: 11, color: '#6fe08a' }}>●</span>}
    </div>
  )
}
