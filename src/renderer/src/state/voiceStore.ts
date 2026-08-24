import { create } from 'zustand'
import type { TranscriptEntry, TranscriptSpeaker, VoiceSessionState } from '@shared/types'

function entryId(): string {
  return `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

interface VoiceStoreState {
  sessionState: VoiceSessionState
  transcript: TranscriptEntry[]
  activeTab: string
  /** Which agent the live session is currently talking to — null means DALVE herself. */
  activeAgentId: string | null
  setSessionState: (s: VoiceSessionState) => void
  setActiveAgentId: (id: string | null) => void
  addEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string
  /** Appends a streaming transcript delta to the in-progress entry for that speaker,
   *  starting a new entry the first time it's called for the current turn. For 'dalve'
   *  entries, agentId tags who actually said it so relabeling doesn't happen on switch. */
  appendTranscript: (speaker: TranscriptSpeaker, textDelta: string, agentId?: string | null) => void
  /** Closes out the in-progress turn so the next transcript delta starts a fresh entry. */
  commitTurn: () => void
  setActiveTab: (tab: string) => void
}

let currentUserEntryId: string | null = null
let currentDalveEntryId: string | null = null

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  sessionState: 'idle',
  activeTab: 'DALVE',
  activeAgentId: null,
  transcript: [
    {
      id: entryId(),
      speaker: 'dalve',
      text: "I'm here whenever you're ready to talk.",
      timestamp: Date.now()
    }
  ],

  setSessionState: (sessionState) => set({ sessionState }),
  setActiveAgentId: (activeAgentId) => set({ activeAgentId }),

  addEntry: (entry) => {
    const id = entryId()
    set({ transcript: [...get().transcript, { ...entry, id, timestamp: Date.now() }] })
    return id
  },

  appendTranscript: (speaker, textDelta, agentId = null) => {
    const targetId = speaker === 'user' ? currentUserEntryId : currentDalveEntryId
    if (targetId && get().transcript.some((e) => e.id === targetId)) {
      set({
        transcript: get().transcript.map((e) =>
          e.id === targetId ? { ...e, text: e.text + textDelta } : e
        )
      })
      return
    }
    const id = get().addEntry({ speaker, text: textDelta, agentId: speaker === 'dalve' ? agentId : undefined })
    if (speaker === 'user') currentUserEntryId = id
    else currentDalveEntryId = id
  },

  commitTurn: () => {
    currentUserEntryId = null
    currentDalveEntryId = null
  },

  setActiveTab: (activeTab) => set({ activeTab })
}))
