import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import type { SectorParams } from '../types'
import { genGeography } from './geography'
import { coastClipX, layoutRoads } from './roads'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000
const noWater = genGeography(base, sizeM)

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
  it('coast keeps all districts on land, clipped at the mean coastline', () => {
    const water = genGeography({ ...base, coast: true }, sizeM)
    const r = layoutRoads({ ...base, coast: true }, water, sizeM)
    const clipX = coastClipX(water, sizeM)
    for (const d of r.districtRects) {
      expect(d.x + d.w).toBeLessThanOrEqual(clipX + 1e-9)
    }
  })
  it('river splits land into slabs above and below', () => {
    const water = genGeography({ ...base, river: true }, sizeM)
    const r = layoutRoads({ ...base, river: true }, water, sizeM)
    const above = r.districtRects.some((d: Rect) => d.y + d.h <= water.bounds!.y + 1e-9)
    const below = r.districtRects.some((d: Rect) => d.y >= water.bounds!.y + water.bounds!.h - 1e-9)
    expect(above && below).toBe(true)
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
