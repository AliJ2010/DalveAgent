import * as ocr from './ocr'
import * as screenControl from './screenControl'

interface PricePoint {
  price: number
  y: number
}

// Matches typical chart price-scale labels: "29,660.00", "7,723.25", "584.50" — optionally
// comma-grouped, 1-2 decimal places. Deliberately strict (not just "contains digits") since the
// screen has plenty of OTHER numbers (PnL, position size, order quantity) that must NOT get
// mistaken for price-scale ticks.
const PRICE_LABEL_PATTERN = /^-?[\d,]+\.\d{1,2}$/

function parsePriceLabel(text: string): number | null {
  const trimmed = text.trim()
  if (!PRICE_LABEL_PATTERN.test(trimmed)) return null
  const n = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface PriceAxisResult {
  found: boolean
  y?: number
  error?: string
  samples?: number
}

/**
 * Maps a target price to its real on-screen Y pixel by OCR-reading the chart's own right-side
 * price scale and fitting a line through the visible tick labels — the actual fix for "no sense
 * of price at all": previously, clicking/right-clicking at a specific price on a financial chart
 * meant guessing a coordinate blind (confirmed live: a stop order landed at the wrong price this
 * way). Assumes a linear (non-log) price axis, which is the default chart mode.
 */
export async function locatePriceY(targetPrice: number): Promise<PriceAxisResult> {
  const lines = await ocr.readScreenText()
  if (lines.length === 0) return { found: false, error: 'Could not read anything off the screen.' }

  const frame = screenControl.getFrameSize()
  // Price-scale labels live in a narrow column at the very right edge of the chart — restricting
  // to it is what keeps this from picking up unrelated numbers (PnL, quantity, order price boxes)
  // that also match the numeric pattern elsewhere on screen.
  const rightEdgeThreshold = frame.width * 0.85

  const points: PricePoint[] = []
  for (const line of lines) {
    if (line.x < rightEdgeThreshold) continue
    const price = parsePriceLabel(line.text)
    if (price === null) continue
    points.push({ price, y: line.y + line.height / 2 })
  }

  if (points.length < 2) {
    return {
      found: false,
      error: `Only found ${points.length} price label(s) on the right-edge price scale — need at least 2 to calibrate. Make sure the chart's price scale is visible on screen.`,
      samples: points.length
    }
  }

  // Least-squares linear fit: y = m*price + b — using every visible label (not just 2) averages
  // out any single OCR misread instead of being fully at its mercy.
  const n = points.length
  const sumPrice = points.reduce((s, p) => s + p.price, 0)
  const sumY = points.reduce((s, p) => s + p.y, 0)
  const sumPriceY = points.reduce((s, p) => s + p.price * p.y, 0)
  const sumPriceSq = points.reduce((s, p) => s + p.price * p.price, 0)
  const denom = n * sumPriceSq - sumPrice * sumPrice
  if (denom === 0) {
    return { found: false, error: 'The price labels found were all identical — cannot calibrate a scale from them.', samples: n }
  }
  const m = (n * sumPriceY - sumPrice * sumY) / denom
  const b = (sumY - m * sumPrice) / n

  return { found: true, y: Math.round(m * targetPrice + b), samples: n }
}
