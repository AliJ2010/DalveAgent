import { createWorker, type Worker } from 'tesseract.js'
import * as screenControl from './screenControl'

export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  confidence: number
}

// tesseract.js's WASM worker takes ~1-1.5s to spin up — reused across calls instead of created
// fresh each time (matches the same lazy-singleton pattern as robotjs in screenControl.ts).
let workerPromise: Promise<Worker> | null = null
function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = createWorker('eng')
  return workerPromise
}

// UI text (small, anti-aliased, mixed fonts/icons) reads noisier than the print/document text
// OCR engines are normally tuned for — verified live against a real desktop screenshot: correctly
// recognized lines scored anywhere from ~40 to ~90 confidence, so a strict floor throws away real
// hits along with genuine noise.
const MIN_CONFIDENCE = 40

/**
 * OCRs the current primary-monitor screenshot and returns recognized lines of text with their
 * real on-screen position (same pixel coordinate space move_mouse/click_mouse already use, since
 * it's read from the identical captured frame). This is what lets DALVE act on text that has NO
 * accessibility name at all — canvas-rendered UI, video subtitles, images containing text, or any
 * app that doesn't expose a UI Automation tree.
 */
export async function readScreenText(): Promise<OcrLine[]> {
  const base64Jpeg = await screenControl.captureScreenshotOnce(95)
  if (!base64Jpeg) return []
  const worker = await getWorker()
  const { data } = await worker.recognize(Buffer.from(base64Jpeg, 'base64'))
  return (data.lines ?? [])
    .map((l) => ({
      text: l.text.trim(),
      x: l.bbox.x0,
      y: l.bbox.y0,
      width: l.bbox.x1 - l.bbox.x0,
      height: l.bbox.y1 - l.bbox.y0,
      confidence: l.confidence
    }))
    .filter((l) => l.text && l.confidence >= MIN_CONFIDENCE)
}

function scoreMatch(query: string, text: string): number {
  if (text === query) return 100
  if (text.includes(query)) return 80
  // Word-overlap fallback tolerates OCR noise (a misread character, missing punctuation) rather
  // than requiring an exact substring match, which real OCR output rarely gives you cleanly.
  const queryWords = query.split(/\s+/).filter(Boolean)
  if (queryWords.length === 0) return 0
  const matched = queryWords.filter((w) => text.includes(w))
  if (matched.length === queryWords.length) return 60
  return matched.length > 0 ? 30 * (matched.length / queryWords.length) : 0
}

export interface LocateTextResult {
  found: boolean
  line?: OcrLine
  centerX?: number
  centerY?: number
  /** Populated only when not found — real text actually read off the screen, so DALVE can
   *  retry with a corrected query instead of guessing again blindly. */
  candidates?: string[]
  /** How many OTHER lines also matched as well as the one picked — see the matching field in
   *  uiAutomation.ts's LocateResult for why this matters: ties used to silently favor whichever
   *  line OCR happened to read first (top of screen), even when the user meant a different,
   *  differently-sized occurrence of the same word further down. */
  ambiguousMatchCount?: number
}

/**
 * Fresh OCR pass every call — same "never reuse a stale position" discipline as UI element
 * targeting (uiAutomation.ts), since screen content can change between when text was read and
 * when it's acted on. Ties in text-match score are broken by size (largest wins), same reasoning
 * as the accessibility-tree path: a big, prominent piece of text is a reasonable proxy for "the
 * big one" when a person describes a target that way.
 */
export async function locateText(query: string): Promise<LocateTextResult> {
  const lines = await readScreenText()
  const q = query.toLowerCase().trim()
  const scored = lines
    .map((l) => ({ line: l, score: scoreMatch(q, l.text.toLowerCase()), area: l.width * l.height }))
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.area - a.area))

  if (scored.length === 0) {
    return { found: false, candidates: lines.map((l) => l.text).slice(0, 30) }
  }

  const best = scored[0].line
  const topScore = scored[0].score
  const tieCount = scored.filter((s) => s.score === topScore).length - 1

  return {
    found: true,
    line: best,
    centerX: Math.round(best.x + best.width / 2),
    centerY: Math.round(best.y + best.height / 2),
    ambiguousMatchCount: tieCount > 0 ? tieCount : undefined
  }
}
