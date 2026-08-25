import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { VoiceView } from './components/VoiceView'
import { TranscriptPanel } from './components/TranscriptPanel'
import { IntegrationsScreen } from './components/IntegrationsScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { KnowledgeScreen } from './components/KnowledgeScreen'
import { AgentsCanvas } from './components/AgentsCanvas'
import { ScreenControlOverlay } from './components/ScreenControlOverlay'
import { AutonomousTaskOverlay } from './components/AutonomousTaskOverlay'
import { AuthScreen } from './components/AuthScreen'
import { useUiStore } from './state/uiStore'
import { useSettingsStore } from './state/settingsStore'
import { useAgentsStore } from './state/agentsStore'
import { useAuthStore } from './state/authStore'
import {
  initVoiceBridge,
  initScreenControlBridge,
  initAutonomousTaskBridge,
  initWakeTriggerBridge,
  toggleVoiceSession
} from './lib/voiceSession'

function App(): React.JSX.Element {
  const screen = useUiStore((s) => s.screen)
  const authStatus = useAuthStore((s) => s.status)

  useEffect(() => {
    void useAuthStore.getState().init()
  }, [])

  useEffect(() => {
    // Only load real app state once we know whether we're signed in — settings/agents come from
    // the cloud-synced stores once auth resolves, not before.
    if (authStatus === 'loading') return
    initVoiceBridge()
    initScreenControlBridge()
    initAutonomousTaskBridge()
    initWakeTriggerBridge()
    void useSettingsStore.getState().refresh()
    void useAgentsStore.getState().refresh()

    // Cross-device sync landing while the app is open — a change made on another signed-in
    // device shows up here live instead of requiring a sign-out/sign-in to force a re-fetch.
    const unsubSettings = window.dalve.settings.onChanged(() => void useSettingsStore.getState().refresh())
    const unsubAgents = window.dalve.agents.onChanged(() => void useAgentsStore.getState().refresh())
    return () => {
      unsubSettings()
      unsubAgents()
    }
  }, [authStatus])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (e.code === 'Space' && !isTyping && screen === 'home') {
        e.preventDefault()
        void toggleVoiceSession()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [screen])

  if (authStatus === 'loading') {
    return <div style={{ position: 'fixed', inset: 0, background: 'var(--c-void)' }} />
  }

  if (authStatus === 'signedOut') {
    return <AuthScreen />
  }

  return (
    <div style={{ display: 'flex', position: 'fixed', inset: 0, background: 'var(--c-void)' }}>
      <ScreenControlOverlay />
      <AutonomousTaskOverlay />
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0 }}>
        <TopBar />
        <div style={{ flex: 1, display: 'flex', position: 'relative', minHeight: 0 }}>
          {screen === 'home' && <VoiceView />}
          {screen === 'integrations' && <IntegrationsScreen />}
          {screen === 'agents' && <AgentsCanvas />}
          {screen === 'knowledge' && <KnowledgeScreen />}
          {screen === 'settings' && <SettingsScreen />}

          {screen === 'home' && (
            <div style={{ position: 'absolute', bottom: 24, right: 24, zIndex: 10 }}>
              <TranscriptPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
