import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import type { SectorParams } from '../gen/types'
import { renderSector } from './svg'
import { getTheme, themes } from './theme'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: true, river: false, pack: 'generic', theme: 'neon',
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
})
