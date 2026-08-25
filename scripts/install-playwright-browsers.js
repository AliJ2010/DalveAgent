// Downloads Playwright's Chromium into a project-local, bundleable folder instead of the
// default global cache (~/.cache/ms-playwright or %LOCALAPPDATA%\ms-playwright) — the default
// location works fine for local dev but never ships inside the packaged installer, which is
// exactly what browser_open/browser_click/etc. need to actually run on an installed copy of the
// app rather than only in `npm run dev`.
const { execSync } = require('child_process')
const { join } = require('path')

const browsersPath = join(__dirname, '..', 'playwright-browsers')
execSync('npx playwright install chromium', {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
})
