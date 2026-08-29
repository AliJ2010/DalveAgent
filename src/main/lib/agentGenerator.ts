import type { AgentConfig } from '@shared/types'

// Placeholder heuristic generator used until the Gemini-backed orchestrator phase lands.
// Swapping this out for a real Gemini call later doesn't require any renderer/IPC changes —
// callers only see { name, color, systemPrompt, type }.

const PALETTE = ['#d4af37', '#c9a227', '#e0b84a', '#f2d06b', '#b8860b', '#eecb6f', '#a9812c']

function titleCase(words: string): string {
  return words
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => {
      // An already-all-caps word (CS, DAA, AI) is almost certainly an intentional acronym, not
      // something to normalize — forcing it lowercase silently destroyed exactly that on every
      // name containing one (a real reported bug: "Life CS" became "Life Cs").
      if (w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase()) return w
      return w[0].toUpperCase() + w.slice(1).toLowerCase()
    })
    .join(' ')
}

export function generateAgentFromPrompt(
  prompt: string,
  parentId: string | null
): Pick<AgentConfig, 'name' | 'color' | 'systemPrompt' | 'type' | 'parentId'> {
  const trimmed = prompt.trim()
  const nameGuessMatch = trimmed.match(/(?:for|called|named)\s+([a-zA-Z][a-zA-Z\s]{2,24})/i)
  const name = nameGuessMatch ? titleCase(nameGuessMatch[1]) : titleCase(trimmed) || 'New Agent'
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]
  const type: AgentConfig['type'] = parentId ? 'bot' : 'companion'
  const systemPrompt = `You are ${name}, a ${type === 'companion' ? 'companion' : 'helper bot'} spun up to handle: "${trimmed}". Be precise, only take actions you're clearly authorized for, and report results back plainly.`
  return { name, color, systemPrompt, type, parentId }
}
