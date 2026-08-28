import { create } from 'zustand'
import type { Subtask } from '@shared/types'

interface AutonomousTaskState {
  active: boolean
  goal: string | null
  log: string[]
  subtasks: Subtask[]
  /** The ONE synthesized result from mark_task_complete's finalSummary — shown after the task
   *  stops so the user gets a real answer, not just a pile of step-by-step log lines to read
   *  through themselves. Cleared the next time a task starts. */
  lastSummary: string | null
  setActive: (active: boolean, goal: string | null) => void
  addLog: (text: string) => void
  setSubtasks: (subtasks: Subtask[]) => void
  setSummary: (summary: string | null) => void
}

const MAX_LOG = 5

export const useAutonomousTaskStore = create<AutonomousTaskState>((set, get) => ({
  active: false,
  goal: null,
  log: [],
  subtasks: [],
  lastSummary: null,
  // subtasks is deliberately untouched here — main always sends a fresh 'subtasks' event (empty
  // on a new start, or the final state on stop) right alongside 'started'/'stopped', so the
  // overlay can still show the last checklist state next to the final summary after stopping.
  setActive: (active, goal) => set({ active, goal, log: active ? get().log : [], lastSummary: active ? null : get().lastSummary }),
  addLog: (text) => set({ log: [...get().log, text].slice(-MAX_LOG) }),
  setSubtasks: (subtasks) => set({ subtasks }),
  setSummary: (summary) => set({ lastSummary: summary })
}))
