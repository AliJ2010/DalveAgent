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

// Windows UI Automation via PowerShell/.NET (System.Windows.Automation) — this is the real
// replacement for coordinate-guessing: it reads the OS's own accessibility tree for whatever
// window is actually frontmost right now, so DALVE gets real element names and positions
// instead of the model guessing pixel coordinates off a screenshot. Written to a temp .ps1 file
// and run with -File rather than -Command, since embedding a multi-line script with quotes and
// braces into a single command-line string is exactly the kind of escaping that broke the
// earlier $pid PowerShell bug — a real file sidesteps that whole class of problem.
//
// Output is base64-per-field, one element per line, NOT ConvertTo-Json — found live that
// PowerShell's ConvertTo-Json genuinely fails to escape some real-world content: a WhatsApp-style
// element whose name itself contained a literal double-quote character came out as broken JSON.
// Base64's alphabet never includes a quote, a pipe, or a newline, so it can never collide with
// the "|" field separator or the newline record separator, regardless of what arbitrary text a
// target app puts in its own UI.
const ENUM_SCRIPT = [
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

function parseLine(line: string): UiElement | null {
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

/**
 * Enumerates every named, currently-rendered element of the frontmost window right now — a
 * fresh live read every call, never a cached/remembered layout. This is what lets DALVE answer
 * "what's actually on screen" with real accessibility data instead of interpreting a screenshot.
 *
 * Chromium/Electron windows (Chrome, and Electron apps that haven't forced accessibility on)
 * build their full accessibility tree lazily — the FIRST query against one right after it gains
 * focus can come back nearly empty, then enrich on a follow-up query moments later once Chromium
 * notices a real UI Automation client is actively watching. Confirmed live: DALVE's own window
 * went from 1 element to a full tree on a second query ~1.5s after the first. Callers that get a
 * suspiciously sparse result back should retry once after a short delay rather than assuming the
 * window has nothing to offer — see findElementsReliable.
 */
export async function findElements(): Promise<UiElement[]> {
  if (process.platform !== 'win32') {
    throw new Error('UI element targeting is only implemented for Windows so far.')
  }
  const stdout = await runPowerShellScript(ENUM_SCRIPT)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseLine)
    .filter((e): e is UiElement => e !== null)
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

export interface LocateResult {
  found: boolean
  element?: UiElement
  centerX?: number
  centerY?: number
  /** Populated only when not found — real names actually present, so DALVE can self-correct
   *  instead of guessing again blindly. */
  candidates?: string[]
}

/**
 * Re-queries the live tree fresh on every call (via findElementsReliable, so a slow-to-activate
 * Chromium/Electron window gets a fair second look) and finds the best name/automation-id match
 * among elements that are actually enabled and on-screen right now. Never reuses a position from
 * an earlier screenshot or an earlier call — the whole point is that the UI can shift between "I
 * saw it" and "I act on it," and a stale coordinate is exactly what caused wrong-target clicks.
 */
export async function locateElement(targetName: string): Promise<LocateResult> {
  const elements = await findElementsReliable()
  const scored = elements
    .filter((e) => e.isEnabled && !e.isOffscreen)
    .map((e) => ({ el: e, score: scoreMatch(targetName, e) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

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
  return {
    found: true,
    element: best,
    centerX: Math.round(best.x + best.width / 2),
    centerY: Math.round(best.y + best.height / 2)
  }
}

export function isSupported(): boolean {
  return process.platform === 'win32'
}
