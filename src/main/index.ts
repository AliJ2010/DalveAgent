import { app, shell, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, screen, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc/handlers'

// Node's default behavior for an uncaught exception or unhandled promise rejection is to
// terminate the ENTIRE process — confirmed live: signing in crashed the whole app outright
// (not a hang, not an error message, the whole window just closed), almost certainly an
// unhandled error event from Supabase's realtime WebSocket connection during a period of real
// service instability (the same window where its own token-refresh endpoint was found hanging
// indefinitely). One flaky network event from a third-party service should never be able to take
// the whole app down — log it and keep running, exactly like a web browser tab surviving a script
// error instead of the whole browser closing.
process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException (kept the app alive):', err instanceof Error ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection (kept the app alive):', reason instanceof Error ? reason.stack : reason)
})
import { attachWindow, stopVoiceSession } from './lib/geminiLive'
import { attachWindow as attachGroqVoiceWindow, stopVoiceSession as stopGroqVoiceSession } from './lib/groqVoice'
import { attachWindow as attachScreenControlWindow, stopAll as stopScreenControl } from './lib/screenControl'
import { attachWindow as attachAutonomousTaskWindow, stopAutonomousTask } from './lib/autonomousTask'
import { attachWindow as attachAgentStoreWindow } from './lib/agentStore'
import { attachWindow as attachSettingsStoreWindow } from './lib/settingsStore'
import { attachWindow as attachHandTrackingWindow, stop as stopHandTracking } from './lib/handTracking'
import { attachWindow as attachSkillsStoreWindow } from './lib/skillsStore'
import { attachWindow as attachScheduleStoreWindow } from './lib/scheduleStore'
import { startScheduler } from './lib/scheduler'
import { initAutoUpdate } from './lib/autoUpdate'
import { initTelegramBridge } from './lib/telegramBridge'
import { reconnectAll as reconnectMcpServers } from './lib/mcpClient'

// Belt-and-suspenders alongside the lazy singletons in settingsStore/agentStore: pin the app
// name explicitly so userData resolves to the same %APPDATA%\dalve folder in dev and packaged
// builds, rather than depending on package.json "name" auto-detection (which returned the
// Electron default in at least one packaged build, silently starting users on a fresh profile).
app.setName('dalve')

// A leftover process from a previous launch (e.g. the dev-server window not fully exiting when
// the app window was closed) racing a fresh launch for the SAME userData profile is exactly what
// caused "reopening shows a brand new empty agent" in the past — two processes reading/writing
// dalve-settings.json/dalve-agents.json concurrently. Only the first instance keeps the lock;
// every later one quits immediately and just focuses the already-running window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// The hotkey should land on a specific monitor and go fullscreen, unlike a normal tray-click
// reopen which just restores wherever the window already was. Electron's display order isn't
// guaranteed to match Windows' own "Display 1/2/3" numbering exactly (it reflects OS enumeration
// order, which is usually but not always the same) — index 2 is the best available approximation
// of "monitor 3" without asking Windows for its own labels.
const HOTKEY_MONITOR_INDEX = 2

/** Ctrl+Alt+D: jump to the designated monitor, fullscreen, and start listening immediately. */
function openAndListen(): void {
  if (!mainWindow) return
  const displays = screen.getAllDisplays()
  const target = displays[HOTKEY_MONITOR_INDEX] ?? displays[displays.length - 1]
  if (target) {
    mainWindow.setBounds(target.bounds)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.setFullScreen(true)
  // Showing the window alone doesn't put DALVE into a listening state — this is what actually
  // starts mic capture and a live session once the window is up (see initWakeTriggerBridge).
  mainWindow.webContents.send('wake:triggered')
}

function createTray(): void {
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  tray = new Tray(trayIcon)
  tray.setToolTip('DALVE')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open DALVE', click: showMainWindow },
      { type: 'separator' },
      // Always present (rather than dynamically shown/hidden) so it's reachable without opening
      // the window first — the whole point of an autonomous task is that it can be running while
      // the window is hidden in the tray. Harmless no-op if nothing is currently running.
      { label: 'Stop Autonomous Task', click: () => stopAutonomousTask('stopped from tray') },
      { type: 'separator' },
      { label: 'Quit DALVE', click: () => app.quit() }
    ])
  )
  tray.on('click', showMainWindow)
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#050403',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // A voice session or autonomous task can be running while this window is hidden in the
      // tray — disabling background throttling avoids Chromium deprioritizing that work.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Closing the window just hides it — DALVE keeps running in the tray so the global hotkey
  // can bring it back without a relaunch. Only the tray's "Quit DALVE" (or the OS shutting
  // down) actually exits the process.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    stopVoiceSession()
    stopGroqVoiceSession()
    stopScreenControl()
    stopHandTracking()
    mainWindow = null
  })

  attachWindow(mainWindow)
  attachGroqVoiceWindow(mainWindow)
  attachScreenControlWindow(mainWindow)
  attachAutonomousTaskWindow(mainWindow)
  attachAgentStoreWindow(mainWindow)
  attachSettingsStoreWindow(mainWindow)
  attachHandTrackingWindow(mainWindow)
  attachSkillsStoreWindow(mainWindow)
  attachScheduleStoreWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (gotSingleInstanceLock) {
  app.on('second-instance', showMainWindow)

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('me.dalve.app')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test
    ipcMain.on('ping', () => console.log('pong'))

    registerIpcHandlers()

    // Explicitly grant microphone access — DALVE's voice input depends on it.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media')
    })

    // Only meaningful once DALVE is an installed exe, not `npm run dev` — a dev process has
    // no stable path to re-launch itself from. Opens visibly on login (not just hidden to tray)
    // per explicit request — the user wants DALVE actually on screen when the PC starts, not
    // silently running in the background.
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true })
    }

    createWindow()
    createTray()
    initAutoUpdate()
    initTelegramBridge()
    startScheduler()
    void reconnectMcpServers()

    // Voice wake-word ("Hey DALVE") was tried via two different offline engines and dropped —
    // neither reliably recognized the phrase. This hotkey is the replacement: free, instant,
    // zero setup, works system-wide even when DALVE is hidden in the tray or another app has
    // focus. Unlike a normal tray-click reopen, it jumps straight to fullscreen on the
    // designated monitor and starts listening immediately.
    globalShortcut.register('Control+Alt+D', openAndListen)

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })

  // With hide-to-tray, this now only fires on platforms/paths where a window was destroyed
  // without going through the tray (shouldn't normally happen) — kept as a safety net so the
  // process doesn't linger with no window and no tray icon.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) {
      app.quit()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
