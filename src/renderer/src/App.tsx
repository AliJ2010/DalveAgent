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
import { useUiStore } from './state/uiStore'
import { useSettingsStore } from './state/settingsStore'
import {
  initVoiceBridge,
  initScreenControlBridge,
  initAutonomousTaskBridge,
  initWakeTriggerBridge,
  toggleVoiceSession
} from './lib/voiceSession'

function App(): React.JSX.Element {
  const screen = useUiStore((s) => s.screen)

  useEffect(() => {
    initVoiceBridge()
    initScreenControlBridge()
    initAutonomousTaskBridge()
    initWakeTriggerBridge()
    // Starts the always-on wake-word mic feed immediately at boot (not just when the Settings
    // screen happens to be open) — the whole point is that it works while minimized to the tray.
    void useSettingsStore.getState().refresh()
  }, [])

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
