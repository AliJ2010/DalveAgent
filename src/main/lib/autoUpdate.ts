import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import * as geminiLive from './geminiLive'
import * as autonomousTask from './autonomousTask'

/**
 * Real self-update: checks the app's own GitHub releases, downloads a newer build in the
 * background, and installs itself as soon as it's safe to — no manual quit-then-quit-again
 * dance, and no redownloading the installer by hand.
 *
 * "As soon as it's safe" means not mid-conversation and not mid-autonomous-task: restarting the
 * process the instant a download finishes would silently cut off whatever the user is doing.
 * Checked on an interval instead of via an event hook (simplest way to react to "the user is done
 * talking" without wiring a new callback through geminiLive/autonomousTask) — a stray extra
 * 15-second wait after a conversation ends is a non-issue, an update landing mid-sentence isn't.
 *
 * macOS caveat: Squirrel.Mac (the mechanism this uses on Mac) refuses to apply an update unless
 * the app is code-signed and notarized, which needs a paid Apple Developer account — not
 * something buildable from here. This still runs on Mac and will start working the moment the
 * build gets signed; until then it just checks and silently finds nothing it can apply.
 */
export function initAutoUpdate(): void {
  // electron-updater expects a packaged app with real release metadata next to it — running it
  // against a dev build does nothing useful and just logs noise.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  // We drive the install moment ourselves (see below) instead of letting electron-updater apply
  // it silently on whatever quit happens to come next.
  autoUpdater.autoInstallOnAppQuit = false

  let installTimer: ReturnType<typeof setInterval> | null = null

  autoUpdater.on('error', (err) => console.error('[autoUpdate] error:', err))
  autoUpdater.on('update-available', (info) => console.log('[autoUpdate] downloading update:', info.version))
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdate] update downloaded, installing as soon as safe:', info.version)
    if (installTimer) return
    const tryInstall = (): void => {
      if (geminiLive.isSessionActive() || autonomousTask.isActive()) return
      if (installTimer) clearInterval(installTimer)
      autoUpdater.quitAndInstall()
    }
    tryInstall() // covers the common case: nothing was happening when the download finished
    installTimer = setInterval(tryInstall, 15000)
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdate] check failed:', err))
  }

  check()
  // DALVE hides to tray instead of quitting, so a session can run for days — recheck
  // periodically instead of only at launch, or a long-lived session would never see an update.
  setInterval(check, 4 * 60 * 60 * 1000)
}
