import { autoUpdater } from 'electron-updater'
import { app } from 'electron'

/**
 * Real self-update: checks the app's own GitHub releases, downloads a newer build in the
 * background, and installs it automatically the next time the app quits — no redownloading the
 * installer by hand.
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
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => console.error('[autoUpdate] error:', err))
  autoUpdater.on('update-available', (info) => console.log('[autoUpdate] downloading update:', info.version))
  autoUpdater.on('update-downloaded', (info) =>
    console.log('[autoUpdate] update ready, installs on next quit:', info.version)
  )

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdate] check failed:', err))
  }

  check()
  // DALVE hides to tray instead of quitting, so a session can run for days — recheck
  // periodically instead of only at launch, or a long-lived session would never see an update.
  setInterval(check, 4 * 60 * 60 * 1000)
}
