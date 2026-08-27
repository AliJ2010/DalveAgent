import { screen } from 'electron'
import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/**
 * Launches an app via Windows' own Start Menu search — confirmed live that TradingView has no
 * resolvable name for Start-Process (appControl's normal open path), throwing a real "Windows
 * cannot find 'TradingView'" dialog the user has to manually dismiss. This is the same mechanism
 * that already works when the user manually tells DALVE to "search TradingView and open it" —
 * Windows Search resolves apps (including packaged/MSIX-style installs with no clean launchable
 * exe name) that Start-Process can't.
 */
async function launchViaWindowsSearch(query: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const robot = require('robotjs')
  robot.keyTap('command')
  await new Promise((r) => setTimeout(r, 500))
  robot.typeString(query)
  await new Promise((r) => setTimeout(r, 1200))
  robot.keyTap('enter')
  await new Promise((r) => setTimeout(r, 1500))
}

/**
 * Named multi-window layouts ("dalve open trading setup") — real Win32 window positioning, not
 * just launching apps and hoping they land where wanted. Windows-only for now (SetWindowPos is a
 * Win32 API); the user's whole setup lives on Windows.
 */

interface Region {
  x: number
  y: number
  width: number
  height: number
}

async function runPowerShellScript(script: string, timeoutMs = 15000): Promise<string> {
  const scriptPath = join(tmpdir(), `dalve-layout-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`)
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

/**
 * Moves + resizes a real top-level window to an exact screen region via user32.dll's
 * SetWindowPos, matched by real window enumeration (EnumWindows) rather than
 * `Get-Process -> MainWindowHandle` — confirmed live that .NET's Process.MainWindowHandle
 * exposes only ONE handle per process even when a process genuinely owns several top-level
 * windows (five separate Chrome windows all showed as a single "MainWindowHandle" on one
 * process), which would have silently matched the wrong window or missed it entirely for
 * exactly the multi-Chrome-window case this feature needs (Discord and Tradovate are both
 * plain Chrome windows sharing one process). EnumWindows + GetWindowThreadProcessId sees every
 * real top-level window, so title matching actually discriminates correctly between them.
 * Matched by title substring, or by owning process name via a Get-Process cross-reference.
 * Un-maximizes first (ShowWindow SW_RESTORE) since a maximized/snapped window ignores
 * SetWindowPos otherwise. Retries because a just-launched window/process may not exist yet.
 */
async function snapWindow(
  matcher: { processName?: string; titleContains?: string },
  region: Region,
  attempts = 10
): Promise<boolean> {
  const condition = matcher.processName
    ? `(Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName -like "*${matcher.processName.replace(/"/g, '')}*"`
    : `$title -like "*${(matcher.titleContains ?? '').replace(/"/g, '')}*"`

  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DalveWin32Snap {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$found = [IntPtr]::Zero
$callback = {
  param($hWnd, $lParam)
  if ([DalveWin32Snap]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [DalveWin32Snap]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title.Length -gt 0) {
      [uint32]$procId = 0
      [void][DalveWin32Snap]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      if (${condition}) {
        $script:found = $hWnd
        return $false
      }
    }
  }
  return $true
}
[DalveWin32Snap]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { Write-Output "NOTFOUND"; exit }
[DalveWin32Snap]::ShowWindow($found, 9) | Out-Null
Start-Sleep -Milliseconds 150
[DalveWin32Snap]::SetWindowPos($found, [IntPtr]::Zero, ${Math.round(region.x)}, ${Math.round(region.y)}, ${Math.round(region.width)}, ${Math.round(region.height)}, 0x0040) | Out-Null
Write-Output "OK"
  `.trim()

  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runPowerShellScript(script).catch(() => 'ERROR')
    if (result.includes('OK')) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Opens a URL in a genuinely NEW, separate Chrome window (not a tab in an existing one) so it
 *  can be independently positioned. Relies on Chrome being registered in Windows' App Paths
 *  registry, which a normal Chrome install always does — works even without chrome.exe on PATH. */
async function openInNewChromeWindow(url: string): Promise<void> {
  await execAsync(`start chrome --new-window "${url.replace(/"/g, '')}"`)
}

function pickMonitors(): { main: Region; secondary: Region } {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const others = displays.filter((d) => d.id !== primary.id)
  // Prefer a portrait-orientation display for "secondary" (matches the user's actual setup: a
  // vertical 2nd monitor) — falls back to just the next available display if none is portrait.
  const secondary =
    others.find((d) => d.bounds.height > d.bounds.width) ?? others[0] ?? primary
  return { main: primary.bounds, secondary: secondary.bounds }
}

export interface LayoutResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  message: string
}

/**
 * "dalve open trading setup": TradingView maximized on the main monitor, Discord (top half) and
 * Tradovate (bottom half) as separate snapped windows on the secondary (vertical) monitor.
 */
export async function openTradingSetup(): Promise<LayoutResult> {
  if (process.platform !== 'win32') {
    return { status: 'FAILED', message: 'Window layouts are only implemented on Windows right now.' }
  }

  const { main, secondary } = pickMonitors()
  const topHalf: Region = { x: secondary.x, y: secondary.y, width: secondary.width, height: Math.round(secondary.height / 2) }
  const bottomHalf: Region = {
    x: secondary.x,
    y: secondary.y + Math.round(secondary.height / 2),
    width: secondary.width,
    height: secondary.height - Math.round(secondary.height / 2)
  }

  const steps: { name: string; ok: boolean }[] = []

  // Best-effort launch attempt — deliberately not gating the snap on its result. If TradingView
  // is already running, this just refocuses it via the search box (harmless); if not, this is
  // what actually opens it. Matching by title (not process name — confirmed live it isn't a
  // normal Start-Process-resolvable exe) works either way as long as the window ends up existing.
  await launchViaWindowsSearch('trading view').catch(() => undefined)
  const tvSnapped = await snapWindow({ titleContains: 'TradingView' }, main)
  steps.push({ name: 'TradingView', ok: tvSnapped })

  await openInNewChromeWindow('https://discord.com/app').catch(() => undefined)
  const discordSnapped = await snapWindow({ titleContains: 'Discord' }, topHalf)
  steps.push({ name: 'Discord', ok: discordSnapped })

  await openInNewChromeWindow('https://trader.tradovate.com').catch(() => undefined)
  const tradovateSnapped = await snapWindow({ titleContains: 'Tradovate' }, bottomHalf)
  steps.push({ name: 'Tradovate', ok: tradovateSnapped })

  const failed = steps.filter((s) => !s.ok).map((s) => s.name)
  if (failed.length === 0) {
    return { status: 'SUCCESS', message: 'Trading setup is up: TradingView on the main monitor, Discord and Tradovate snapped top/bottom on the second monitor.' }
  }
  if (failed.length === steps.length) {
    return { status: 'FAILED', message: `Couldn't position any of the windows (${failed.join(', ')}). They may not have opened, or their window titles/process names didn't match what I searched for.` }
  }
  return { status: 'PARTIAL', message: `Positioned ${steps.length - failed.length}/${steps.length}. Couldn't confirm: ${failed.join(', ')}.` }
}
