import { Globe, Plug, Zap, BookOpen, CalendarDays, ScrollText, Settings, ShieldAlert } from 'lucide-react'
import { useUiStore, type Screen } from '../state/uiStore'

interface RailItem {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>
  screen?: Screen
  label: string
}

const TOP_ITEMS: RailItem[] = [
  { icon: Globe, screen: 'home', label: 'Home' },
  { icon: Plug, screen: 'integrations', label: 'Integrations' },
  { icon: Zap, screen: 'agents', label: 'Agents' },
  { icon: BookOpen, screen: 'knowledge', label: 'Knowledge' },
  { icon: CalendarDays, screen: 'calendar', label: 'Calendar' },
  { icon: ScrollText, screen: 'logs', label: 'Logs' }
]

export function Sidebar(): React.JSX.Element {
  const screen = useUiStore((s) => s.screen)
  const setScreen = useUiStore((s) => s.setScreen)

  return (
    <div
      style={{
        width: 56,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 0',
        borderRight: '1px solid var(--c-panel-border)',
        background: 'rgba(8,7,10,0.6)',
        zIndex: 20
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        {TOP_ITEMS.map(({ icon: Icon, screen: target, label }) => {
          const active = target && target === screen
          return (
            <button
              key={label}
              title={label}
              onClick={() => target && setScreen(target)}
              style={{
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 8,
                color: active ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
                background: active ? 'rgba(212,175,55,0.12)' : 'transparent',
                boxShadow: active ? 'inset 0 0 0 1px var(--c-panel-border-strong)' : 'none',
                transition: 'all 120ms ease'
              }}
            >
              <Icon size={18} strokeWidth={1.6} />
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        <button
          title="Privacy panic — stop mic/camera/screen-share and close DALVE (Ctrl+Alt+Q)"
          onClick={() => {
            if (window.confirm('Stop everything and close DALVE right now?')) void window.dalve.panic.trigger()
          }}
          style={{
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            color: '#e05a5a'
          }}
        >
          <ShieldAlert size={18} strokeWidth={1.6} />
        </button>
        <button
          title="Settings"
          onClick={() => setScreen('settings')}
          style={{
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            color: screen === 'settings' ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
            background: screen === 'settings' ? 'rgba(212,175,55,0.12)' : 'transparent'
          }}
        >
          <Settings size={18} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  )
}
