import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type { BrowserContext, Page, Locator } from 'playwright'

type ChromiumType = typeof import('playwright')['chromium']

// `chromium` itself is NOT imported as a normal value import — Playwright computes its browsers-
// install directory from PLAYWRIGHT_BROWSERS_PATH exactly once, at module-evaluation time, the
// instant `playwright` is first required. A static `import ... from 'playwright'` at the top of
// this file gets hoisted ahead of everything else in this module (ES module semantics: imported
// modules fully evaluate before the importing module's own body runs) — so by the time
// ensurePage() below set the env var, Playwright had already locked in the WRONG (default global
// cache) directory. Confirmed live: a packaged build with the correct browser bundled at
// resourcesPath/playwright-browsers still had every browser_* tool fail with "Executable doesn't
// exist at ...\AppData\Local\ms-playwright\...". Fix: require() it lazily, after the env var is
// set, so Playwright's one-time path computation sees the right value.
let chromiumModule: ChromiumType | null = null
function getChromium(): ChromiumType {
  if (!chromiumModule) chromiumModule = (require('playwright') as { chromium: ChromiumType }).chromium
  return chromiumModule
}

/**
 * Real DOM-level browser control — Tier 2 of the control hierarchy (API > DOM > OS accessibility
 * > vision). This is what WhatsApp Web should have been using from the start: a chat row is a
 * real, unambiguous DOM element with real text, not a screenshot region to guess a coordinate
 * for. Structurally immune to the "clicked Chrome's own toolbar instead of the page" class of bug
 * that hit uiAutomation.ts — a Playwright Page can only see the webpage's own content; it has no
 * way to even address the browser's tabs/toolbar/profile button, because those aren't part of the
 * page at all.
 *
 * Deliberately NOT attached to the user's actual everyday Chrome — Playwright can only control a
 * browser it launched itself (or one started with a debug flag from the very beginning, which a
 * normal double-clicked Chrome icon never has). Instead this owns a separate, persistent browser
 * profile that remembers logins (WhatsApp Web included) across restarts, same as a real browser
 * profile would — sign in once, stay signed in.
 */

let context: BrowserContext | null = null
let page: Page | null = null
let launching: Promise<Page> | null = null

function profileDir(): string {
  return join(app.getPath('userData'), 'dalve-browser-profile')
}

/**
 * Playwright's browser binary lives outside node_modules by default, in a machine-global cache
 * — fine for local dev (every dev machine already has it from `npm install`'s postinstall step),
 * but that cache is never part of a packaged installer. scripts/install-playwright-browsers.js
 * downloads it into a project-local `playwright-browsers/` folder specifically so
 * electron-builder can bundle it; this points Playwright at wherever that folder actually ended
 * up for the CURRENT run (bundled resources when packaged, project root in dev) instead of the
 * global cache it would otherwise silently default to and not find anything in.
 */
function resolveBrowsersPath(): string | null {
  // extraResources (electron-builder.yml) copies straight into resourcesPath, untouched by the
  // asar entirely — no "app.asar.unpacked" prefix, unlike files matched via asarUnpack.
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'playwright-browsers')
    : join(app.getAppPath(), 'playwright-browsers')
  return existsSync(bundled) ? bundled : null
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page
  if (launching) return launching

  launching = (async () => {
    const browsersPath = resolveBrowsersPath()
    if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
    context = await getChromium().launchPersistentContext(profileDir(), {
      headless: false,
      viewport: { width: 1280, height: 800 }
    })
    context.on('close', () => {
      context = null
      page = null
    })
    const existing = context.pages()
    page = existing.length > 0 ? existing[0] : await context.newPage()
    return page
  })()

  try {
    return await launching
  } finally {
    launching = null
  }
}

export async function isOpen(): Promise<boolean> {
  return page !== null && !page.isClosed()
}

export async function closeBrowser(): Promise<void> {
  if (context) await context.close()
  context = null
  page = null
}

export async function openUrl(url: string): Promise<{ title: string; url: string }> {
  const p = await ensurePage()
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  return { title: await p.title(), url: p.url() }
}

export async function getCurrentState(): Promise<{ title: string; url: string } | null> {
  if (!page || page.isClosed()) return null
  return { title: await page.title(), url: page.url() }
}

/** A generous chunk of the page's own visible text, in reading order — for reasoning about what
 *  a page actually shows before deciding what to click, same spirit as read_screen_text but from
 *  the real DOM instead of pixels. */
export async function getVisibleText(): Promise<string> {
  const p = await ensurePage()
  const text = await p.locator('body').innerText({ timeout: 10000 })
  return text.slice(0, 8000)
}

interface LocateOutcome {
  locator: Locator
  strategy: string
}

/**
 * Tries several real Playwright locator strategies in order of specificity, stopping at the
 * first that resolves to exactly one visible match. Deliberately does NOT silently guess among
 * several matches the way a coordinate click could — multiple hits get reported back as a real
 * ambiguity instead of picking one blind.
 */
async function locate(page: Page, description: string): Promise<LocateOutcome | { ambiguous: string[] } | null> {
  const attempts: { name: string; locator: Locator }[] = [
    { name: 'role=button exact', locator: page.getByRole('button', { name: description, exact: true }) },
    { name: 'role=link exact', locator: page.getByRole('link', { name: description, exact: true }) },
    { name: 'role=textbox exact', locator: page.getByRole('textbox', { name: description, exact: true }) },
    { name: 'placeholder', locator: page.getByPlaceholder(description, { exact: false }) },
    { name: 'label', locator: page.getByLabel(description, { exact: false }) },
    { name: 'role=button fuzzy', locator: page.getByRole('button', { name: description, exact: false }) },
    { name: 'role=link fuzzy', locator: page.getByRole('link', { name: description, exact: false }) },
    { name: 'text fuzzy', locator: page.getByText(description, { exact: false }) },
    { name: 'title attribute', locator: page.locator(`[title="${description}"]`) }
  ]

  for (const attempt of attempts) {
    const visible = attempt.locator.locator('visible=true')
    const count = await visible.count().catch(() => 0)
    if (count === 1) return { locator: visible, strategy: attempt.name }
    if (count > 1) {
      // A generic strategy (plain text match) hitting several rows is normal and not worth
      // failing over — take the first, since reading order usually puts the most prominent/first
      // rendered match first. A structural role-based strategy hitting several IS worth
      // surfacing, since that usually means the description itself is too vague.
      if (attempt.name === 'text fuzzy' || attempt.name === 'title attribute') {
        return { locator: visible.first(), strategy: `${attempt.name} (${count} matches, took first)` }
      }
      const texts = await visible.allInnerTexts().catch(() => [] as string[])
      return { ambiguous: texts.slice(0, 15) }
    }
  }
  return null
}

export interface BrowserActionResult {
  status: 'SUCCESS' | 'FAILED'
  message: string
  candidates?: string[]
  [key: string]: unknown
}

export async function clickByDescription(description: string): Promise<BrowserActionResult> {
  const p = await ensurePage()
  const outcome = await locate(p, description)
  if (!outcome) {
    return { status: 'FAILED', message: `No element matching "${description}" was found on the current page.` }
  }
  if ('ambiguous' in outcome) {
    return {
      status: 'FAILED',
      message: `Multiple elements matched "${description}" — be more specific.`,
      candidates: outcome.ambiguous
    }
  }
  await outcome.locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined)
  await outcome.locator.click({ timeout: 10000 })
  return { status: 'SUCCESS', message: `Clicked (matched via ${outcome.strategy}).` }
}

/** Clicks a field first (so it genuinely has focus, same discipline as the OS-level tools) then
 *  types into it — avoids typing into whatever happened to have focus before. */
export async function typeIntoField(fieldDescription: string, text: string, pressEnter = false): Promise<BrowserActionResult> {
  const p = await ensurePage()
  const outcome = await locate(p, fieldDescription)
  if (!outcome) {
    return { status: 'FAILED', message: `No field matching "${fieldDescription}" was found.` }
  }
  if ('ambiguous' in outcome) {
    return { status: 'FAILED', message: `Multiple fields matched "${fieldDescription}" — be more specific.`, candidates: outcome.ambiguous }
  }
  await outcome.locator.click({ timeout: 10000 })
  await outcome.locator.pressSequentially(text, { delay: 12 })
  if (pressEnter) await outcome.locator.press('Enter')
  return { status: 'SUCCESS', message: `Typed into field (matched via ${outcome.strategy}).` }
}

export async function pressKey(key: string): Promise<void> {
  const p = await ensurePage()
  await p.keyboard.press(key)
}

export async function scrollPage(deltaY: number): Promise<void> {
  const p = await ensurePage()
  await p.mouse.wheel(0, deltaY)
}

/** Runs arbitrary read-only JS in the page and returns the JSON-serializable result — the actual
 *  fix for cases like chess.com, where individual pieces have no accessible role/text at all but
 *  DO have a real, inspectable DOM (confirmed live: piece elements carry their square/type in
 *  their class name). Deliberately named to make clear this is a raw escape hatch, not a normal
 *  action — prefer clickByDescription/typeIntoField for anything with real text/role. */
export async function evaluateInPage(script: string): Promise<unknown> {
  const p = await ensurePage()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return p.evaluate(script as any)
}
