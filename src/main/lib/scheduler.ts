import { Notification } from 'electron'
import log from 'electron-log/main'
import { scheduleStore } from './scheduleStore'
import { runCommand } from './telegramBridge'
import type { ScheduleItem, ScheduleRecurrence } from '@shared/types'

/**
 * A real, running-app-only scheduler — checks every 30s for due items and fires them. Honest
 * limitation stated plainly: this only works while DALVE is actually running (it's "open at
 * login" and lives in the tray, not a true OS-level scheduled task), so a reminder due while the
 * PC is fully off/asleep fires as soon as the app is next running, not exactly on time.
 *
 * Two kinds of item: a 'reminder' just shows a native OS notification. A 'message' actually
 * executes its instruction (e.g. "Send Ali on WhatsApp: don't forget the meeting") through
 * telegramBridge.ts's runCommand — the same tested one-shot agent loop remote Telegram commands
 * use — rather than a separate hand-rolled automation path.
 */

const CHECK_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null

function nextOccurrence(current: number, recurrence: ScheduleRecurrence): number | null {
  if (recurrence === 'none') return null
  const d = new Date(current)
  if (recurrence === 'daily') {
    d.setDate(d.getDate() + 1)
  } else if (recurrence === 'weekly') {
    d.setDate(d.getDate() + 7)
  } else if (recurrence === 'monthly') {
    d.setMonth(d.getMonth() + 1)
  } else {
    // weekdays
    do {
      d.setDate(d.getDate() + 1)
    } while (d.getDay() === 0 || d.getDay() === 6)
  }
  return d.getTime()
}

async function fireItem(item: ScheduleItem): Promise<void> {
  log.info(`[scheduler] firing "${item.title}" (${item.type})`)
  if (item.type === 'reminder') {
    if (Notification.isSupported()) {
      new Notification({ title: 'DALVE reminder', body: item.title }).show()
    }
    scheduleStore.recordFired(item.id, 'Notified.')
    return
  }

  let result: string
  try {
    result = await runCommand(item.instruction || item.title)
  } catch (err) {
    result = err instanceof Error ? err.message : String(err)
    log.error(`[scheduler] "${item.title}" threw:`, err)
  }
  log.info(`[scheduler] "${item.title}" result: ${result}`)
  if (Notification.isSupported()) {
    new Notification({ title: `DALVE: ${item.title}`, body: result.slice(0, 180) }).show()
  }
  scheduleStore.recordFired(item.id, result)
}

async function tick(): Promise<void> {
  const now = Date.now()
  const due = scheduleStore.list().filter((i) => i.enabled && i.dueAt <= now)
  for (const item of due) {
    // Advance (or disable, for a one-off) BEFORE firing — a slow-running message action can't
    // then get picked up again by an overlapping tick while it's still in flight.
    const next = nextOccurrence(item.dueAt, item.recurrence)
    if (next === null) scheduleStore.update(item.id, { enabled: false })
    else scheduleStore.update(item.id, { dueAt: next })
    void fireItem(item)
  }
}

export function startScheduler(): void {
  if (timer) return
  void tick()
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
