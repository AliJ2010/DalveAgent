import { useEffect, useState } from 'react'
import { ScrollText, RefreshCw, Copy, AlertTriangle } from 'lucide-react'

const MAX_LINES = 500

function levelColor(line: string): string {
  if (/\[error\]/i.test(line)) return '#e0785a'
  if (/\[warn\]/i.test(line)) return '#e0c05a'
  return 'var(--c-text-2)'
}

/**
 * A real in-app log viewer — before this, checking what actually went wrong meant handing over
 * the raw log file by hand. Reads the same file electron-log already writes
 * (%APPDATA%/dalve/logs/main.log), most recent line last, with a quick filter for
 * warnings/errors only since that's almost always what you're actually looking for.
 */
export function LogsScreen(): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [path, setPath] = useState('')
  const [filter, setFilter] = useState<'all' | 'warnErr'>('warnErr')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    const res = await window.dalve.logs.read(filter, MAX_LINES)
    setLines(res.lines)
    setPath(res.path)
    if (res.error) setError(res.error)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard access denied — non-critical, just skip the "copied" confirmation
    }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 40px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ maxWidth: 900, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <ScrollText size={18} color="var(--c-gold)" strokeWidth={1.5} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--c-text-1)' }}>Logs</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 16 }}>
          {path || 'Loading log file...'}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <button
            onClick={() => setFilter('warnErr')}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 12,
              border: filter === 'warnErr' ? '1px solid var(--c-gold)' : '1px solid var(--c-panel-border)',
              color: filter === 'warnErr' ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
              background: filter === 'warnErr' ? 'rgba(212,175,55,0.08)' : 'transparent'
            }}
          >
            Warnings &amp; errors
          </button>
          <button
            onClick={() => setFilter('all')}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 12,
              border: filter === 'all' ? '1px solid var(--c-gold)' : '1px solid var(--c-panel-border)',
              color: filter === 'all' ? 'var(--c-gold-bright)' : 'var(--c-text-2)',
              background: filter === 'all' ? 'rgba(212,175,55,0.08)' : 'transparent'
            }}
          >
            Everything
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={copyAll}
              className="tracked-label"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--c-panel-border-strong)', color: 'var(--c-text-2)' }}
            >
              <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => void load()}
              className="tracked-label"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--c-panel-border-strong)', color: 'var(--c-gold-bright)' }}
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#e0785a', marginBottom: 10 }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.35)',
            border: '1px solid var(--c-panel-border)',
            borderRadius: 10,
            padding: '10px 14px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 11.5
          }}
        >
          {lines.length === 0 ? (
            <p style={{ color: 'var(--c-text-3)' }}>{loading ? 'Loading…' : 'Nothing to show for this filter.'}</p>
          ) : (
            lines.map((line, i) => (
              <div key={i} style={{ color: levelColor(line), whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 2 }}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
