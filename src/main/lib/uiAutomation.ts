import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)

export interface UiElement {
  name: string
  controlType: string
  automationId: string
  className: string
  x: number
  y: number
  width: number
  height: number
  isEnabled: boolean
  isOffscreen: boolean
}

// --- Windows: PowerShell + .NET UI Automation (System.Windows.Automation) ---
// Reads the OS's own accessibility tree for whatever window is actually frontmost right now.
// Written to a temp .ps1 file and run with -File rather than -Command, since embedding a
// multi-line script with quotes and braces into a single command-line string is exactly the kind
// of escaping that broke the earlier $pid PowerShell bug — a real file sidesteps that class of
// problem. Verified live, multiple rounds, against real complex apps (Chrome, DALVE itself).
//
// Output is base64-per-field, one element per line, NOT ConvertTo-Json — found live that
// PowerShell's ConvertTo-Json genuinely fails to escape some real-world content: an element name
// containing a literal double-quote (a real WhatsApp-style status text) produced structurally
// invalid JSON. Base64's alphabet never includes a quote, a pipe, or a newline, so it can never
// collide with the "|" field separator or the newline record separator, regardless of what
// arbitrary text a target app puts in its own UI.
const WIN_ENUM_SCRIPT = [
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class DalveW {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '}',
  '"@',
  '',
  'function B64($s) {',
  '  if ($null -eq $s) { $s = "" }',
  '  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$s))',
  '}',
  '',
  '$hwnd = [DalveW]::GetForegroundWindow()',
  '$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
  '$condition = [System.Windows.Automation.Condition]::TrueCondition',
  '$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)',
  '',
  '$lines = @()',
  'foreach ($el in $all) {',
  '  try {',
  '    $c = $el.Current',
  '    if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }',
  '    $rect = $c.BoundingRectangle',
  '    if ($rect.IsEmpty) { continue }',
  '    $fields = @(',
  '      (B64 $c.Name),',
  '      (B64 $c.ControlType.ProgrammaticName),',
  '      (B64 $c.AutomationId),',
  '      (B64 $c.ClassName),',
  '      [math]::Round($rect.X),',
  '      [math]::Round($rect.Y),',
  '      [math]::Round($rect.Width),',
  '      [math]::Round($rect.Height),',
  '      [int]$c.IsEnabled,',
  '      [int]$c.IsOffscreen',
  '    )',
  '    $lines += ($fields -join "|")',
  '  } catch {}',
  '}',
  'Write-Output ($lines -join "`n")'
].join('\n')

async function runPowerShellScript(script: string, timeoutMs = 15000): Promise<string> {
  const scriptPath = join(tmpdir(), `dalve-uia-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`)
  writeFileSync(scriptPath, script, 'utf-8')
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }
    )
    return stdout
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      // best-effort cleanup only
    }
  }
}

function b64decode(s: string): string {
  if (!s) return ''
  return Buffer.from(s, 'base64').toString('utf-8')
}

function parseWinLine(line: string): UiElement | null {
  const parts = line.split('|')
  if (parts.length < 10) return null
  const [nameB64, controlTypeB64, autoIdB64, classNameB64, x, y, w, h, enabled, offscreen] = parts
  return {
    name: b64decode(nameB64),
    controlType: b64decode(controlTypeB64).replace('ControlType.', ''),
    automationId: b64decode(autoIdB64),
    className: b64decode(classNameB64),
    x: Number(x) || 0,
    y: Number(y) || 0,
    width: Number(w) || 0,
    height: Number(h) || 0,
    isEnabled: enabled === '1',
    isOffscreen: offscreen === '1'
  }
}

async function findElementsWindows(): Promise<UiElement[]> {
  const stdout = await runPowerShellScript(WIN_ENUM_SCRIPT)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseWinLine)
    .filter((e): e is UiElement => e !== null)
}

// --- macOS: JXA (JavaScript for Automation) + System Events UI scripting ---
// UNVERIFIED — written with no way to run or test it (no Mac access at all). Uses the same
// architecture and output contract as the Windows path (same UiElement shape, same scoring/
// locate logic below) so fixing it once real Mac testing surfaces bugs should be a small, local
// change rather than a redesign. Requires the user to grant DALVE Accessibility permission
// (System Settings -> Privacy & Security -> Accessibility) — System Events UI scripting simply
// returns nothing/errors without it, which is a real macOS permission gate, not a bug.
const MAC_ENUM_SCRIPT = `
function run() {
  var se = Application('System Events')
  var results = []
  var MAX_DEPTH = 20
  var MAX_ELEMENTS = 500

  function safeGet(fn, fallback) {
    try { return fn() } catch (e) { return fallback }
  }

  function walk(el, depth) {
    if (results.length >= MAX_ELEMENTS || depth > MAX_DEPTH) return
    var name = safeGet(function () { return el.name() }, '') ||
               safeGet(function () { return el.title() }, '') ||
               safeGet(function () { return el.value() }, '')
    var role = safeGet(function () { return el.role() }, '')
    var pos = safeGet(function () { return el.position() }, null)
    var size = safeGet(function () { return el.size() }, null)
    var enabled = safeGet(function () { return el.enabled() }, true)
    if (name && String(name).length > 0 && pos && size) {
      results.push({
        name: String(name),
        role: String(role),
        x: Math.round(pos[0]),
        y: Math.round(pos[1]),
        width: Math.round(size[0]),
        height: Math.round(size[1]),
        enabled: !!enabled
      })
    }
    var children = safeGet(function () { return el.uiElements() }, [])
    for (var i = 0; i < children.length && results.length < MAX_ELEMENTS; i++) {
      walk(children[i], depth + 1)
    }
  }

  var proc = safeGet(function () { return se.processes.whose({ frontmost: true })[0] }, null)
  if (!proc) return JSON.stringify([])

  var windows = safeGet(function () { return proc.windows() }, [])
  for (var w = 0; w < windows.length; w++) walk(windows[w], 0)

  return JSON.stringify(results)
}
`.trim()

async function runJxaScript(script: string, timeoutMs = 15000): Promise<string> {
  const scriptPath = join(tmpdir(), `dalve-uia-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`)
  writeFileSync(scriptPath, script, 'utf-8')
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    })
    return stdout
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      // best-effort cleanup only
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMacElement(e: any): UiElement {
  return {
    name: String(e.name ?? ''),
    controlType: String(e.role ?? ''),
    automationId: '',
    className: String(e.role ?? ''),
    x: Number(e.x) || 0,
    y: Number(e.y) || 0,
    width: Number(e.width) || 0,
    height: Number(e.height) || 0,
    isEnabled: e.enabled !== false,
    isOffscreen: false
  }
}

async function findElementsMac(): Promise<UiElement[]> {
  const stdout = await runJxaScript(MAC_ENUM_SCRIPT)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  const arr = Array.isArray(parsed) ? parsed : []
  return arr.map(normalizeMacElement)
}

/**
 * Enumerates every named, currently-rendered element of the frontmost window right now — a
 * fresh live read every call, never a cached/remembered layout. This is what lets DALVE answer
 * "what's actually on screen" with real accessibility data instead of interpreting a screenshot.
 *
 * Chromium/Electron windows (Chrome, and Electron apps that haven't forced accessibility on)
 * build their full accessibility tree lazily — the FIRST query against one right after it gains
 * focus can come back nearly empty, then enrich on a follow-up query moments later once Chromium
 * notices a real UI Automation client is actively watching. Confirmed live on Windows: DALVE's
 * own window went from 1 element to a full tree on a second query ~1.5s after the first. Callers
 * that get a suspiciously sparse result back should retry once after a short delay rather than
 * assuming the window has nothing to offer — see findElementsReliable.
 */
export async function findElements(): Promise<UiElement[]> {
  if (process.platform === 'win32') return findElementsWindows()
  if (process.platform === 'darwin') return findElementsMac()
  throw new Error(`UI element targeting isn't implemented for ${process.platform}.`)
}

/**
 * Same as findElements, but retries once after a short delay if the first pass comes back
 * suspiciously sparse (Chromium/Electron windows can need a moment to fully activate their
 * accessibility tree once something starts querying them — see findElements' doc comment).
 * This is the version tool handlers should actually call.
 */
export async function findElementsReliable(): Promise<UiElement[]> {
  const first = await findElements()
  if (first.length > 3) return first
  await new Promise((r) => setTimeout(r, 1200))
  const second = await findElements()
  return second.length >= first.length ? second : first
}

function scoreMatch(target: string, el: UiElement): number {
  const t = target.toLowerCase().trim()
  const name = el.name.toLowerCase()
  const autoId = el.automationId.toLowerCase()
  if (name === t || autoId === t) return 100
  if (name.startsWith(t) || autoId.startsWith(t)) return 80
  if (name.includes(t) || autoId.includes(t)) return 60
  return 0
}

// Chromium's own browser-frame UI (tabs, toolbar, the signed-in-account button) sits in the SAME
// accessibility tree as the actual webpage content, and gets enumerated first in traversal order
// — found live: asked to click a WhatsApp Web chat named "Ali," it instead clicked Chrome's own
// account/profile button, which is ALSO literally named "Ali" (the signed-in Google account's own
// name), and with no tiebreak at all the first-found exact match won outright regardless of which
// one a person actually meant. These are real, verified-live Chromium internal accessibility
// class names for exactly that kind of native chrome, not guesses — deprioritizing them means a
// same- or lower-scored piece of real page content still wins over the browser's own furniture,
// which is what a person almost always means when they say "click X."
const BROWSER_CHROME_CLASS_PATTERN =
  /toolbar|omnibox|tabstrip|^tab$|tabclosebutton|browserappmenu|windowscaptionbutton|backforwardbutton|reloadbutton|locationiconview|pageactionview|bookmark/i

function isBrowserChromeElement(el: UiElement): boolean {
  return BROWSER_CHROME_CLASS_PATTERN.test(el.className)
}

export interface LocateResult {
  found: boolean
  element?: UiElement
  centerX?: number
  centerY?: number
  /** Populated only when not found — real names actually present, so DALVE can self-correct
   *  instead of guessing again blindly. */
  candidates?: string[]
  /** How many OTHER elements also matched as well as the one picked — a real ambiguity signal.
   *  Found live: a generic query like "Play" can match both a small nav icon and a large CTA
   *  button; without this, ties always silently favored whichever was found first (nav items,
   *  since they're earlier in reading order), which is exactly why "click the button at the
   *  bottom" kept hitting the one at the top instead. */
  ambiguousMatchCount?: number
}

/**
 * Re-queries the live tree fresh on every call (via findElementsReliable, so a slow-to-activate
 * Chromium/Electron window gets a fair second look) and finds the best name/automation-id match
 * among elements that are actually enabled and on-screen right now. Never reuses a position from
 * an earlier screenshot or an earlier call — the whole point is that the UI can shift between "I
 * saw it" and "I act on it," and a stale coordinate is exactly what caused wrong-target clicks.
 *
 * Ties in name-match score are broken by size (largest wins) — a real, generically-useful signal
 * since a small icon-only nav link and a large call-to-action button often carry the same or a
 * substring-overlapping label, and "the big button" is a common enough way people actually refer
 * to the one they mean.
 */
export async function locateElement(targetName: string): Promise<LocateResult> {
  const elements = await findElementsReliable()
  const scored = elements
    .filter((e) => e.isEnabled && !e.isOffscreen)
    .map((e) => ({ el: e, score: scoreMatch(targetName, e), area: e.width * e.height, isChrome: isBrowserChromeElement(e) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.isChrome !== b.isChrome) return a.isChrome ? 1 : -1
      return b.area - a.area
    })

  if (scored.length === 0) {
    return {
      found: false,
      candidates: elements
        .filter((e) => e.name)
        .map((e) => e.name)
        .slice(0, 30)
    }
  }

  const best = scored[0].el
  const topScore = scored[0].score
  const tieCount = scored.filter((s) => s.score === topScore).length - 1

  return {
    found: true,
    element: best,
    centerX: Math.round(best.x + best.width / 2),
    centerY: Math.round(best.y + best.height / 2),
    ambiguousMatchCount: tieCount > 0 ? tieCount : undefined
  }
}

export function isSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}
