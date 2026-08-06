import { describe, expect, it } from 'vitest'
import type { Pt, Rect } from '../geometry'
import type { District, SectorParams, Terrain } from '../types'
import { fillBuildings } from './buildings'

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: '', bounds: { x: 0, y: 0, w: 600, h: 600 }, poly: rectPoly({ x: 0, y: 0, w: 600, h: 600 }), irregularity: 0.5, shore: false, labelAt: { x: 300, y: 300 } },
  { id: 'D02', zone: 'slum', name: '', bounds: { x: 700, y: 0, w: 600, h: 600 }, poly: rectPoly({ x: 700, y: 0, w: 600, h: 600 }), irregularity: 0.5, shore: false, labelAt: { x: 1000, y: 300 } },
  { id: 'D03', zone: 'residential', name: '', bounds: { x: 2800, y: 0, w: 400, h: 400 }, poly: rectPoly({ x: 2800, y: 0, w: 400, h: 400 }), irregularity: 0.5, shore: true, labelAt: { x: 3000, y: 200 } },
]
const blocksByDistrict: Rect[][] = [
  [{ x: 10, y: 10, w: 280, h: 280 }, { x: 310, y: 10, w: 280, h: 280 }],
  [{ x: 710, y: 10, w: 280, h: 280 }, { x: 1010, y: 10, w: 280, h: 280 }],
  [{ x: 2850, y: 10, w: 300, h: 300 }],
]
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

describe('fillBuildings', () => {
  it('is deterministic', () => {
    expect(fillBuildings(districts, blocksByDistrict, base, dryTerrain))
      .toEqual(fillBuildings(districts, blocksByDistrict, base, dryTerrain))
  })
  it('every building sits inside its block', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
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
    const { buildings } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
    const corp = buildings.filter((b) => b.districtId === 'D01').length
    const slum = buildings.filter((b) => b.districtId === 'D02').length
    expect(slum).toBeGreaterThan(corp)
  })
  it('block and building ids encode district and block ordinals', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
    expect(blocks[0].id).toBe('B0101')
    expect(blocks.every((b) => /^B\d{4}$/.test(b.id))).toBe(true)
    expect(buildings.every((b) => /^BLD\d{6}$/.test(b.id))).toBe(true)
  })
  it('density knob raises building count', () => {
    const lo = fillBuildings(districts, blocksByDistrict, { ...base, density: 0 }, dryTerrain).buildings.length
    const hi = fillBuildings(districts, blocksByDistrict, { ...base, density: 1 }, dryTerrain).buildings.length
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
  it('shore districts get a density bonus (capped at 1)', () => {
    const shoreDistrict: District = { ...districts[0], shore: true }
    const plainDistrict: District = { ...districts[0], shore: false }
    const oneBlock: Rect[][] = [[blocksByDistrict[0][0]]]
    const withBonus = fillBuildings([shoreDistrict], oneBlock, base, dryTerrain).buildings.length
    const without = fillBuildings([plainDistrict], oneBlock, base, dryTerrain).buildings.length
    expect(withBonus).toBeGreaterThanOrEqual(without)
  })

  it('buildings never extend into water', () => {
    const { buildings } = fillBuildings(districts, blocksByDistrict, base, eastWater)
    for (const b of buildings)
      for (const p of b.footprint) expect(p.x).toBeLessThanOrEqual(3000 + 1)
  })
  it('fully-drowned blocks are dropped', () => {
    const wetBlocks = [[{ x: 3100, y: 10, w: 200, h: 200 }]]
    const { blocks } = fillBuildings(districts.slice(0, 1), wetBlocks, base, eastWater)
    expect(blocks.length).toBe(0)
  })
  it('dry blocks keep rectangular footprints (fast path)', () => {
    const { buildings } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
    for (const b of buildings) expect(b.footprint.length).toBe(4)
  })
})
