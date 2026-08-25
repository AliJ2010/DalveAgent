/**
 * For grid-based UIs with zero accessibility data and no OCR-readable content — chess/checkers
 * boards, sudoku, spreadsheets-as-images, calendar grids, minesweeper, anything laid out as
 * uniform rows/columns. Confirmed live against chess.com: neither the board container nor any
 * individual piece exists in the Windows UI Automation tree at all (custom web components with
 * no ARIA role get pruned by Chromium's accessibility bridge), and pieces are graphics, not
 * text, so OCR can't see them either. There is genuinely no semantic data available for this
 * class of content — coordinates are unavoidable.
 *
 * What this replaces: the model freehand-guessing a fresh pixel position for every single small
 * cell, every single move — exactly the repeated mis-click pattern reported live ("it keeps
 * misclicking, going out of the chess board"). Instead, the model identifies the grid's OUTER
 * boundary once (a large, forgiving target — much easier to eyeball correctly than a single
 * 66px square), and every individual cell click after that is exact math from that boundary, not
 * a fresh guess.
 */

export interface GridDefinition {
  x: number
  y: number
  width: number
  height: number
  rows: number
  cols: number
}

const grids = new Map<string, GridDefinition>()

export function defineGrid(label: string, def: GridDefinition): void {
  grids.set(label, def)
}

export function clearGrids(): void {
  grids.clear()
}

export function listGrids(): string[] {
  return Array.from(grids.keys())
}

export interface CellResult {
  found: boolean
  centerX?: number
  centerY?: number
  error?: string
}

export function cellCenter(label: string, row: number, col: number): CellResult {
  const g = grids.get(label)
  if (!g) {
    return {
      found: false,
      error: `No grid named "${label}" has been defined yet. Call define_grid first with the grid's outer boundary as you see it.`
    }
  }
  if (row < 0 || row >= g.rows || col < 0 || col >= g.cols) {
    return { found: false, error: `row/col out of range — this grid is ${g.rows} rows by ${g.cols} cols (0-indexed).` }
  }
  const cellW = g.width / g.cols
  const cellH = g.height / g.rows
  return {
    found: true,
    centerX: Math.round(g.x + (col + 0.5) * cellW),
    centerY: Math.round(g.y + (row + 0.5) * cellH)
  }
}
