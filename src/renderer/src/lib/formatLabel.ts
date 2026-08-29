// Tool-call names arrive as raw snake_case identifiers (e.g. "browser_click") since that's the
// literal function name the model invoked — real, not synthesized, per emitActionLog's own
// comment, but not fit for display as-is. This only reformats presentation; the raw label is
// still what's stored/matched everywhere else.
const ACRONYMS = new Set(['url', 'mcp', 'ai', 'id', 'ui', 'os', 'api'])

export function formatActionLabel(raw: string): string {
  return raw.replace(/[a-zA-Z0-9]+/g, (word) => {
    const lower = word.toLowerCase()
    if (ACRONYMS.has(lower)) return lower.toUpperCase()
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }).replace(/_/g, ' ')
}
