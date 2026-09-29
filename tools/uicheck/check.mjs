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
// chip labels are just capitalized tag ids (see strings.ts t.tags) — used to
// assert the pressed chip set matches the url's tags param exactly
const TAG_LABEL = (tag) => tag.charAt(0).toUpperCase() + tag.slice(1)
const ALL_TAGS = [
  'inland', 'coastal', 'bay', 'river', 'lakes', 'islands',
  'small', 'medium', 'large', 'sparse', 'dense', 'packed',
  'corp-run', 'balanced', 'fringe', 'quiet', 'normal', 'lively',
  'planned', 'mixed', 'sprawl', 'piers',
]
// generation now round-trips through a worker (async) — an action that
// should regenerate the map needs to wait for the new svg, not assume it
// landed synchronously by the time the next Playwright command runs.
// Measured: large/packed tag combos take up to ~7s worker round-trip under
// CI/sandbox CPU contention — a 5s budget was intermittently too tight,
// and a timed-out wait here doesn't abort, it lets the caller capture a
// stale "after" baseline that the still-in-flight reply then mutates later,
// which surfaces as an unrelated *next* assertion falsely accusing that
// step of an unwanted regenerate.
const waitForSvgChange = (prevHtml, timeout = 15000) =>
  page.waitForFunction(
    (prev) => document.querySelector('svg')?.innerHTML !== prev,
    prevHtml,
    { timeout },
  )

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

// cursor-anchored zoom: the world point under the cursor must stay fixed on
// screen — read the map-viewport's translate/scale transform straight from
// the DOM before and after a wheel tick and check it against the formula
// (newX = c.x - (c.x - oldX) * newZoom/oldZoom, same for y) rather than
// relying on hit-testing a specific element.
const readTransform = () =>
  page.locator('.map-viewport').evaluate((el) => {
    const m = el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
    return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }
  })
const mapContainerBox = await page.locator('.map-viewport').locator('xpath=..').boundingBox()
const zx = mapContainerBox.x + 200
const zy = mapContainerBox.y + 150
await page.mouse.move(zx, zy)
const beforeZoom = await readTransform()
await page.mouse.wheel(0, -240)
await page.waitForTimeout(50)
const afterZoom = await readTransform()
if (afterZoom.zoom === beforeZoom.zoom) fail('wheel over the map did not change zoom')
const cx = zx - mapContainerBox.x
const cy = zy - mapContainerBox.y
const ratio = afterZoom.zoom / beforeZoom.zoom
const expectedX = cx - (cx - beforeZoom.x) * ratio
const expectedY = cy - (cy - beforeZoom.y) * ratio
if (Math.abs(afterZoom.x - expectedX) > 1 || Math.abs(afterZoom.y - expectedY) > 1)
  fail(
    `wheel zoom is not cursor-anchored: got (${afterZoom.x}, ${afterZoom.y}), ` +
      `expected (${expectedX}, ${expectedY})`,
  )
// reset pan/zoom for the rest of the checks below (which assume load defaults)
await page.goto(`${BASE}/?seed=42&tags=coastal,large&pack=generic&theme=neon`)
await page.waitForSelector('svg')

// Show POIs toggle: instant display filter, no reroll/regeneration — url
// stays put and no 'Generating…' busy flip, just the markers vanishing
const urlBeforePoiToggle = page.url()
const showPoisToggle = page.getByLabel(/Show POIs/)
await showPoisToggle.click()
if ((await page.locator('svg circle[data-id^="P"]').count()) !== 0)
  fail('unchecking Show POIs did not hide poi markers')
if (page.url() !== urlBeforePoiToggle) fail('toggling Show POIs changed the url')
if (await page.getByText('Generating…').isVisible().catch(() => false))
  fail('toggling Show POIs triggered a regenerate busy state')
await showPoisToggle.click()
if ((await page.locator('svg circle[data-id^="P"]').count()) < 1)
  fail('rechecking Show POIs did not restore poi markers')

// tag chips reflect the URL on load
if (!(await page.getByRole('button', { name: 'Coastal', pressed: true }).isVisible()))
  fail('coastal chip not pressed from URL tags')
if (!(await page.getByRole('button', { name: 'Large', pressed: true }).isVisible()))
  fail('large chip not pressed from URL tags')

// click a chip in another group → stages the tag (pressed) but does NOT
// regenerate: no url change, no map change, until Update
const urlBeforeStage = page.url()
const svgBeforeStage = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'Packed' }).click()
if (!(await page.getByRole('button', { name: 'Packed', pressed: true }).isVisible()))
  fail('packed chip not pressed after click')
if (page.url() !== urlBeforeStage) fail('clicking a chip changed the url before update')
if ((await page.locator('svg').innerHTML()) !== svgBeforeStage)
  fail('clicking a chip regenerated the map before update')

// Update applies the staged tag with the SAME seed: url gains the tag, seed
// unchanged, map changes
const seedBeforeUpdate = new URL(page.url()).searchParams.get('seed')
await page.getByRole('button', { name: 'Update' }).click()
if (!page.url().includes('packed')) fail('update did not apply staged packed tag to url')
if (new URL(page.url()).searchParams.get('seed') !== seedBeforeUpdate)
  fail('update changed the seed in the url')
await waitForSvgChange(svgBeforeStage).catch(() => fail('update did not change map (timed out)'))
const svgAfterUpdate = await page.locator('svg').innerHTML()

// click the now-active chip again → stages removal (unpressed), again no
// regen/url change until the next Update
await page.getByRole('button', { name: 'Packed' }).click()
if (!(await page.getByRole('button', { name: 'Packed', pressed: false }).isVisible()))
  fail('packed chip still pressed after deselect')
if (!page.url().includes('packed')) fail('deselecting a chip changed the url before update')
if ((await page.locator('svg').innerHTML()) !== svgAfterUpdate)
  fail('deselecting a chip regenerated the map before update')

// Update applies the staged removal: url loses it, map changes again
await page.getByRole('button', { name: 'Update' }).click()
if (page.url().includes('packed')) fail('update did not apply staged tag removal to url')
await waitForSvgChange(svgAfterUpdate).catch(() => fail('update did not change map (timed out)'))

// Reroll: new random seed AND every tag group freshly re-rolled from it
// (materializeTags from an empty set — the same full surprise-me roll a
// bare URL gets). Staged chips are NOT kept — the pressed set after Reroll
// must equal exactly whatever the fresh roll put in the url, nothing staged
// beforehand survives on its own.
const svgBeforeReroll = await page.locator('svg').innerHTML()
const seedBeforeReroll = new URL(page.url()).searchParams.get('seed')
await page.getByRole('button', { name: 'Packed' }).click() // stage packed (must NOT survive the reroll)
await page.getByRole('button', { name: 'Reroll' }).click()
const urlAfterReroll = new URL(page.url())
if (urlAfterReroll.searchParams.get('seed') === seedBeforeReroll)
  fail('reroll did not change the seed in the url')
const rerolledTags = (urlAfterReroll.searchParams.get('tags') ?? '').split(',').filter(Boolean)
if (rerolledTags.length === 0) fail('reroll produced no tags in the url')
for (const tag of ALL_TAGS) {
  const pressed =
    (await page.getByRole('button', { name: TAG_LABEL(tag) }).getAttribute('aria-pressed')) === 'true'
  if (pressed !== rerolledTags.includes(tag))
    fail(`reroll: chip "${tag}" pressed=${pressed} but url tags includes=${rerolledTags.includes(tag)}`)
}
await waitForSvgChange(svgBeforeReroll).catch(() => fail('reroll did not change the map (timed out)'))

// Dice: new random seed, tag set in the url untouched
const urlBeforeDice = new URL(page.url())
const svgBeforeDice = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'New random seed, keep tags' }).click()
const urlAfterDice = new URL(page.url())
if (urlAfterDice.searchParams.get('seed') === urlBeforeDice.searchParams.get('seed'))
  fail('dice did not change the seed in the url')
if (urlAfterDice.searchParams.get('tags') !== urlBeforeDice.searchParams.get('tags'))
  fail('dice changed the tag set in the url')
await waitForSvgChange(svgBeforeDice).catch(() => fail('dice did not change the map (timed out)'))

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

// theme switch: assert each theme renders its distinct bg color, then screenshot
const THEME_BG = { print: '#ffffff', blueprint: '#0b2e59', neon: '#0a0c12', synthwave: '#14091f', 'tokyo-night': '#1a1b26' }
for (const [theme, bgHex] of Object.entries(THEME_BG)) {
  await page.getByLabel(/Theme/).selectOption(theme)
  const svg = await page.locator('svg').innerHTML()
  if (!svg.includes(bgHex)) fail(`theme ${theme}: bg color ${bgHex} not found in rendered svg`)
  await page.screenshot({ path: `${OUT}/${theme}.png`, fullPage: true })
}

// png export resolution knob: select exists, defaults to 2x, and can be changed
const pngScaleSelect = page.getByLabel(/PNG resolution/)
if ((await pngScaleSelect.inputValue()) !== '2') fail('png scale select did not default to 2x')
if (!(await pngScaleSelect.locator('option').allTextContents()).every((t, i) => t === `${[1, 2, 4][i]}×`))
  fail('png scale select is missing the 1x/2x/4x options')
await pngScaleSelect.selectOption('4')
if ((await pngScaleSelect.inputValue()) !== '4') fail('png scale select did not change to 4x')

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

// piers chip gates on wet terrain: disabled + auto-unstaged when explicitly
// dry (inland, no river, no lakes), re-enabled by any water modifier or
// landform other than inland
await page.goto(`${BASE}/?seed=42&tags=coastal`)
await page.waitForSelector('svg')
const piersChip = page.getByRole('button', { name: 'Piers' })
await piersChip.click() // stage piers under coastal
if ((await piersChip.getAttribute('aria-pressed')) !== 'true')
  fail('piers chip did not stage under coastal')

await page.getByRole('button', { name: 'Inland' }).click() // dry terrain staged
if (!(await piersChip.isDisabled())) fail('piers chip not disabled when inland staged')
if ((await piersChip.getAttribute('aria-pressed')) !== 'false')
  fail('staging inland did not auto-unstage piers')

await page.getByRole('button', { name: 'Coastal' }).click() // back to wet terrain
if (await piersChip.isDisabled()) fail('piers chip stayed disabled after staging a wet terrain')

await page.getByRole('button', { name: 'Inland' }).click() // dry again
if (!(await piersChip.isDisabled())) fail('piers chip not disabled when inland re-staged')
await page.getByRole('button', { name: 'Lakes' }).click() // inland + lakes: no longer dry
if (await piersChip.isDisabled()) fail('piers chip stayed disabled for inland+lakes')

// reroll busy feedback: catching the transient overlay reliably in headless
// CI is racy, so this only checks the observable end state — the map
// actually changed and the overlay is gone once it settles.
const svgBeforeBusyReroll = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'Reroll' }).click()
await waitForSvgChange(svgBeforeBusyReroll).catch(() => fail('reroll did not change the map (timed out)'))
if (await page.getByText('Generating…').isVisible().catch(() => false))
  fail('busy overlay still visible after reroll settled')

// terrain sweep: the 3 landforms alone, plus composable combos —
// every entry renders buildings, wet entries show water, river combos
// have bridges (composable terrain: landform + independent water toggles).
// islands is a water modifier now (islets inside water), not a landform —
// `coastal,islands` replaces the old standalone `island` entry.
const TERRAIN_SWEEP = [
  { tags: 'inland', shot: 'inland', wet: false, bridge: false },
  { tags: 'coastal', shot: 'coastal', wet: true, bridge: false },
  { tags: 'bay', shot: 'bay', wet: true, bridge: false },
  { tags: 'coastal,islands', shot: 'coastal-islands', wet: true, bridge: false },
  { tags: 'coastal,river', shot: 'coastal-river', wet: true, bridge: true },
  { tags: 'inland,lakes', shot: 'inland-lakes', wet: true, bridge: false },
  // honest bridge geometry (no sideways "pull onto network" hack — see
  // bridges.ts) means not every river/coast crossing is bridgeable; seed 42
  // happens to have no genuinely two-bank-landable crossing on this bay
  // shape, so this entry pins a seed known to produce one instead
  { tags: 'bay,river', shot: 'bay-river', wet: true, bridge: true, seed: 12 },
]
for (const { tags, shot, wet, bridge, seed = 42 } of TERRAIN_SWEEP) {
  await page.goto(`${BASE}/?seed=${seed}&tags=${tags}`)
  await page.waitForSelector('svg')
  await page.screenshot({ path: `${OUT}/terrain-${shot}.png` })

  const bld = await page.locator('svg polygon[data-id^="BLD"]').count()
  if (bld < 1) fail(`terrain ${tags}: no buildings rendered`)

  if (wet) {
    const water = await page.locator('svg [data-water]').count()
    if (water < 1) fail(`terrain ${tags}: no water rendered`)
    // presence alone isn't enough (rec 4) — [data-water] is a <use> onto
    // #water-shape; a real multi-ring water body serializes to a long path,
    // an empty/degenerate one wouldn't
    const waterD = await page.locator('svg #water-shape').getAttribute('d')
    if (!waterD || waterD.length <= 100)
      fail(`terrain ${tags}: water-shape path looks empty (${waterD?.length ?? 0} chars)`)
  }

  if (bridge) {
    const bridges = await page.locator('svg [data-bridge]').count()
    if (bridges < 1) fail(`terrain ${tags}: no bridge rendered`)
  }
}

// street-style tags: planned vs sprawl must both render dense fabric and differ
await page.goto(`${BASE}/?seed=42&tags=coastal,planned`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-planned.png` })
const svgPlanned = await page.locator('svg').innerHTML()
if ((await page.locator('svg polygon[data-id^="BLD"]').count()) < 50)
  fail('planned: too few buildings')
if (!(await page.getByRole('button', { name: 'Planned', pressed: true }).isVisible()))
  fail('planned chip not pressed from URL tags')
if ((await page.locator('svg polyline[data-class="ramp"]').count()) < 1) fail('planned: no ramps')
if ((await page.locator('svg circle[data-junction="4"]').count()) < 20) fail('planned: too few crossroads')

await page.goto(`${BASE}/?seed=42&tags=coastal,sprawl`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-sprawl.png` })
if ((await page.locator('svg polygon[data-id^="BLD"]').count()) < 50)
  fail('sprawl: too few buildings')
if ((await page.locator('svg').innerHTML()) === svgPlanned)
  fail('planned and sprawl render identically')

// water-heavy organic fabric: crooked streets + bridges coexist
await page.goto(`${BASE}/?seed=42&tags=coastal,river,sprawl`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-sprawl-river.png` })

// bare URL (no tags) still auto-resolves a landform via resolveTerrain, but
// the chips/URL must materialize that roll instead of showing nothing staged
await page.goto(`${BASE}/?seed=42`)
await page.waitForSelector('svg')
const LANDFORM_LABELS = ['Inland', 'Coastal', 'Bay']
let pressedLandform = null
for (const label of LANDFORM_LABELS) {
  if ((await page.getByRole('button', { name: label }).getAttribute('aria-pressed')) === 'true') {
    pressedLandform = label
    break
  }
}
if (!pressedLandform) fail('bare url: no landform chip pressed after materialization')
if (!page.url().includes('tags=')) fail('bare url: url was not materialized with tags=')

// small windows are the tight case for C3's window placement — confirm the
// smallest size tag still shows water for a wet kind
await page.goto(`${BASE}/?seed=42&tags=coastal,small`)
await page.waitForSelector('svg')
if ((await page.locator('svg [data-water]').count()) < 1) fail('coastal,small: no water rendered')

await browser.close()
console.log(process.exitCode ? 'uicheck FAILED' : 'uicheck passed')
