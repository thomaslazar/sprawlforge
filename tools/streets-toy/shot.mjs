import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const TAGS = ['planned', 'mixed', 'sprawl']
const STAGES = ['patches', 'field', 'roads', 'faces']
const STAGE_MS_RE = /^(\S+):\s*([\d.]+)ms/

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
let failed = false

for (const tag of TAGS) {
  await page.goto(`${BASE}/tools/streets-toy/?tag=${tag}`)
  await page.waitForFunction(() => document.querySelectorAll('figure').length === 4)
  await page.waitForFunction(() => (document.getElementById('stats')?.textContent ?? '').length > 0)

  const figures = page.locator('figure')
  const count = await figures.count()
  if (count !== 4) {
    console.error(`FAIL [${tag}]: expected 4 figures, got ${count}`)
    failed = true
    continue
  }

  const statsText = (await page.locator('#stats').textContent()) ?? ''
  console.log(`--- stats [${tag}] ---\n${statsText}`)
  for (const line of statsText.split('\n')) {
    const m = line.match(STAGE_MS_RE)
    if (m && Number(m[2]) > 1500) {
      console.error(`FAIL [${tag}]: stage "${m[1]}" took ${m[2]}ms (> 1500ms)`)
      failed = true
    }
  }

  for (let i = 0; i < STAGES.length; i++) {
    await figures.nth(i).screenshot({ path: `${OUT}/toy-${tag}-${STAGES[i]}.png` })
  }
}

await browser.close()
process.exitCode = failed ? 1 : 0
console.log(failed ? 'streets toy shots FAILED' : `streets toy shots written to ${OUT}`)
