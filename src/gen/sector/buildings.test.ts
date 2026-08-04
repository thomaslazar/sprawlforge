import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import type { District, SectorParams } from '../types'
import { fillBuildings } from './buildings'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: '', bounds: { x: 0, y: 0, w: 600, h: 600 }, shore: false },
  { id: 'D02', zone: 'slum', name: '', bounds: { x: 700, y: 0, w: 600, h: 600 }, shore: false },
]
const blocksByDistrict: Rect[][] = [
  [{ x: 10, y: 10, w: 280, h: 280 }, { x: 310, y: 10, w: 280, h: 280 }],
  [{ x: 710, y: 10, w: 280, h: 280 }, { x: 1010, y: 10, w: 280, h: 280 }],
]

describe('fillBuildings', () => {
  it('is deterministic', () => {
    expect(fillBuildings(districts, blocksByDistrict, base))
      .toEqual(fillBuildings(districts, blocksByDistrict, base))
  })
  it('every building sits inside its block', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base)
    const byId = new Map(blocks.map((b) => [b.id, b.rect]))
    expect(buildings.length).toBeGreaterThan(0)
    for (const b of buildings) {
      const r = byId.get(b.blockId)!
      expect(b.rect.x).toBeGreaterThanOrEqual(r.x)
      expect(b.rect.y).toBeGreaterThanOrEqual(r.y)
      expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(r.x + r.w + 1e-9)
      expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(r.y + r.h + 1e-9)
    }
  })
  it('slum blocks are denser than corp blocks', () => {
    const { buildings } = fillBuildings(districts, blocksByDistrict, base)
    const corp = buildings.filter((b) => b.districtId === 'D01').length
    const slum = buildings.filter((b) => b.districtId === 'D02').length
    expect(slum).toBeGreaterThan(corp)
  })
  it('block and building ids encode district and block ordinals', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base)
    expect(blocks[0].id).toBe('B0101')
    expect(blocks.every((b) => /^B\d{4}$/.test(b.id))).toBe(true)
    expect(buildings.every((b) => /^BLD\d{6}$/.test(b.id))).toBe(true)
  })
  it('density knob raises building count', () => {
    const lo = fillBuildings(districts, blocksByDistrict, { ...base, density: 0 }).buildings.length
    const hi = fillBuildings(districts, blocksByDistrict, { ...base, density: 1 }).buildings.length
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
})
