import { useEffect, useState } from 'react'

interface StaleInfo {
  local: string
  remote: string
}

/** Dev-mode-only signal for a real reported gap: running via `npm run dev` has NO auto-update at
 *  all (see autoUpdate.ts — packaged-only by design), so `git pull && npm install && npm run dev`
 *  is the only thing that ever changes the code, and it's easy to open the app without doing that
 *  first and just see stale UI/features with no indication why. Main process compares local git
 *  HEAD against the real latest commit on GitHub and fires this if they differ. */
export function DevStaleBanner(): React.JSX.Element | null {
  const [info, setInfo] = useState<StaleInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => window.dalve.app.onDevStaleCode(setInfo), [])

  if (!info || dismissed) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 101,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '8px 16px',
        background: 'rgba(224,150,60,0.16)',
        borderBottom: '1px solid #e0963c',
        backdropFilter: 'blur(6px)'
      }}
    >
      <span className="tracked-label" style={{ color: 'var(--c-text-1)', fontSize: 11 }}>
        RUNNING OLDER CODE ({info.local}, LATEST IS {info.remote}) — RUN{' '}
        <code style={{ fontFamily: 'monospace' }}>git pull && npm install</code> AND RESTART
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="tracked-label"
        style={{
          padding: '4px 12px',
          borderRadius: 999,
          border: '1px solid #e0963c',
          color: '#e0963c',
          fontSize: 10
        }}
      >
        DISMISS
      </button>
    </div>
  )
}
