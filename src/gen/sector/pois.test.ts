import { describe, expect, it } from 'vitest'
import { getPack } from '../names/packs'
import type { Building, District, SectorParams } from '../types'
import { placePois } from './pois'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'inland', river: false, lakes: false, piers: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: 'Test Heights', bounds: { x: 0, y: 0, w: 600, h: 600 }, shore: false, labelAt: { x: 300, y: 300 } },
]
const buildings: Building[] = Array.from({ length: 30 }, (_, i) => ({
  id: `BLD0101${String(i + 1).padStart(2, '0')}`,
  blockId: 'B0101',
  districtId: 'D01',
  rect: { x: i * 20, y: 0, w: 15, h: 15 },
  footprint: [{ x: i * 20, y: 0 }, { x: i * 20 + 15, y: 0 }, { x: i * 20 + 15, y: 15 }, { x: i * 20, y: 15 }],
}))

describe('placePois', () => {
  const pack = getPack('generic')
  it('is deterministic', () => {
    expect(placePois(districts, buildings, pack, base))
      .toEqual(placePois(districts, buildings, pack, base))
  })
  it('poi types match district zone and names are non-empty', () => {
    const pois = placePois(districts, buildings, pack, base)
    expect(pois.length).toBeGreaterThan(0)
    const validTypes = pack.poiTypes.filter((t) => t.zones.includes('corp')).map((t) => t.type)
    for (const p of pois) {
      expect(validTypes).toContain(p.type)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.at).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
      })
    }
  })
  it('poiDensity raises count; buildings never reused', () => {
    const lo = placePois(districts, buildings, pack, { ...base, poiDensity: 0.1 })
    const hi = placePois(districts, buildings, pack, { ...base, poiDensity: 1 })
    expect(hi.length).toBeGreaterThan(lo.length)
    expect(new Set(hi.map((p) => p.buildingId)).size).toBe(hi.length)
  })
})
