import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import { ZONE_TYPES, type SectorParams } from '../types'
import { assignZones, zoneWeights } from './zoning'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}
const rects: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: (i % 4) * 1000, y: Math.floor(i / 4) * 1000, w: 900, h: 900,
}))

describe('assignZones', () => {
  it('is deterministic and assigns valid zones', () => {
    const a = assignZones(rects, base)
    expect(a).toEqual(assignZones(rects, base))
    for (const d of a) expect(ZONE_TYPES).toContain(d.zone)
  })
  it('ids follow geometric (y,x) order', () => {
    const shuffled = [...rects].reverse()
    const districts = assignZones(shuffled, base)
    expect(districts.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
    )
    expect(districts[0].bounds).toEqual(rects[0])
  })
  it('no docks without coast', () => {
    for (const d of assignZones(rects, { ...base, corpDominance: 0 })) {
      expect(d.zone).not.toBe('docks')
    }
  })
  it('corp dominance shifts weights', () => {
    expect(zoneWeights({ ...base, corpDominance: 1 }).corp)
      .toBeGreaterThan(zoneWeights({ ...base, corpDominance: 0 }).corp)
    expect(zoneWeights({ ...base, corpDominance: 1 }).slum)
      .toBeLessThan(zoneWeights({ ...base, corpDominance: 0 }).slum)
  })
})
