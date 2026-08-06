import { describe, expect, it } from 'vitest'
import type { Pt, Rect } from '../geometry'
import { ZONE_TYPES, type SectorParams, type Terrain } from '../types'
import { assignZones, zoneWeights } from './zoning'

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

const params: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}
const rects: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: (i % 4) * 1000, y: Math.floor(i / 4) * 1000, w: 900, h: 900,
}))
const polys = rects.map(rectPoly)

const dryTerrain: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: false,
  metroSeed: 1,
  water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  riverSlice: null,
}
const eastWater: Terrain = {
  landform: 'coastal', river: false, lakes: false, islands: false,
  metroSeed: 1,
  water: [[[[3000, 0], [4000, 0], [4000, 4000], [3000, 4000]]]],
  land: [[[[0, 0], [3000, 0], [3000, 4000], [0, 4000]]]],
  riverSlice: null,
}

describe('assignZones', () => {
  it('is deterministic and assigns valid zones', () => {
    const a = assignZones(polys, params, dryTerrain)
    expect(a).toEqual(assignZones(polys, params, dryTerrain))
    for (const d of a) expect(ZONE_TYPES).toContain(d.zone)
  })
  it('ids follow geometric (y,x) order', () => {
    const shuffled = [...polys].reverse()
    const districts = assignZones(shuffled, params, dryTerrain)
    expect(districts.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
    )
    expect(districts[0].bounds).toEqual(rects[0])
  })
  it('no docks without coast', () => {
    for (const d of assignZones(polys, { ...params, corpDominance: 0 }, dryTerrain)) {
      expect(d.zone).not.toBe('docks')
    }
  })
  it('corp dominance shifts weights', () => {
    expect(zoneWeights({ ...params, corpDominance: 1 }, false).corp)
      .toBeGreaterThan(zoneWeights({ ...params, corpDominance: 0 }, false).corp)
    expect(zoneWeights({ ...params, corpDominance: 1 }, false).slum)
      .toBeLessThan(zoneWeights({ ...params, corpDominance: 0 }, false).slum)
  })
  it('no docks anywhere on dry terrain', () => {
    for (const d of assignZones(polys, params, dryTerrain)) expect(d.zone).not.toBe('docks')
  })
  it('docks only appear on shore districts; shore flag set', () => {
    const districts = assignZones(polys, { ...params, corpDominance: 0 }, eastWater)
    for (const d of districts) {
      if (d.zone === 'docks') expect(d.shore).toBe(true)
      const nearWater = d.bounds.x + d.bounds.w > 3000 - 150
      expect(d.shore).toBe(nearWater)
    }
  })

  it('assigns a deterministic irregularity in [0.05, 0.95] biased by zone', () => {
    const polys = Array.from({ length: 30 }, (_, i) =>
      rectPoly({ x: (i % 6) * 700, y: Math.floor(i / 6) * 700, w: 650, h: 650 }))
    const a = assignZones(polys, params, dryTerrain)
    const b = assignZones(polys, params, dryTerrain)
    expect(a).toEqual(b)
    for (const d of a) {
      expect(d.irregularity).toBeGreaterThanOrEqual(0.05)
      expect(d.irregularity).toBeLessThanOrEqual(0.95)
    }
    // zone bias visible in aggregate: mean slum irregularity > mean corp
    const mean = (zone: string) => {
      const ds = a.filter((d) => d.zone === zone)
      return ds.reduce((s, d) => s + d.irregularity, 0) / (ds.length || 1)
    }
    if (a.some((d) => d.zone === 'slum') && a.some((d) => d.zone === 'corp'))
      expect(mean('slum')).toBeGreaterThan(mean('corp'))
  })

  it('shifts irregularity with the params bias', () => {
    const polys = [rectPoly({ x: 0, y: 0, w: 800, h: 800 })]
    const low = assignZones(polys, { ...params, irregularity: 0 }, dryTerrain)[0]
    const high = assignZones(polys, { ...params, irregularity: 1 }, dryTerrain)[0]
    expect(high.irregularity).toBeGreaterThan(low.irregularity)
  })

  it('keeps bounds as the bbox of poly', () => {
    const poly = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 60, y: 120 }]
    const [d] = assignZones([poly], params, dryTerrain)
    expect(d.poly).toEqual(poly)
    expect(d.bounds).toEqual({ x: 10, y: 20, w: 100, h: 100 })
  })
})
