import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface JournalDay {
  date: string // YYYY-MM-DD
  lines: string[] // "[HH:MM] User: ..." / "[HH:MM] DALVE: ..."
}

// Keeping every day forever would grow the file and the prompt built from it without bound —
// this caps it to roughly a month of daily continuity, which is what "remember what we did
// yesterday/last week" actually needs, without silently ballooning token cost as the assistant
// gets used for months. Older days are dropped, not summarized — a real limitation, not a bug.
const MAX_DAYS_KEPT = 30
// How much of the journal gets fed back into the system prompt on a NEW session. Kept smaller
// than what's stored on disk so a long day's conversation doesn't blow the prompt budget.
const MAX_CONTEXT_CHARS = 10_000

function journalPath(): string {
  return join(app.getPath('userData'), 'dalve-journal.json')
}

function load(): JournalDay[] {
  const path = journalPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function persist(days: JournalDay[]): void {
  try {
    writeFileSync(journalPath(), JSON.stringify(days), 'utf-8')
  } catch (err) {
    console.error('[journal] failed to persist:', err)
  }
}

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function timeLabel(d = new Date()): string {
  return d.toTimeString().slice(0, 5)
}

/** Appends one finished line (a completed turn, not a streaming delta) to today's journal entry. */
export function appendLine(speaker: 'user' | 'dalve', text: string, speakerLabel?: string): void {
  const trimmed = text.trim()
  if (!trimmed) return

  const days = load()
  const today = todayKey()
  let day = days.find((d) => d.date === today)
  if (!day) {
    day = { date: today, lines: [] }
    days.push(day)
  }

  const label = speaker === 'user' ? 'User' : (speakerLabel ?? 'DALVE')
  day.lines.push(`[${timeLabel()}] ${label}: ${trimmed}`)

  days.sort((a, b) => a.date.localeCompare(b.date))
  while (days.length > MAX_DAYS_KEPT) days.shift()

  persist(days)
}

/**
 * Builds a recap of recent days for injection into a new session's system prompt, most recent
 * day last (so it reads chronologically) and trimmed to a character budget from the OLDEST end —
 * losing detail on older days first rather than truncating today's conversation.
 */
export function getRecentContext(): string {
  const days = load()
  if (days.length === 0) return ''

  const blocks = days.map((d) => `## ${d.date}\n${d.lines.join('\n')}`)
  let combined = blocks.join('\n\n')

  while (combined.length > MAX_CONTEXT_CHARS && blocks.length > 1) {
    blocks.shift()
    combined = blocks.join('\n\n')
  }
  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = combined.slice(combined.length - MAX_CONTEXT_CHARS)
  }

  return combined
}
