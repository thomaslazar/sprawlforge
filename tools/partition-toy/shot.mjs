import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1420, height: 1500 } })
await page.goto(`${BASE}/tools/partition-toy/`)
await page.waitForSelector('svg')
const figures = await page.locator('figure').count()
if (figures !== 20) {
  console.error(`FAIL: expected 20 figures, got ${figures}`)
  process.exitCode = 1
}
await page.screenshot({ path: `${OUT}/toy.png`, fullPage: true })
await browser.close()
console.log(process.exitCode ? 'toy shot FAILED' : `toy shot written to ${OUT}/toy.png`)
