import { app, clipboard, nativeImage } from 'electron'
import { readdir, readFile, writeFile, stat, rename } from 'fs/promises'
import { join, extname, basename } from 'path'

/**
 * Real local file/clipboard/document access — DALVE previously could only ever SEE the screen
 * (screenshots, OCR), never touch a file directly. Given DALVE already has standing, ungated
 * control of the mouse/keyboard/browser once a session starts, file access sits at the same trust
 * level, not a bigger one — the one exception is delete, which goes to the OS Recycle Bin (via the
 * `trash` package) rather than a permanent unlink, so a wrong delete is still recoverable.
 */

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml', '.ini',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb',
  '.php', '.sh', '.ps1', '.html', '.css', '.sql'
])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const MAX_TEXT_CHARS = 20000
const MAX_SEARCH_RESULTS = 50
const MAX_SEARCH_ENTRIES_SCANNED = 8000
const MAX_SEARCH_DEPTH = 8

export function listCommonFolders(): Record<string, string> {
  return {
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures')
  }
}

export async function listDirectory(dirPath: string): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const lines = entries
      .slice(0, 500)
      .map((e) => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`)
      .join('\n')
    return { status: 'SUCCESS', result: lines || '(empty directory)' }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function readTextFile(filePath: string): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const truncated = content.length > MAX_TEXT_CHARS
    return {
      status: 'SUCCESS',
      result: truncated ? `${content.slice(0, MAX_TEXT_CHARS)}\n\n[...truncated, ${content.length} chars total]` : content
    }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function writeTextFile(
  filePath: string,
  content: string,
  append: boolean
): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  try {
    if (append) {
      const existing = await readFile(filePath, 'utf-8').catch(() => '')
      await writeFile(filePath, existing + content, 'utf-8')
    } else {
      await writeFile(filePath, content, 'utf-8')
    }
    return { status: 'SUCCESS', result: `Wrote ${filePath}` }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Moves to the OS Recycle Bin/Trash, not a permanent unlink — a wrong delete is still
 *  recoverable by the user afterward, the same safety margin a human dragging a file to the
 *  trash gets. */
export async function deleteFile(filePath: string): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  try {
    const { default: trash } = await import('trash')
    await trash(filePath)
    return { status: 'SUCCESS', result: `Moved to Recycle Bin: ${filePath}` }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function moveFile(fromPath: string, toPath: string): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  try {
    await rename(fromPath, toPath)
    return { status: 'SUCCESS', result: `Moved ${fromPath} -> ${toPath}` }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function searchFiles(
  rootPath: string,
  query: string
): Promise<{ status: 'SUCCESS' | 'FAILED'; result?: string; error?: string }> {
  const needle = query.trim().toLowerCase()
  if (!needle) return { status: 'FAILED', error: 'No search text given.' }
  const matches: string[] = []
  let scanned = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SEARCH_DEPTH || matches.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_ENTRIES_SCANNED) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_ENTRIES_SCANNED) return
      scanned++
      const full = join(dir, entry.name)
      if (entry.name.toLowerCase().includes(needle)) matches.push(full)
      if (entry.isDirectory()) await walk(full, depth + 1)
    }
  }

  try {
    await walk(rootPath, 0)
    if (matches.length === 0) return { status: 'SUCCESS', result: `No files matching "${query}" found under ${rootPath}.` }
    const note = scanned >= MAX_SEARCH_ENTRIES_SCANNED ? `\n(stopped after scanning ${scanned} entries — search a narrower folder for a fuller result)` : ''
    return { status: 'SUCCESS', result: matches.join('\n') + note }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

export function readClipboardText(): string {
  return clipboard.readText()
}

export function writeClipboardText(text: string): void {
  clipboard.writeText(text)
}

export interface DocumentReadResult {
  status: 'SUCCESS' | 'FAILED'
  text?: string
  /** Set only for an image file — callers attach this as vision content on the NEXT model call
   *  rather than treating it as text, the same way a screenshot already is. */
  imageBase64?: string
  mimeType?: string
  error?: string
}

/** Smart dispatch by extension — plain text/code/markdown/csv/json reads directly, PDFs get real
 *  text extraction (pdf-parse), images come back as base64 for the caller to attach as vision
 *  content. .docx and other office formats aren't supported yet — said plainly rather than
 *  silently returning garbage or a confusing low-level error. */
export async function readDocument(filePath: string): Promise<DocumentReadResult> {
  const ext = extname(filePath).toLowerCase()
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      const content = await readFile(filePath, 'utf-8')
      const truncated = content.length > MAX_TEXT_CHARS
      return { status: 'SUCCESS', text: truncated ? `${content.slice(0, MAX_TEXT_CHARS)}\n\n[...truncated]` : content }
    }
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse')
      const buffer = await readFile(filePath)
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      const text = result.text ?? ''
      const truncated = text.length > MAX_TEXT_CHARS
      return { status: 'SUCCESS', text: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[...truncated]` : text }
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      const image = nativeImage.createFromPath(filePath)
      if (image.isEmpty()) return { status: 'FAILED', error: `Couldn't read "${basename(filePath)}" as an image.` }
      return { status: 'SUCCESS', imageBase64: image.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' }
    }
    const info = await stat(filePath).catch(() => null)
    if (!info) return { status: 'FAILED', error: `"${filePath}" doesn't exist.` }
    return {
      status: 'FAILED',
      error: `"${ext || 'this file type'}" isn't supported yet — DALVE can read plain text/code/markdown/csv/json, PDFs, and images (.png/.jpg/etc), but not this format (e.g. .docx isn't supported).`
    }
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}
