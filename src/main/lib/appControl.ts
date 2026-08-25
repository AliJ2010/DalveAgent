import { exec, execFile } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export type ActionResult = 'SUCCESS' | 'FAILED' | 'UNCERTAIN'

/**
 * Best-effort read of which app is actually frontmost/focused right now — used to verify an
 * open/activate actually worked instead of assuming it did the moment a launch command returns.
 * Deliberately loose matching (substring, case-insensitive) since "Terminal" vs "Terminal.app"
 * vs a process named slightly differently are all the same app to the user asking for it.
 */
async function getFrontmostAppName(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`
      )
      return stdout.trim() || null
    }
    if (process.platform === 'win32') {
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [W]::GetForegroundWindow()
[uint32]$procId = 0
[void][W]::GetWindowThreadProcessId($h, [ref]$procId)
(Get-Process -Id $procId).ProcessName
      `.trim()
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`)
      return stdout.trim() || null
    }
  } catch (err) {
    console.error('[appControl] failed to read frontmost app:', err)
  }
  return null
}

function namesLooselyMatch(requested: string, actual: string | null): boolean {
  if (!actual) return false
  const a = requested.toLowerCase().replace(/\.app$/, '').trim()
  const b = actual.toLowerCase().replace(/\.app$/, '').trim()
  return a === b || a.includes(b) || b.includes(a)
}

async function launch(appName: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', appName])
    return
  }
  if (process.platform === 'win32') {
    // No generic "open by friendly name" on Windows the way `open -a` works on macOS — Start-Process
    // resolves common built-in names (notepad, calc, mspaint, explorer) and anything already on PATH
    // directly; anything else falls back to letting the shell's own app-name resolution (same
    // mechanism as Win+R) take a shot via `start`.
    await execAsync(`powershell -NoProfile -Command "Start-Process '${appName.replace(/'/g, "''")}'"`).catch(
      () => execAsync(`start "" "${appName.replace(/"/g, '')}"`)
    )
    return
  }
  throw new Error(`Opening applications by name isn't implemented for ${process.platform} yet.`)
}

/**
 * Opens an application by name and VERIFIES it actually became the frontmost app before
 * reporting success — the whole point being that "I ran a launch command" and "the app is
 * actually open" are different claims, and only the second one is worth telling the user.
 */
export async function openApplication(
  appName: string
): Promise<{ result: ActionResult; message: string }> {
  try {
    await launch(appName)
  } catch (err) {
    return {
      result: 'FAILED',
      message: `Failed to launch ${appName}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Give the OS a moment to actually bring the window up before checking — most apps activate
  // within a second or two; slower-starting ones (first cold launch) may need the extra retries.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 500))
    const frontmost = await getFrontmostAppName()
    if (namesLooselyMatch(appName, frontmost)) {
      return { result: 'SUCCESS', message: `${appName} is open and frontmost.` }
    }
  }

  return {
    result: 'UNCERTAIN',
    message: `Ran the command to open ${appName}, but couldn't confirm it actually became frontmost within 3 seconds — it may still be starting, or may have failed silently.`
  }
}

/** Brings an already-running application to the front. Verifies the same way openApplication does. */
export async function activateApplication(
  appName: string
): Promise<{ result: ActionResult; message: string }> {
  try {
    if (process.platform === 'darwin') {
      await execAsync(`osascript -e 'tell application "${appName.replace(/"/g, '\\"')}" to activate'`)
    } else if (process.platform === 'win32') {
      // Best-effort: Windows has no clean "activate by friendly name" API without already knowing
      // the window handle; re-launching is the practical equivalent for most apps (single-instance
      // apps just refocus instead of opening a second copy).
      await launch(appName)
    } else {
      throw new Error(`Activating applications isn't implemented for ${process.platform} yet.`)
    }
  } catch (err) {
    return {
      result: 'FAILED',
      message: `Failed to activate ${appName}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 400))
    const frontmost = await getFrontmostAppName()
    if (namesLooselyMatch(appName, frontmost)) {
      return { result: 'SUCCESS', message: `${appName} is now frontmost.` }
    }
  }
  return {
    result: 'UNCERTAIN',
    message: `Tried to activate ${appName} but couldn't confirm it became frontmost.`
  }
}

/**
 * Toggles native fullscreen for the CURRENT frontmost window/app. Platform-specific key
 * combination — macOS's standard fullscreen shortcut vs Windows' maximize — since "fullscreen"
 * means different native things on each OS.
 */
export async function fullscreenFrontmostWindow(): Promise<{ result: ActionResult; message: string }> {
  try {
    if (process.platform === 'darwin') {
      // Standard macOS "toggle fullscreen" shortcut, sent via System Events GUI scripting.
      await execAsync(
        `osascript -e 'tell application "System Events" to keystroke "f" using {control down, command down}'`
      )
      return { result: 'UNCERTAIN', message: 'Sent the fullscreen shortcut — macOS fullscreen transitions are animated, so this may take a second to visibly complete.' }
    }
    if (process.platform === 'win32') {
      // Windows maximize: Win+Up. robotjs maps the 'command' modifier to the Windows key on this platform.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const robot = require('robotjs')
      robot.keyTap('up', ['command'])
      return { result: 'SUCCESS', message: 'Maximized the current window.' }
    }
    throw new Error(`Fullscreen isn't implemented for ${process.platform} yet.`)
  } catch (err) {
    return {
      result: 'FAILED',
      message: `Failed to fullscreen: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
