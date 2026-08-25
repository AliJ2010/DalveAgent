import { GoogleGenAI } from '@google/genai'
import type { BrowserWindow } from 'electron'
import { settingsStore } from './settingsStore'
import * as screenControl from './screenControl'
import type { AutonomousTaskEvent } from '@shared/types'

// A fast, cheap multimodal model for periodic polling — deliberately NOT the Live model, since
// this runs on a timer independent of any live voice session. gemini-2.5-flash was retired by
// Google (confirmed live via a 404 pointing here) — re-check availability periodically, same
// caveat as LIVE_MODEL in geminiLive.ts: Google rotates these ids.
const POLL_MODEL = 'gemini-3.6-flash'
const CHECK_INTERVAL_MS = 20_000
const MAX_HISTORY = 6

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: AutonomousTaskEvent): void {
  win?.webContents.send('autonomousTask:event', event)
}

interface Decision {
  narration: string
  action: 'none' | 'click' | 'type' | 'key'
  x?: number
  y?: number
  text?: string
  key?: string
  taskComplete: boolean
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    narration: {
      type: 'string',
      description: 'One short sentence describing what you observe and/or are about to do.'
    },
    action: { type: 'string', enum: ['none', 'click', 'type', 'key'] },
    x: { type: 'number', description: 'Pixel X, required if action is "click".' },
    y: { type: 'number', description: 'Pixel Y, required if action is "click".' },
    text: { type: 'string', description: 'Literal text to type, required if action is "type".' },
    key: { type: 'string', description: 'Key name to press, required if action is "key".' },
    taskComplete: { type: 'boolean', description: 'True once the goal has been fully accomplished and the task should end.' }
  },
  required: ['narration', 'action', 'taskComplete']
}

let timer: ReturnType<typeof setInterval> | null = null
let currentGoal: string | null = null
let history: string[] = []

export function isActive(): boolean {
  return timer !== null
}

export function getGoal(): string | null {
  return currentGoal
}

/**
 * Starts a background loop that watches the screen and acts on its own timer, independent of
 * any live voice session — the user explicitly opted into this running without per-action
 * confirmation for THIS goal specifically (see request_permission's normal per-live-session
 * gate, which this deliberately bypasses via screenControl.setControlGranted).
 */
export function startAutonomousTask(goal: string): void {
  if (timer) stopAutonomousTask('replaced by a new task')
  currentGoal = goal
  history = []
  screenControl.setControlGranted(true)
  emit({ type: 'started', goal })

  const runCycle = async (): Promise<void> => {
    try {
      await tick(goal)
    } catch (err) {
      console.error('[autonomousTask] cycle failed:', err)
      emit({
        type: 'log',
        text: `Hit an error and will retry next cycle: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  void runCycle()
  timer = setInterval(() => void runCycle(), CHECK_INTERVAL_MS)
}

export function stopAutonomousTask(reason = 'stopped by user'): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (currentGoal) emit({ type: 'stopped', reason })
  currentGoal = null
  screenControl.setControlGranted(false)
}

async function tick(goal: string): Promise<void> {
  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) {
    stopAutonomousTask('no Gemini API key configured')
    return
  }

  const base64 = await screenControl.captureScreenshotOnce(80)
  if (!base64) return

  const ai = new GoogleGenAI({ apiKey })
  const recentHistory = history.length > 0 ? history.join('\n') : '(nothing yet)'
  const prompt = `You are DALVE, running a background task the user explicitly asked you to handle without them present: "${goal}". You have standing permission to act (click/type/press keys) on this specific task without asking for confirmation each time — but be conservative: only act when something genuinely needs a response, never enter passwords/payment details/other credentials, and pick exactly one action (or "none") based on the current screenshot below. Recent actions you've already taken on this task:\n${recentHistory}`

  const response = await ai.models.generateContent({
    model: POLL_MODEL,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { inlineData: { data: base64, mimeType: 'image/jpeg' } }]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: DECISION_SCHEMA
    }
  })

  const raw = response.text
  if (!raw) return

  let decision: Decision
  try {
    decision = JSON.parse(raw)
  } catch (err) {
    console.error('[autonomousTask] failed to parse decision JSON:', raw, err)
    return
  }

  if (decision.narration) {
    history.push(decision.narration)
    if (history.length > MAX_HISTORY) history.shift()
    emit({ type: 'log', text: decision.narration })
  }

  if (decision.action === 'click' && typeof decision.x === 'number' && typeof decision.y === 'number') {
    screenControl.clickMouse(decision.x, decision.y)
  } else if (decision.action === 'type' && decision.text) {
    screenControl.typeText(decision.text)
  } else if (decision.action === 'key' && decision.key) {
    screenControl.pressKey(decision.key)
  }

  if (decision.taskComplete) {
    stopAutonomousTask('task completed')
  }
}
