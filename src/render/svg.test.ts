import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import { GENERATOR_VERSION, type SectorModel, type SectorParams } from '../gen/types'
import { renderSector } from './svg'
import { getTheme, themes } from './theme'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'coastal', piers: false, pack: 'generic', theme: 'neon',
}
const model = generateSector(base)

describe('renderSector', () => {
  it('is deterministic', () => {
    expect(renderSector(model, getTheme('neon'))).toBe(renderSector(model, getTheme('neon')))
  })
  it('is a standalone svg with metric viewBox', () => {
    const svg = renderSector(model, getTheme('neon'))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="0 0 ${model.meta.sizeM} ${model.meta.sizeM}"`)
  })
  it('renders every district, building and poi with data-id', () => {
    const svg = renderSector(model, getTheme('neon'))
    for (const d of model.districts) expect(svg).toContain(`data-id="${d.id}"`)
    for (const p of model.pois) expect(svg).toContain(`data-id="${p.id}"`)
    expect(svg.match(/data-id="BLD/g)!.length).toBe(model.buildings.length)
  })
  it('has a metric scale bar', () => {
    expect(renderSector(model, getTheme('neon'))).toContain('500 m')
    const big = generateSector({ ...base, size: 6 })
    expect(renderSector(big, getTheme('neon'))).toContain('1 km')
  })
  it('themes change output', () => {
    expect(renderSector(model, getTheme('neon'))).not.toBe(renderSector(model, getTheme('print')))
  })
  it('escapes xml in names', () => {
    const hacked = {
      ...model,
      districts: [{ ...model.districts[0], name: 'A & B <X>' }, ...model.districts.slice(1)],
    }
    const svg = renderSector(hacked, getTheme('neon'))
    expect(svg).toContain('A &amp; B &lt;X&gt;')
  })
  it('ships neon and print themes; getTheme falls back to neon', () => {
    expect(Object.keys(themes).sort()).toEqual(['neon', 'print'])
    expect(getTheme('nope').id).toBe('neon')
  })
  it('getTheme falls back to neon for prototype-polluting ids', () => {
    expect(getTheme('constructor').id).toBe('neon')
  })
  const handModel = (pois: SectorModel['pois']): SectorModel => ({
    meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: base, sizeM: 1000, metroSeed: 1 },
    terrain: {
      kind: 'inland',
      metroSeed: 1,
      water: [],
      land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]],
      river: null,
    },
    roads: [],
    districts: [],
    blocks: [],
    buildings: [],
    pois,
  })
  const poi = (id: string, name: string, x: number, y: number, type = 'x') => ({
    id, buildingId: `BLD${id}`, districtId: 'D01', type, name, at: { x, y },
  })

  it('nudges a colliding poi label to another side instead of dropping it', () => {
    const svg = renderSector(
      handModel([poi('P01', 'Alpha Tower', 500, 500), poi('P02', 'Beta Tower', 500, 500)]),
      getTheme('neon'),
    )
    // both labels survive: second one lands on a different side
    expect(svg).toContain('Alpha Tower')
    expect(svg).toContain('Beta Tower')
  })

  it('drops the label only when all candidate positions collide, markers always render', () => {
    const pois = ['A', 'B', 'C', 'D', 'E'].map((s, i) =>
      poi(`P0${i + 1}`, `${s} Tower`, 500, 500),
    )
    const svg = renderSector(handModel(pois), getTheme('neon'))
    for (const p of pois) expect(svg).toContain(`data-id="${p.id}"`)
    const labels = svg.match(/[A-E] Tower<\/text>/g) ?? []
    // several nudge candidates place, the rest drop — never all five
    expect(labels.length).toBeGreaterThanOrEqual(2)
    expect(labels.length).toBeLessThan(5)
  })

  it('important poi types win the label contest', () => {
    const svg = renderSector(
      handModel([
        // bar comes first in model order but must lose to the corp hq
        ...['A', 'B', 'C', 'D'].map((s, i) => poi(`P0${i + 1}`, `${s} Dive`, 500, 500, 'bar')),
        poi('P05', 'Zeta Spire HQ', 500, 500, 'corp_hq'),
      ]),
      getTheme('neon'),
    )
    expect(svg).toContain('Zeta Spire HQ')
  })

  it('every poi marker carries a tooltip with its name', () => {
    const svg = renderSector(model, getTheme('neon'))
    expect(svg.match(/<title>/g)!.length).toBe(model.pois.length)
  })

  it('clamps edge labels into the viewbox', () => {
    const svg = renderSector(handModel([poi('P01', 'Edge Post', 995, 3)]), getTheme('neon'))
    const text = svg.match(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>Edge Post<\/text>/)
    expect(text).not.toBeNull()
    const fontP = 1000 * 0.011
    const y = Number(text![2])
    expect(y).toBeGreaterThanOrEqual(fontP) // label box top edge at y-h >= 0
    expect(Number(text![1])).toBeLessThanOrEqual(1000)
  })

  it('labelZoom shrinks label fonts and never loses labels', () => {
    const base1 = renderSector(model, getTheme('neon'))
    const zoomed = renderSector(model, getTheme('neon'), { labelZoom: 4 })
    const countLabels = (s: string) => (s.match(/<text /g) ?? []).length
    expect(countLabels(zoomed)).toBeGreaterThanOrEqual(countLabels(base1))
    expect(zoomed).toContain(`font-size="${(model.meta.sizeM * 0.011) / 4}"`)
  })
})
