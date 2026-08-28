// Shared types used by both the main (Electron) process and the renderer (React) process.
// Keep this file dependency-free so it can be imported from either side of the IPC boundary.

export type AgentType = 'companion' | 'bot'

export type AgentStatus = 'idle' | 'active' | 'working'

export interface AgentConfig {
  id: string
  name: string
  type: AgentType
  parentId: string | null
  color: string // hex color, e.g. "#d4af37"
  systemPrompt: string
  toolScope: string[] // Composio action ids / MCP tool ids this agent may use
  memory: string // persistent free-text notes, scoped to this agent
  voice: string // Gemini Live voice name
  /** Per-agent override for the Groq+ElevenLabs engine — undefined means "use the global default
   *  voice from Settings" rather than every agent sounding identical under that engine. */
  elevenLabsVoiceId?: string
  elevenLabsVoiceName?: string
  status: AgentStatus
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface DelegationEvent {
  id: string
  agentId: string
  agentName: string
  agentColor: string
  task: string
  result?: string
  startedAt: number
  finishedAt?: number
}

export type TranscriptSpeaker = 'user' | 'dalve' | 'system'

export interface TranscriptEntry {
  id: string
  speaker: TranscriptSpeaker
  text: string
  timestamp: number
  /** For speaker 'dalve': which agent actually said this, captured at the time it was said.
   *  null/undefined means DALVE herself. Fixes entries getting relabeled after switching agents. */
  agentId?: string | null
  // for 'system' entries that represent a delegation handoff
  delegation?: {
    agentId: string
    agentName: string
    agentColor: string
  }
}

export interface ComposioConnection {
  appKey: string // Composio toolkit slug, e.g. "gmail", "stripe", "github"
  appName: string
  logo?: string
  connected: boolean
  connectedAccountId?: string
}

export type ComposioAuthScheme = 'OAUTH2' | 'API_KEY' | 'NO_AUTH' | 'OTHER'

export interface ComposioCatalogEntry {
  slug: string
  name: string
  logo?: string
  description?: string
  category?: string
  authScheme: ComposioAuthScheme
}

export interface McpServerConfig {
  id: string
  name: string
  url: string
  authHeader?: string
  authToken?: string
  connected: boolean
  tools: string[]
}

export interface SettingsState {
  geminiApiKeySet: boolean
  anthropicApiKeySet: boolean
  composioApiKeySet: boolean
  composioConnections: ComposioConnection[]
  mcpServers: McpServerConfig[]
  dalveVoice: string
  dalveMemory: string
  telegramBotTokenSet: boolean
  telegramChatBound: boolean
  groqApiKeySet: boolean
  elevenLabsApiKeySet: boolean
  elevenLabsVoiceId?: string
  elevenLabsVoiceName?: string
  /** Voices added by hand (e.g. a shared/library voice ElevenLabs' own API won't list under this
   *  account) so they still show up as pickable options alongside the ones fetched from /v2/voices. */
  elevenLabsCustomVoices: { voiceId: string; name: string }[]
  voiceEngine: 'gemini' | 'groq'
}

/** One tracked-hand frame from the renderer's camera+MediaPipe pipeline, sent to the main
 *  process over IPC — see handTracking.ts for how each field drives cursor/click/zoom. */
export interface HandFrame {
  /** Index fingertip position, normalized 0-1 in the raw (unmirrored) camera frame. */
  indexX: number
  indexY: number
  /** Normalized thumb-to-index and thumb-to-middle fingertip distances, for left/right-click. */
  thumbIndexDist: number
  thumbMiddleDist: number
  /** How "open" the hand is right now (normalized) and the palm's vertical position — together
   *  drive the zoom gesture. */
  spread: number
  palmY: number
}

export type VoiceSessionState = 'idle' | 'listening' | 'speaking' | 'connecting' | 'error'

export type VoiceEvent =
  | { type: 'state'; state: VoiceSessionState }
  | { type: 'inputTranscript'; text: string; finished: boolean }
  | { type: 'outputTranscript'; text: string; finished: boolean }
  | { type: 'audio'; data: string } // base64 PCM16, 24kHz, mono
  | { type: 'interrupted' }
  | { type: 'turnComplete' }
  | { type: 'error'; message: string }
  /** Fires when the active agent changes for any reason, including DALVE switching it herself mid-conversation. */
  | { type: 'activeAgentChanged'; agentId: string | null }
  /** Fires around a tool call actually executing — lets the UI show "working" instead of leaving
   *  the user unsure whether anything is happening between "I'll do that" and a spoken result. */
  | { type: 'toolActivity'; active: boolean; label?: string }
  /** One real completed step for the Action Timeline — fired after EVERY tool call resolves
   *  (success or failure), reusing that tool's own real result/error text rather than a made-up
   *  description, so the timeline never claims a step happened that didn't actually run. */
  | { type: 'actionLog'; entry: ActionLogEntry }

export interface ActionLogEntry {
  id: string
  label: string
  status: 'success' | 'error'
  detail?: string
  timestamp: number
}

export type ScreenControlEvent = { type: 'active'; active: boolean }

export interface Subtask {
  id: string
  text: string
  done: boolean
}

export type AutonomousTaskEvent =
  | { type: 'started'; goal: string }
  // `summary` is set only when the task finished by genuinely completing (mark_task_complete),
  // carrying the ONE synthesized result rather than the raw step-by-step log — undefined for a
  // manual/external stop, which has no "result" to summarize.
  | { type: 'stopped'; reason: string; summary?: string }
  | { type: 'log'; text: string }
  /** Replaces the whole checklist — sent once a multi-step goal has been broken down, and again
   *  whenever a subtask's done state changes. */
  | { type: 'subtasks'; subtasks: Subtask[] }

export const PRIORITY_COMPOSIO_APPS: { key: string; name: string }[] = [
  { key: 'gmail', name: 'Gmail' },
  { key: 'stripe', name: 'Stripe' },
  { key: 'whatsapp', name: 'WhatsApp' },
  { key: 'github', name: 'GitHub' }
]

export const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'] as const
