import { useEffect, useState } from 'react'

interface VersionInfo {
  version: string
  justUpdated: boolean
  previousVersion?: string
}

/** Shown once per launch so there's never any doubt whether an update actually landed. */
export function VersionPopup(): React.JSX.Element | null {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void window.dalve.app.checkVersionUpdate().then(setInfo)
  }, [])

  if (!info || dismissed) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
      onClick={() => setDismissed(true)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          padding: '28px 26px',
          borderRadius: 16,
          background: '#0c0a08',
          border: '1px solid var(--c-panel-border-strong)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          textAlign: 'center'
        }}
      >
        <div
          className="tracked-label"
          style={{ fontSize: 10, color: info.justUpdated ? '#6fe08a' : 'var(--c-text-3)', marginBottom: 10 }}
        >
          {info.justUpdated ? 'Just Updated' : 'DALVE'}
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--c-warm-white)', marginBottom: 8 }}>
          v{info.version}
        </div>
        {info.justUpdated && info.previousVersion && (
          <div style={{ fontSize: 12.5, color: 'var(--c-text-2)', marginBottom: 18 }}>
            Updated from v{info.previousVersion}
          </div>
        )}
        {!info.justUpdated && (
          <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginBottom: 18 }}>
            No update since your last launch.
          </div>
        )}
        <button
          onClick={() => setDismissed(true)}
          style={{
            padding: '10px 24px',
            borderRadius: 999,
            background: 'var(--c-gold)',
            color: '#050403',
            fontWeight: 600,
            fontSize: 13.5
          }}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
