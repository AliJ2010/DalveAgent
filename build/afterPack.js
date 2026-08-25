// Copies playwright-browsers/ into the packaged app's resources directory as a plain filesystem
// operation, completely outside electron-builder's files/extraResources config.
//
// Confirmed empirically (not guessed): adding `extraResources` to electron-builder.yml — even
// with the `files` array completely unchanged — silently made electron-builder drop its own
// default file selection, excluding the app's own entry point (out/main/index.js) from the
// package entirely. Removing extraResources and rebuilding restored it immediately; re-adding it
// reproduced the loss every time. That's a real, verified quirk of this electron-builder version,
// not a theory. An afterPack hook runs after packaging is already decided and never touches that
// selection logic at all, so it can't trigger the same failure.
const fs = require('fs')
const path = require('path')

module.exports = async function afterPack(context) {
  const src = path.join(__dirname, '..', 'playwright-browsers')
  if (!fs.existsSync(src)) {
    console.warn('[afterPack] playwright-browsers/ not found — skipping (browser control tools will be unavailable in this build)')
    return
  }

  let dest
  if (context.electronPlatformName === 'darwin') {
    const appBundle = fs.readdirSync(context.appOutDir).find((f) => f.endsWith('.app'))
    dest = path.join(context.appOutDir, appBundle, 'Contents', 'Resources', 'playwright-browsers')
  } else {
    dest = path.join(context.appOutDir, 'resources', 'playwright-browsers')
  }

  fs.cpSync(src, dest, { recursive: true })
  console.log(`[afterPack] copied playwright-browsers -> ${dest}`)
}
