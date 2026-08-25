import { useState } from 'react'
import { useAuthStore } from '../state/authStore'

export function AuthScreen(): React.JSX.Element {
  const signUp = useAuthStore((s) => s.signUp)
  const signIn = useAuthStore((s) => s.signIn)

  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(): Promise<void> {
    if (!email.trim() || !password) return
    setSubmitting(true)
    setError(null)
    const err = mode === 'signUp' ? await signUp(email.trim(), password) : await signIn(email.trim(), password)
    setSubmitting(false)
    if (err) setError(err)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--c-void)'
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: '90vw',
          padding: 32,
          borderRadius: 16,
          background: 'var(--c-panel)',
          border: '1px solid var(--c-panel-border-strong)',
          boxShadow: '0 0 60px rgba(212,175,55,0.12)'
        }}
      >
        <div
          className="tracked-label"
          style={{ color: 'var(--c-gold)', fontSize: 15, letterSpacing: '0.2em', marginBottom: 6 }}
        >
          DALVE_OS<span style={{ fontSize: 8, verticalAlign: 'super' }}>™</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 24 }}>
          {mode === 'signIn'
            ? 'Sign in to sync your agents, memory, and settings across every device.'
            : 'One account, synced everywhere — Windows, macOS, and whatever comes next.'}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />

          {error && <div style={{ fontSize: 12, color: '#e0785a' }}>{error}</div>}

          <button
            type="submit"
            disabled={submitting || !email.trim() || !password}
            className="tracked-label"
            style={{
              marginTop: 8,
              padding: '11px 0',
              borderRadius: 999,
              border: '1px solid var(--c-gold)',
              background: 'var(--c-gold)',
              color: '#050403',
              fontSize: 12,
              fontWeight: 600,
              opacity: submitting || !email.trim() || !password ? 0.5 : 1
            }}
          >
            {submitting ? 'Working…' : mode === 'signIn' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode((m) => (m === 'signIn' ? 'signUp' : 'signIn'))
            setError(null)
          }}
          className="tracked-label"
          style={{ marginTop: 18, fontSize: 11, color: 'var(--c-text-3)', width: '100%', textAlign: 'center' }}
        >
          {mode === 'signIn' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--c-panel-border)',
  borderRadius: 10,
  padding: '11px 14px',
  color: 'var(--c-text-1)',
  fontSize: 13
}
