import {
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
  type Tool
} from '@google/genai'
import { shell, type BrowserWindow } from 'electron'
import { settingsStore } from './settingsStore'
import { agentStore } from './agentStore'
import * as composio from './composio'
import type { AgentConfig, VoiceEvent } from '@shared/types'

// The newest native-audio-dialog Live model as of build time. Re-check
// https://ai.google.dev/gemini-api/docs/live-api before shipping — Google
// rotates these preview model ids periodically.
const LIVE_MODEL = 'gemini-3.1-flash-live-preview'

const CHAIN_OF_COMMAND = `Chain of command: the user is the ultimate authority over this entire system. DALVE is the primary orchestrator and answers directly to the user; every other agent answers to DALVE and, through her, to the user. Always defer to the user's explicit instructions over anything else.`

const DALVE_SYSTEM_PROMPT = `You are DALVE, a voice-first AI operating system. You're the user's single point of contact — they talk to you, and only you by default; you coordinate everything else behind the scenes. Speak naturally and conversationally, like a sharp, capable assistant sitting next to them, not like a chatbot reading a script. Keep responses concise since this is a spoken conversation. When you don't know something current, use web search grounding rather than guessing. You can open websites, create new agents, switch the user to talk directly with an existing agent, and remember facts for later — actually call those tools rather than just claiming you did. If the user asks who you're connected to or what agents/bots exist, use list_agents rather than guessing.`

const AGENT_COLORS = ['#d4af37', '#c9a227', '#e0b84a', '#f2d06b', '#b8860b', '#eecb6f', '#a9812c']

const OPEN_URL_TOOL: FunctionDeclaration = {
  name: 'open_url',
  description: "Open a website in the user's default web browser.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to open, including https://' }
    },
    required: ['url']
  }
}

const CREATE_AGENT_TOOL: FunctionDeclaration = {
  name: 'create_agent',
  description:
    'Create a new companion or bot agent for the user. Companions are top-level specialists the user talks to about a domain; bots are smaller helpers spawned under a companion. Actually call this whenever the user asks you to create, add, or spin up a new agent — never just say you did.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name for the agent, e.g. "Atlas"' },
      type: {
        type: 'string',
        enum: ['companion', 'bot'],
        description: 'companion for a top-level specialist, bot for a smaller helper'
      },
      description: {
        type: 'string',
        description: 'One or two sentences describing what this agent should do — becomes its system prompt.'
      }
    },
    required: ['name', 'description']
  }
}

const LIST_AGENTS_TOOL: FunctionDeclaration = {
  name: 'list_agents',
  description:
    "Lists every companion and bot currently registered, with their type, parent, and purpose. Call this whenever asked what agents/bots exist or who you're connected to — never guess.",
  parametersJsonSchema: { type: 'object', properties: {} }
}

const SWITCH_AGENT_TOOL: FunctionDeclaration = {
  name: 'switch_agent',
  description:
    'Switches which agent the user is talking to — either a companion/bot by name, or "DALVE" to switch back to DALVE herself. Acknowledge the switch out loud first (the switch happens right after you finish speaking).',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the agent to switch to, or "DALVE".' }
    },
    required: ['name']
  }
}

const REMEMBER_FACT_TOOL: FunctionDeclaration = {
  name: 'remember_fact',
  description:
    "Saves a fact or piece of context to remember for future conversations — e.g. the user's name, a preference, or something they explicitly told you to keep in mind. Call this whenever the user shares something worth remembering long-term.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact to remember, written plainly, e.g. "The user\'s name is Sam."' }
    },
    required: ['fact']
  }
}

let session: Session | null = null
let win: BrowserWindow | null = null
let activeAgentId: string | null = null
let sessionEpoch = 0
/** Set by the switch_agent tool; the actual switch happens once the current turn finishes speaking. */
let pendingSwitchAgentId: string | null | undefined

export function attachWindow(window: BrowserWindow): void {
  win = window
}

function emit(event: VoiceEvent): void {
  win?.webContents.send('voice:event', event)
}

export function isSessionActive(): boolean {
  return session !== null
}

export function getActiveAgentId(): string | null {
  return activeAgentId
}

function agentRegistrySnapshot(): string {
  const agents = agentStore.list().filter((a) => !a.archived)
  if (agents.length === 0) return 'No other agents exist yet.'
  return agents
    .map((a) => {
      const parent = a.parentId ? agentStore.get(a.parentId)?.name : null
      const scope = parent ? `, under ${parent}` : ''
      const purpose = a.systemPrompt.split('.')[0]?.slice(0, 140) ?? ''
      return `- ${a.name} (${a.type}${scope}): ${purpose}`
    })
    .join('\n')
}

async function buildToolsForAgent(agent: AgentConfig | null): Promise<Tool[]> {
  const functionDeclarations: FunctionDeclaration[] = [
    OPEN_URL_TOOL,
    LIST_AGENTS_TOOL,
    SWITCH_AGENT_TOOL,
    REMEMBER_FACT_TOOL
  ]
  if (!agent) functionDeclarations.push(CREATE_AGENT_TOOL)

  const appKeys = agent
    ? agent.toolScope.filter((s) => s.startsWith('composio:')).map((s) => s.slice('composio:'.length))
    : settingsStore
        .getState()
        .composioConnections.filter((c) => c.connected)
        .map((c) => c.appKey)

  if (appKeys.length > 0) {
    try {
      const composioTools = await composio.getToolsForApps(appKeys)
      functionDeclarations.push(...composioTools)
    } catch (err) {
      console.error('[geminiLive] failed to load Composio tools:', err)
    }
  }

  return [{ googleSearch: {} }, { functionDeclarations }]
}

/**
 * Starts a Live session for DALVE (agentId omitted/null) or for a specific companion/bot.
 * Calling this while a session is already active for a DIFFERENT agent switches to it —
 * the old session is closed and a new one opened. Callbacks are epoch-guarded so a stale
 * close/error from a superseded session can't clobber the new one's state.
 */
export async function startVoiceSession(agentId: string | null = null): Promise<void> {
  if (session && activeAgentId === agentId) return

  const apiKey = settingsStore.getGeminiApiKey()
  if (!apiKey) {
    throw new Error('Add your Gemini API key in Settings first.')
  }

  const agent = agentId ? (agentStore.get(agentId) ?? null) : null
  if (agentId && !agent) {
    throw new Error('That agent no longer exists.')
  }

  if (session) {
    const old = session
    session = null
    old.close()
  }

  const myEpoch = ++sessionEpoch
  activeAgentId = agentId
  emit({ type: 'activeAgentChanged', agentId })
  emit({ type: 'state', state: 'connecting' })

  const ai = new GoogleGenAI({ apiKey })
  const memory = settingsStore.getDalveMemory()
  const memoryNote = memory ? `\n\nThings you've saved to remember from earlier conversations:\n${memory}` : ''
  const registryNote = `\n\nAgents currently registered:\n${agentRegistrySnapshot()}`
  const systemPrompt =
    (agent ? agent.systemPrompt : DALVE_SYSTEM_PROMPT) + `\n\n${CHAIN_OF_COMMAND}` + registryNote + memoryNote
  const voiceName = agent ? agent.voice : settingsStore.getDalveVoice()

  function resetAgentStatus(): void {
    if (agent) agentStore.setStatus(agent.id, 'idle')
  }

  try {
    const newSession = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: await buildToolsForAgent(agent)
      },
      callbacks: {
        onopen: () => {
          if (myEpoch !== sessionEpoch) return
          if (agent) agentStore.setStatus(agent.id, 'active')
          emit({ type: 'state', state: 'listening' })
        },
        onmessage: (message: LiveServerMessage) => {
          if (myEpoch !== sessionEpoch) return
          handleMessage(message)
        },
        onerror: (e) => {
          if (myEpoch !== sessionEpoch) return
          console.error('[geminiLive] onerror:', e)
          resetAgentStatus()
          emit({ type: 'error', message: e.message || 'Live session error' })
          emit({ type: 'state', state: 'error' })
          session = null
          activeAgentId = null
        },
        onclose: (e) => {
          if (myEpoch !== sessionEpoch) return
          console.error('[geminiLive] onclose:', { code: e?.code, reason: e?.reason, wasClean: e?.wasClean })
          resetAgentStatus()
          session = null
          activeAgentId = null
          if (e && e.code !== 1000) {
            emit({
              type: 'error',
              message: `Voice session closed unexpectedly (code ${e.code}${e.reason ? `: ${e.reason}` : ''}).`
            })
          }
          emit({ type: 'state', state: 'idle' })
        }
      }
    })

    if (myEpoch !== sessionEpoch) {
      // Superseded by another switch while connecting — discard this one.
      newSession.close()
      return
    }
    session = newSession
  } catch (err) {
    if (myEpoch !== sessionEpoch) return
    resetAgentStatus()
    session = null
    activeAgentId = null
    emit({ type: 'state', state: 'error' })
    throw err
  }
}

function handleMessage(message: LiveServerMessage): void {
  if (message.toolCall?.functionCalls?.length) {
    void handleToolCalls(message.toolCall.functionCalls)
  }

  const content = message.serverContent
  if (!content) return

  if (content.inputTranscription?.text) {
    emit({
      type: 'inputTranscript',
      text: content.inputTranscription.text,
      finished: !!content.inputTranscription.finished
    })
  }

  if (content.outputTranscription?.text) {
    emit({ type: 'state', state: 'speaking' })
    emit({
      type: 'outputTranscript',
      text: content.outputTranscription.text,
      finished: !!content.outputTranscription.finished
    })
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        emit({ type: 'audio', data: part.inlineData.data })
      }
    }
  }

  if (content.interrupted) {
    emit({ type: 'interrupted' })
  }

  if (content.turnComplete) {
    emit({ type: 'turnComplete' })
    emit({ type: 'state', state: 'listening' })

    if (pendingSwitchAgentId !== undefined) {
      const target = pendingSwitchAgentId
      pendingSwitchAgentId = undefined
      void startVoiceSession(target).catch((err) => {
        console.error('[geminiLive] deferred agent switch failed:', err)
        emit({ type: 'error', message: err instanceof Error ? err.message : 'Failed to switch agents.' })
      })
    }
  }
}

async function handleToolCalls(functionCalls: FunctionCall[]): Promise<void> {
  const functionResponses: { id?: string; name?: string; response: Record<string, unknown> }[] = []

  for (const fc of functionCalls) {
    if (!fc.name) continue
    const args = (fc.args ?? {}) as Record<string, unknown>
    let response: Record<string, unknown>

    try {
      if (fc.name === 'open_url') {
        const url = String(args.url ?? '')
        await shell.openExternal(url)
        response = { result: `Opened ${url}` }
      } else if (fc.name === 'create_agent') {
        const type = args.type === 'bot' ? 'bot' : 'companion'
        const agent = agentStore.create({
          name: String(args.name ?? 'New Agent'),
          type,
          parentId: null,
          systemPrompt: String(args.description ?? ''),
          color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]
        })
        response = { result: `Created ${agent.type} "${agent.name}".` }
      } else if (fc.name === 'list_agents') {
        response = { result: agentRegistrySnapshot() }
      } else if (fc.name === 'switch_agent') {
        const targetName = String(args.name ?? '').trim()
        if (!targetName) {
          response = { error: 'No agent name given.' }
        } else if (targetName.toLowerCase() === 'dalve') {
          pendingSwitchAgentId = null
          response = { result: 'Okay — switching back to DALVE once you finish speaking.' }
        } else {
          const target = agentStore
            .list()
            .find((a) => !a.archived && a.name.toLowerCase() === targetName.toLowerCase())
          if (!target) {
            response = { error: `No agent named "${targetName}" found. Use list_agents to check.` }
          } else {
            pendingSwitchAgentId = target.id
            response = { result: `Okay — switching to ${target.name} once you finish speaking.` }
          }
        }
      } else if (fc.name === 'remember_fact') {
        const fact = String(args.fact ?? '').trim()
        if (!fact) {
          response = { error: 'No fact given.' }
        } else if (activeAgentId) {
          const agent = agentStore.get(activeAgentId)
          if (agent) {
            agentStore.update(agent.id, { memory: agent.memory ? `${agent.memory}\n- ${fact}` : `- ${fact}` })
          }
          response = { result: 'Saved.' }
        } else {
          settingsStore.appendDalveMemory(fact)
          response = { result: 'Saved.' }
        }
      } else {
        response = { result: await composio.executeComposioTool(fc.name, args) }
      }
    } catch (err) {
      console.error(`[geminiLive] tool "${fc.name}" failed:`, err)
      response = { error: err instanceof Error ? err.message : String(err) }
    }

    functionResponses.push({ id: fc.id, name: fc.name, response })
  }

  session?.sendToolResponse({ functionResponses })
}

export function sendAudioChunk(base64Pcm16: string): void {
  session?.sendRealtimeInput({ audio: { data: base64Pcm16, mimeType: 'audio/pcm;rate=16000' } })
}

export function sendText(text: string): void {
  session?.sendRealtimeInput({ text })
}

export function stopVoiceSession(): void {
  sessionEpoch++ // invalidate any in-flight connect/callbacks
  if (!session) return
  session.close()
  session = null
  if (activeAgentId) {
    agentStore.setStatus(activeAgentId, 'idle')
    activeAgentId = null
  }
  emit({ type: 'state', state: 'idle' })
}
