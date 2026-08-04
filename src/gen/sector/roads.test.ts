import { describe, expect, it } from 'vitest'
import { sampleTerrain } from '../terrain'
import type { SectorParams } from '../types'
import { layoutRoads } from './roads'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000
const noWater = sampleTerrain(base, sizeM)

function landBounds(terrain: ReturnType<typeof sampleTerrain>) {
  const pts = terrain.land.flat().flat()
  return {
    minX: Math.min(...pts.map(([x]) => x)),
    minY: Math.min(...pts.map(([, y]) => y)),
    maxX: Math.max(...pts.map(([x]) => x)),
    maxY: Math.max(...pts.map(([, y]) => y)),
  }
}

describe('layoutRoads', () => {
  it('is deterministic', () => {
    expect(layoutRoads(base, noWater, sizeM)).toEqual(layoutRoads(base, noWater, sizeM))
  })
  it('produces districts, blocks and all three road classes', () => {
    const r = layoutRoads(base, noWater, sizeM)
    expect(r.districtRects.length).toBeGreaterThanOrEqual(4)
    expect(r.blocksByDistrict.length).toBe(r.districtRects.length)
    expect(r.blocksByDistrict.flat().length).toBeGreaterThan(r.districtRects.length)
    const classes = new Set(r.roads.map((x) => x.class))
    expect(classes).toEqual(new Set(['highway', 'arterial', 'street']))
  })
  it('higher density gives more blocks', () => {
    const lo = layoutRoads({ ...base, density: 0.1 }, noWater, sizeM).blocksByDistrict.flat().length
    const hi = layoutRoads({ ...base, density: 0.9 }, noWater, sizeM).blocksByDistrict.flat().length
    expect(hi).toBeGreaterThan(lo)
  })
  it('coast keeps all districts within the land bounding box', () => {
    const terrain = sampleTerrain({ ...base, terrain: 'coastal' }, sizeM)
    const r = layoutRoads({ ...base, terrain: 'coastal' }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('river keeps all districts within the land bounding box', () => {
    const terrain = sampleTerrain({ ...base, terrain: 'river' }, sizeM)
    const r = layoutRoads({ ...base, terrain: 'river' }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('road ids are stable and prefixed by class', () => {
    const r = layoutRoads(base, noWater, sizeM)
    for (const road of r.roads) {
      if (road.class === 'highway') expect(road.id).toMatch(/^H\d+$/)
      if (road.class === 'arterial') expect(road.id).toMatch(/^A\d\d$/)
      if (road.class === 'street') expect(road.id).toMatch(/^S\d\d\d$/)
    }
  })
})
