import { describe, expect, it } from 'vitest'
import { pointInRings } from '../geometry'
import type { District, SectorParams, Terrain } from '../types'
import { placePiers } from './piers'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'coastal', river: false, lakes: false, islands: false, piers: true, pack: 'generic', theme: 'neon',
}
const eastWater: Terrain = {
  landform: 'coastal', river: false, lakes: false, islands: false, metroSeed: 1,
  water: [[[[3000, 0], [4000, 0], [4000, 4000], [3000, 4000]]]],
  land: [[[[0, 0], [3000, 0], [3000, 4000], [0, 4000]]]],
  riverSlice: null,
}
const docksDistrict: District = {
  id: 'D01', zone: 'docks', name: 'The Docks', shore: true,
  bounds: { x: 2500, y: 1000, w: 500, h: 800 },
  labelAt: { x: 2750, y: 1400 },
}
const waterRings = eastWater.water.map((poly) => poly.map((r) => r.map(([x, y]) => ({ x, y }))))
const inWater = (p: { x: number; y: number }) => waterRings.some((rings) => pointInRings(p, rings))

describe('placePiers', () => {
  it('returns [] when the piers flag is off', () => {
    expect(placePiers([docksDistrict], eastWater, { ...base, piers: false })).toEqual([])
  })
  it('places piers rooted on land, ending in water, spaced apart', () => {
    const piers = placePiers([docksDistrict], eastWater, base)
    expect(piers.length).toBeGreaterThanOrEqual(1)
    for (const pier of piers) {
      expect(inWater(pier.points[0])).toBe(false)
      expect(inWater(pier.points[1])).toBe(true)
    }
    for (let i = 0; i < piers.length; i++)
      for (let j = i + 1; j < piers.length; j++) {
        const a = piers[i].points[0]
        const b = piers[j].points[0]
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(40)
      }
  })
  it('no piers for non-docks districts', () => {
    expect(placePiers([{ ...docksDistrict, zone: 'corp' }], eastWater, base)).toEqual([])
  })
  it('is deterministic', () => {
    expect(placePiers([docksDistrict], eastWater, base))
      .toEqual(placePiers([docksDistrict], eastWater, base))
  })
})
