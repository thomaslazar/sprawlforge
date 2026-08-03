import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const OUT = process.env.OUT_DIR ?? new URL('./shots', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

// fixed seed → reproducible assertions
await page.goto(
  `${BASE}/?seed=42&size=4&density=0.5&corp=0.5&poi=0.5&coast=1&river=0&pack=generic&theme=neon`,
)
await page.waitForSelector('svg')

const buildings = await page.locator('svg rect[data-id^="BLD"]').count()
if (buildings < 50) fail(`expected a dense map, got ${buildings} buildings`)

const pois = await page.locator('svg circle[data-id^="P"]').count()
if (pois < 1) fail('no POIs rendered')

// knob → URL round trip
await page.getByLabel(/Corp dominance/).fill('1')
if (!page.url().includes('corp=1')) fail('slider did not update url')

// reroll changes the map
const before = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'Reroll' }).click()
const after = await page.locator('svg').innerHTML()
if (before === after) fail('reroll did not change map')

// theme switch, screenshot both
await page.getByLabel(/Theme/).selectOption('print')
await page.screenshot({ path: `${OUT}/print.png`, fullPage: true })
await page.getByLabel(/Theme/).selectOption('neon')
await page.screenshot({ path: `${OUT}/neon.png`, fullPage: true })

// exports: each button fires a real download with the expected filename
for (const [label, ext] of [
  ['Export SVG', 'svg'],
  ['Export PNG', 'png'],
  ['Export PDF', 'pdf'],
]) {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: label }).click(),
  ])
  const filename = dl.suggestedFilename()
  if (!filename.startsWith('sprawlforge-sector-')) fail(`${label} filename ${filename} missing prefix`)
  await dl.saveAs(`${OUT}/export.${ext}`)
}

await browser.close()
console.log(process.exitCode ? 'uicheck FAILED' : 'uicheck passed')
