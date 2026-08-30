import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { ScheduleItem, ScheduleRecurrence } from '@shared/types'

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function schedulePath(): string {
  return join(app.getPath('userData'), 'dalve-schedule.json')
}

function id(): string {
  return `sched_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

class ScheduleStore {
  private data: ScheduleItem[]

  constructor() {
    this.data = this.load()
  }

  private load(): ScheduleItem[] {
    const path = schedulePath()
    if (!existsSync(path)) return []
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return []
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(schedulePath(), JSON.stringify(this.data, null, 2), 'utf-8')
  }

  private notify(): void {
    win?.webContents.send('schedule:changed')
  }

  list(): ScheduleItem[] {
    return this.data
  }

  get(itemId: string): ScheduleItem | undefined {
    return this.data.find((i) => i.id === itemId)
  }

  add(partial: {
    title: string
    type: 'reminder' | 'message'
    instruction?: string
    dueAt: number
    recurrence: ScheduleRecurrence
  }): ScheduleItem {
    const item: ScheduleItem = {
      id: id(),
      title: partial.title,
      type: partial.type,
      instruction: partial.instruction,
      dueAt: partial.dueAt,
      recurrence: partial.recurrence,
      enabled: true,
      createdAt: Date.now()
    }
    this.data.push(item)
    this.persist()
    this.notify()
    return item
  }

  update(itemId: string, patch: Partial<ScheduleItem>): ScheduleItem | undefined {
    const idx = this.data.findIndex((i) => i.id === itemId)
    if (idx < 0) return undefined
    this.data[idx] = { ...this.data[idx], ...patch, id: itemId }
    this.persist()
    this.notify()
    return this.data[idx]
  }

  /** Called by scheduler.ts right after an item actually fires — separate from update() only so
   *  every firing (reminder shown, message sent) leaves a real, inspectable trace. */
  recordFired(itemId: string, result: string): void {
    this.update(itemId, { lastFiredAt: Date.now(), lastResult: result })
  }

  remove(itemId: string): boolean {
    const before = this.data.length
    this.data = this.data.filter((i) => i.id !== itemId)
    if (this.data.length === before) return false
    this.persist()
    this.notify()
    return true
  }
}

let _instance: ScheduleStore | null = null
export const scheduleStore = new Proxy({} as ScheduleStore, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new ScheduleStore()
    return Reflect.get(_instance, prop, receiver)
  }
})

// --- Shared voice-tool logic (one real implementation, used by geminiLive.ts, geminiTurnVoice.ts,
// and agentTools.ts's shared tool set — each declares its own tool schema per its own conventions,
// but all three call these same functions so the actual behavior never drifts between engines). ---

const RECURRENCES = new Set(['none', 'daily', 'weekdays', 'weekly', 'monthly'])

export function createReminderTool(args: Record<string, unknown>): { status: 'SUCCESS' | 'FAILED'; result?: string; error?: string } {
  const title = String(args.title ?? '').trim()
  if (!title) return { status: 'FAILED', error: 'Need a title for this reminder.' }
  const dueAtIso = String(args.dueAtIso ?? '')
  const dueAt = Date.parse(dueAtIso)
  if (Number.isNaN(dueAt)) return { status: 'FAILED', error: `"${dueAtIso}" isn't a valid date/time — pass a real ISO 8601 datetime.` }
  const recurrence = (RECURRENCES.has(String(args.recurrence)) ? args.recurrence : 'none') as ScheduleRecurrence
  const type = args.type === 'message' ? 'message' : 'reminder'
  const instruction = String(args.instruction ?? '').trim()
  if (type === 'message' && !instruction) {
    return { status: 'FAILED', error: 'A "message" item needs an instruction describing what to actually do when it fires.' }
  }
  scheduleStore.add({ title, type, instruction: type === 'message' ? instruction : undefined, dueAt, recurrence })
  const when = new Date(dueAt).toLocaleString()
  return { status: 'SUCCESS', result: `Scheduled "${title}" for ${when}${recurrence !== 'none' ? ` (repeating ${recurrence})` : ''}.` }
}

export function listRemindersTool(): string {
  const items = scheduleStore.list().filter((i: ScheduleItem) => i.enabled)
  if (items.length === 0) return 'No upcoming reminders or scheduled messages.'
  return items
    .sort((a: ScheduleItem, b: ScheduleItem) => a.dueAt - b.dueAt)
    .map((i: ScheduleItem) => `- "${i.title}" (${i.type}) — ${new Date(i.dueAt).toLocaleString()}${i.recurrence !== 'none' ? ` [${i.recurrence}]` : ''}`)
    .join('\n')
}

export function cancelReminderTool(title: string): { status: 'SUCCESS' | 'FAILED'; result?: string; error?: string } {
  const target = title.trim().toLowerCase()
  const item = scheduleStore.list().find((i: ScheduleItem) => i.enabled && i.title.toLowerCase() === target)
  if (!item) return { status: 'FAILED', error: `No active reminder/schedule named "${title}".` }
  scheduleStore.update(item.id, { enabled: false })
  return { status: 'SUCCESS', result: `Cancelled "${title}".` }
}
