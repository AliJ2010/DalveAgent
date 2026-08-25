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
const ENUM_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DalveW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$hwnd = [DalveW]::GetForegroundWindow()
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$condition = [System.Windows.Automation.Condition]::TrueCondition
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

$results = @()
foreach ($el in $all) {
  try {
    $c = $el.Current
    if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }
    $rect = $c.BoundingRectangle
    if ($rect.IsEmpty) { continue }
    $results += [PSCustomObject]@{
      name = $c.Name
      controlType = $c.ControlType.ProgrammaticName
      automationId = $c.AutomationId
      className = $c.ClassName
      x = [math]::Round($rect.X)
      y = [math]::Round($rect.Y)
      width = [math]::Round($rect.Width)
      height = [math]::Round($rect.Height)
      isEnabled = $c.IsEnabled
      isOffscreen = $c.IsOffscreen
    }
  } catch {}
}
$results | ConvertTo-Json -Compress -Depth 3
`.trim()

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeElement(e: any): UiElement {
  return {
    name: e.name ?? '',
    controlType: String(e.controlType ?? '').replace('ControlType.', ''),
    automationId: e.automationId ?? '',
    className: e.className ?? '',
    x: e.x ?? 0,
    y: e.y ?? 0,
    width: e.width ?? 0,
    height: e.height ?? 0,
    isEnabled: !!e.isEnabled,
    isOffscreen: !!e.isOffscreen
  }
}

/**
 * Enumerates every named, currently-rendered element of the frontmost window right now — a
 * fresh live read every call, never a cached/remembered layout. This is what lets DALVE answer
 * "what's actually on screen" with real accessibility data instead of interpreting a screenshot.
 */
export async function findElements(): Promise<UiElement[]> {
  if (process.platform !== 'win32') {
    throw new Error('UI element targeting is only implemented for Windows so far.')
  }
  const stdout = await runPowerShellScript(ENUM_SCRIPT)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map(normalizeElement)
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
 * Re-queries the live tree fresh on every call and finds the best name/automation-id match among
 * elements that are actually enabled and on-screen right now. Never reuses a position from an
 * earlier screenshot or an earlier call — the whole point is that the UI can shift between "I
 * saw it" and "I act on it," and a stale coordinate is exactly what caused wrong-target clicks.
 */
export async function locateElement(targetName: string): Promise<LocateResult> {
  const elements = await findElements()
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
