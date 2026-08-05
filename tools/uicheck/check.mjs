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
await page.goto(`${BASE}/?seed=42&tags=coastal,large&pack=generic&theme=neon`)
await page.waitForSelector('svg')

// whole map fits the viewport on load (no initial zoom-in)
const initialBox = await page.locator('svg').boundingBox()
if (initialBox.height > 901 || initialBox.width > 1401)
  fail(`map does not fit viewport on load: ${initialBox.width}x${initialBox.height}`)

const buildings = await page.locator('svg polygon[data-id^="BLD"]').count()
if (buildings < 50) fail(`expected a dense map, got ${buildings} buildings`)

const pois = await page.locator('svg circle[data-id^="P"]').count()
if (pois < 1) fail('no POIs rendered')

// tag chips reflect the URL on load
if (!(await page.getByRole('button', { name: 'Coastal', pressed: true }).isVisible()))
  fail('coastal chip not pressed from URL tags')
if (!(await page.getByRole('button', { name: 'Large', pressed: true }).isVisible()))
  fail('large chip not pressed from URL tags')

// click a chip in another group → stages the tag (pressed) but does NOT
// regenerate: no url change, no map change, until Reroll
const urlBeforeStage = page.url()
const svgBeforeStage = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'Packed' }).click()
if (!(await page.getByRole('button', { name: 'Packed', pressed: true }).isVisible()))
  fail('packed chip not pressed after click')
if (page.url() !== urlBeforeStage) fail('clicking a chip changed the url before reroll')
if ((await page.locator('svg').innerHTML()) !== svgBeforeStage)
  fail('clicking a chip regenerated the map before reroll')

// reroll applies the staged tag: url gains it, map changes
await page.getByRole('button', { name: 'Reroll' }).click()
if (!page.url().includes('packed')) fail('reroll did not apply staged packed tag to url')
const svgAfterReroll = await page.locator('svg').innerHTML()
if (svgAfterReroll === svgBeforeStage) fail('reroll did not change map')

// click the now-active chip again → stages removal (unpressed), again no
// regen/url change until the next Reroll
await page.getByRole('button', { name: 'Packed' }).click()
if (!(await page.getByRole('button', { name: 'Packed', pressed: false }).isVisible()))
  fail('packed chip still pressed after deselect')
if (!page.url().includes('packed')) fail('deselecting a chip changed the url before reroll')
if ((await page.locator('svg').innerHTML()) !== svgAfterReroll)
  fail('deselecting a chip regenerated the map before reroll')

// reroll applies the staged removal: url loses it, map changes again
await page.getByRole('button', { name: 'Reroll' }).click()
if (page.url().includes('packed')) fail('reroll did not apply staged tag removal to url')
if ((await page.locator('svg').innerHTML()) === svgAfterReroll) fail('reroll did not change map')

// pan/zoom survives repeated dense drags (regression: ref race unmounted the app)
const map = await page.locator('svg').boundingBox()
const mx = map.x + map.width / 2
const my = map.y + map.height / 2

// semantic zoom: zooming in re-renders labels smaller → more of them fit
const labelsAtBase = await page.locator('svg text').count()
await page.mouse.move(mx, my)
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -240) // deep zoom-in
const labelsZoomed = await page.locator('svg text').count()
if (labelsZoomed < labelsAtBase) fail(`zoom lost labels: ${labelsAtBase} -> ${labelsZoomed}`)
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240) // back out

await page.mouse.wheel(0, -240)
for (let round = 0; round < 8; round++) {
  await page.mouse.move(mx, my)
  await page.mouse.down()
  await page.mouse.move(mx + 80, my + 40, { steps: 12 })
  await page.mouse.up()
  await page.mouse.down()
  await page.mouse.move(mx, my, { steps: 12 })
  await page.mouse.up()
}
if ((await page.locator('svg').count()) !== 1) fail('map vanished after pan/zoom drags')
if ((await page.locator('#root').textContent()).includes('hit an error')) fail('error boundary tripped during pan')

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

// terrain sweep: every kind renders buildings, wet kinds show water, rivers have bridges
for (const t of ['inland', 'river', 'coastal', 'bay', 'estuary', 'island', 'lakes']) {
  await page.goto(`${BASE}/?seed=42&tags=${t}`)
  await page.waitForSelector('svg')
  await page.screenshot({ path: `${OUT}/terrain-${t}.png` })

  const bld = await page.locator('svg polygon[data-id^="BLD"]').count()
  if (bld < 1) fail(`terrain ${t}: no buildings rendered`)

  if (t !== 'inland') {
    const water = await page.locator('svg [data-water]').count()
    if (water < 1) fail(`terrain ${t}: no water rendered`)
    // presence alone isn't enough (rec 4) — [data-water] is a <use> onto
    // #water-shape; a real multi-ring water body serializes to a long path,
    // an empty/degenerate one wouldn't
    const waterD = await page.locator('svg #water-shape').getAttribute('d')
    if (!waterD || waterD.length <= 100)
      fail(`terrain ${t}: water-shape path looks empty (${waterD?.length ?? 0} chars)`)
  }

  if (t === 'river') {
    const bridges = await page.locator('svg [data-bridge]').count()
    if (bridges < 1) fail('terrain river: no bridge rendered')
  }
}

// small windows are the tight case for C3's window placement — confirm the
// smallest size tag still shows water for a wet kind
await page.goto(`${BASE}/?seed=42&tags=coastal,small`)
await page.waitForSelector('svg')
if ((await page.locator('svg [data-water]').count()) < 1) fail('coastal,small: no water rendered')

await browser.close()
console.log(process.exitCode ? 'uicheck FAILED' : 'uicheck passed')
