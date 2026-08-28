import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

/**
 * "Teach by demonstration" — real scope, stated honestly: this records the exact sequence of
 * tool calls DALVE itself executes while the user walks her through a task live (voice-driven,
 * same as any normal instruction), not a raw OS-level capture of the user's own independent
 * mouse/keyboard input. A true input-hook recorder would need a new native dependency (robotjs
 * only sends synthetic input, it can't listen to real hardware events) — this reuses DALVE's
 * existing, already-tested tool-execution path for both recording and replay instead, which is a
 * smaller, safer, and more honest v1: label/name-based steps (browser_click, click_element)
 * generalize well on replay since they're not tied to a screen position; raw coordinate steps
 * (click_mouse, drag_mouse) are recorded verbatim and may not transfer if the layout has since
 * changed — exactly the same reliability profile those tools already have for a normal one-off
 * instruction.
 */

export interface SkillStep {
  tool: string
  args: Record<string, unknown>
}

export interface Skill {
  id: string
  name: string
  steps: SkillStep[]
  createdAt: number
}

let win: BrowserWindow | null = null
export function attachWindow(window: BrowserWindow): void {
  win = window
}

function skillsPath(): string {
  return join(app.getPath('userData'), 'dalve-skills.json')
}

class SkillsStore {
  private data: Skill[]

  constructor() {
    this.data = this.load()
  }

  private load(): Skill[] {
    const path = skillsPath()
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
    writeFileSync(skillsPath(), JSON.stringify(this.data, null, 2), 'utf-8')
  }

  list(): Skill[] {
    return this.data
  }

  get(name: string): Skill | undefined {
    return this.data.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
  }

  save(name: string, steps: SkillStep[]): Skill {
    const existingIdx = this.data.findIndex((s) => s.name.toLowerCase() === name.trim().toLowerCase())
    const skill: Skill = {
      id: existingIdx >= 0 ? this.data[existingIdx].id : `skill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      name: name.trim(),
      steps,
      createdAt: Date.now()
    }
    if (existingIdx >= 0) this.data[existingIdx] = skill
    else this.data.push(skill)
    this.persist()
    win?.webContents.send('skills:changed')
    return skill
  }

  remove(name: string): boolean {
    const before = this.data.length
    this.data = this.data.filter((s) => s.name.toLowerCase() !== name.trim().toLowerCase())
    if (this.data.length === before) return false
    this.persist()
    win?.webContents.send('skills:changed')
    return true
  }
}

let _instance: SkillsStore | null = null
export const skillsStore = new Proxy({} as SkillsStore, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new SkillsStore()
    return Reflect.get(_instance, prop, receiver)
  }
})

// --- Recording state (shared across geminiLive.ts and groqVoice.ts's separate tool loops) ---

let recording: SkillStep[] | null = null

export function isRecording(): boolean {
  return recording !== null
}

export function startRecording(): void {
  recording = []
}

/** Called by each engine's tool-dispatch loop right after a call succeeds — a failed step isn't
 *  worth replaying later, so only successful ones get captured. */
export function recordStep(tool: string, args: Record<string, unknown>): void {
  recording?.push({ tool, args })
}

export function stopRecording(name: string): Skill | null {
  if (!recording) return null
  const steps = recording
  recording = null
  if (steps.length === 0) return null
  return skillsStore.save(name, steps)
}

export function discardRecording(): void {
  recording = null
}

/** Tool names that control recording/replay itself — must never end up recorded INTO a skill,
 *  or replaying one could nest into calling itself. */
export const SKILL_META_TOOLS = new Set(['start_recording_skill', 'stop_recording_skill', 'run_skill', 'list_skills'])
