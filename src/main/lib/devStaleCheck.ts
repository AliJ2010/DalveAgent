import { app, type BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import log from 'electron-log/main'

const execFileAsync = promisify(execFile)

// This app has no auto-update mechanism at all in dev mode (see autoUpdate.ts — it's a deliberate
// no-op unless app.isPackaged) — a real reported gap: running via `git pull && npm install &&
// npm run dev` is the ONLY way dev-mode code ever changes, and it's easy to open the app without
// remembering that step first, then wonder why "the latest features/UI changes" aren't there. This
// can't make git pull happen automatically, but it can at least make it obvious when the running
// code is behind the real latest commit, instead of silently showing stale code with no signal.
const REPO = 'AliJ2010/DalveAgent'

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

async function getLocalCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: app.getAppPath() })
    return stdout.trim()
  } catch (err) {
    // Not a git checkout, git not on PATH, etc. — nothing meaningful to compare against.
    log.info('[devStaleCheck] could not read local git HEAD:', err instanceof Error ? err.message : err)
    return null
  }
}

async function getRemoteCommit(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const data = (await res.json()) as { sha?: string }
    return data.sha ?? null
  } catch (err) {
    log.info('[devStaleCheck] could not reach GitHub:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function checkDevStale(): Promise<void> {
  if (app.isPackaged) return // packaged builds have their own real auto-update path
  const [local, remote] = await Promise.all([getLocalCommit(), getRemoteCommit()])
  if (!local || !remote || local === remote) return
  log.info('[devStaleCheck] running code is behind latest main:', local.slice(0, 7), '->', remote.slice(0, 7))
  win?.webContents.send('dev:staleCode', { local: local.slice(0, 7), remote: remote.slice(0, 7) })
}
