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
  /** Per-agent override for the turn-based (non-live) engine's ElevenLabs voice — undefined means
   *  "use the global default voice from Settings" rather than every agent sounding identical
   *  under that engine. */
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

// 'gemini' is the true bidirectional Live session (geminiLive.ts). 'geminiTurns' is a turn-based
// cascade on the SAME Gemini API key — record an utterance, transcribe + reason + call tools via
// ai.models.generateContent, speak the reply via ElevenLabs (geminiTurnVoice.ts) — kept as a
// distinct engine rather than folded into geminiLive.ts because it has fundamentally different
// session mechanics (no continuous stream, its own VAD/barge-in), the same reasoning that used to
// separate the old Groq-backed engine. Replaced Groq entirely (real reported failure: it "refuses
// to work") — this reuses the Gemini key already configured for Live, no separate credential.
export type VoiceEngine = 'gemini' | 'geminiTurns'

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
  elevenLabsApiKeySet: boolean
  elevenLabsVoiceId?: string
  elevenLabsVoiceName?: string
  /** Voices added by hand (e.g. a shared/library voice ElevenLabs' own API won't list under this
   *  account) so they still show up as pickable options alongside the ones fetched from /v2/voices. */
  elevenLabsCustomVoices: { voiceId: string; name: string }[]
  voiceEngine: VoiceEngine
  dalveTone: DalveTone
  picovoiceAccessKeySet: boolean
  wakeWordEnabled: boolean
  /** One of the built-in keywords Porcupine ships with no training needed, or 'custom' to use
   *  wakeWordCustomPath instead — "Hey DALVE" specifically requires the user to train a keyword
   *  file once (free) at console.picovoice.ai and point to it, there's no way around that step. */
  wakeWordKeyword: BuiltinWakeWord | 'custom'
  wakeWordCustomPath?: string
}

export const BUILTIN_WAKE_WORDS = ['jarvis', 'computer', 'porcupine', 'picovoice', 'alexa', 'terminator'] as const
export type BuiltinWakeWord = (typeof BUILTIN_WAKE_WORDS)[number]

export type DalveTone = 'default' | 'formal' | 'casual' | 'playful' | 'direct'

export const DALVE_TONE_LABELS: Record<DalveTone, string> = {
  default: 'Default',
  formal: 'Formal',
  casual: 'Casual',
  playful: 'Playful',
  direct: 'Direct'
}

export const DALVE_TONE_PROMPTS: Record<DalveTone, string> = {
  default: '',
  formal: 'Speak formally and professionally — no slang, no casual contractions, precise and measured phrasing.',
  casual: "Speak casually and conversationally, like a close friend — contractions, informal phrasing, relaxed tone.",
  playful: "Speak with personality — light humor and playful phrasing are welcome, don't be afraid to have fun with a response, while still actually being useful.",
  direct: 'Be maximally direct and terse — no pleasantries, no hedging, no filler. Shortest phrasing that is still clear.'
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
  /** Normalized index-to-middle fingertip distance — the third leg of the thumb/index/middle
   *  triangle. Needed for the zoom gesture (a genuine 3-finger pinch/spread moves all three
   *  pairwise distances together) and to gate left/right-click engagement so a 3-finger zoom
   *  motion can't be misread as a 2-finger click mid-gesture. */
  indexMiddleDist: number
  /** How "open" the hand is right now (normalized) and the palm's vertical position. */
  spread: number
  palmY: number
}

/** One frame of the two-fist "steering wheel" gesture — a fist centroid per hand, or null if that
 *  hand isn't currently visible. Unlike HandFrame (raw unmirrored coordinates, mirrored later in
 *  main process), these x values are ALREADY mirrored by the renderer before sending — steering
 *  needs to assign "left"/"right" roles by comparing the two hands' x positions the same way the
 *  mirrored preview visually shows them (smaller x = appears on the left), which only lines up
 *  with the user's actual left/right hand once mirrored. y is unaffected by mirroring either way. */
export interface SteeringFrame {
  left: { x: number; y: number } | null
  right: { x: number; y: number } | null
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

// --- Scheduler / calendar ---

export type ScheduleRecurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface ScheduleItem {
  id: string
  title: string
  /** 'reminder' just notifies at the due time. 'message' actually executes `instruction` (e.g.
   *  "Send Ali on WhatsApp: don't forget the meeting") through the same one-shot agent loop
   *  Telegram commands already use — real DOM/UI actions, not a fake "sent" claim. */
  type: 'reminder' | 'message'
  instruction?: string
  /** Epoch ms of the next (or, for 'none', only) time this fires. */
  dueAt: number
  recurrence: ScheduleRecurrence
  enabled: boolean
  lastFiredAt?: number
  /** What actually happened last time this fired — a notification confirmation for a reminder,
   *  or the real result text for a message, so "did that actually send?" has a real answer. */
  lastResult?: string
  createdAt: number
}

export const PRIORITY_COMPOSIO_APPS: { key: string; name: string }[] = [
  { key: 'gmail', name: 'Gmail' },
  { key: 'stripe', name: 'Stripe' },
  { key: 'whatsapp', name: 'WhatsApp' },
  { key: 'github', name: 'GitHub' }
]

export const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'] as const

// A generic, primitive-based description of a real-world object for the spatial AR system
// (src/renderer/src/spatial/spatialEngine.ts) — one generic renderer/interaction path handles
// ANY blueprint, whether it's a hand-authored built-in (a microwave, a lamp) or one an AI just
// generated from looking at a screenshot, rather than a bespoke hardcoded mesh per object type.
export type ArShape = 'box' | 'cylinder' | 'sphere'
// 'body' is the main graspable part (move/rotate/resize target). 'door' hinges open via its
// 'handle' child. 'button' presses inward on pinch. 'static' is purely decorative (no interaction).
export type ArPartRole = 'body' | 'handle' | 'button' | 'door' | 'static'

export interface ArBlueprintPart {
  id: string
  shape: ArShape
  /** box: [width, height, depth]. cylinder: [radiusTop, radiusBottom, height]. sphere: [radiusX,
   *  radiusY, radiusZ] — the three axes can differ, stretching/squashing it into an ellipsoid
   *  (an egg, a flattened spoon head, a squashed lid), not just a uniform ball. */
  size: [number, number, number]
  /** Local position relative to the parent (or the object's own origin, if no parent). For a
   *  'door' part this is where its hinge axis sits, not its visual center — see hingeOffset. */
  position: [number, number, number]
  rotation?: [number, number, number]
  /** CSS hex color, e.g. "#d4af37". */
  color: string
  role?: ArPartRole
  /** id of another part in the same blueprint this attaches to. Omit/null to attach to the root. */
  parentId?: string | null
  /** Only meaningful on a 'door' part: the visual mesh's offset from the hinge axis in `position`,
   *  so it swings around that axis instead of spinning in place around its own center. */
  hingeOffset?: [number, number, number]
  metalness?: number
  roughness?: number
}

export interface ArBlueprint {
  name: string
  parts: ArBlueprintPart[]
}
