import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import { ZONE_TYPES, type SectorParams, type Terrain } from '../types'
import { assignZones, zoneWeights } from './zoning'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}
const rects: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: (i % 4) * 1000, y: Math.floor(i / 4) * 1000, w: 900, h: 900,
}))

const dryTerrain: Terrain = {
  kind: 'inland',
  metroSeed: 1,
  water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  river: null,
}
const eastWater: Terrain = {
  kind: 'coastal',
  metroSeed: 1,
  water: [[[[3000, 0], [4000, 0], [4000, 4000], [3000, 4000]]]],
  land: [[[[0, 0], [3000, 0], [3000, 4000], [0, 4000]]]],
  river: null,
}

describe('assignZones', () => {
  it('is deterministic and assigns valid zones', () => {
    const a = assignZones(rects, base, dryTerrain)
    expect(a).toEqual(assignZones(rects, base, dryTerrain))
    for (const d of a) expect(ZONE_TYPES).toContain(d.zone)
  })
  it('ids follow geometric (y,x) order', () => {
    const shuffled = [...rects].reverse()
    const districts = assignZones(shuffled, base, dryTerrain)
    expect(districts.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
    )
    expect(districts[0].bounds).toEqual(rects[0])
  })
  it('no docks without coast', () => {
    for (const d of assignZones(rects, { ...base, corpDominance: 0 }, dryTerrain)) {
      expect(d.zone).not.toBe('docks')
    }
  })
  it('corp dominance shifts weights', () => {
    expect(zoneWeights({ ...base, corpDominance: 1 }, false).corp)
      .toBeGreaterThan(zoneWeights({ ...base, corpDominance: 0 }, false).corp)
    expect(zoneWeights({ ...base, corpDominance: 1 }, false).slum)
      .toBeLessThan(zoneWeights({ ...base, corpDominance: 0 }, false).slum)
  })
  it('no docks anywhere on dry terrain', () => {
    for (const d of assignZones(rects, base, dryTerrain)) expect(d.zone).not.toBe('docks')
  })
  it('docks only appear on shore districts; shore flag set', () => {
    const districts = assignZones(rects, { ...base, corpDominance: 0 }, eastWater)
    for (const d of districts) {
      if (d.zone === 'docks') expect(d.shore).toBe(true)
      const nearWater = d.bounds.x + d.bounds.w > 3000 - 150
      expect(d.shore).toBe(nearWater)
    }
  })
})
