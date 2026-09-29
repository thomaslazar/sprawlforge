import { describe, expect, it } from 'vitest'
import { pointInRings, type Pt } from '../geometry'
import type { Block, District, SectorParams, Terrain } from '../types'
import { fillLots, insetRing } from './lots'

const rectPoly = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

/** distance from point p to segment ab */
const distToSegment = (p: Pt, a: Pt, b: Pt): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  const cx = a.x + t * abx
  const cy = a.y + t * aby
  return Math.hypot(p.x - cx, p.y - cy)
}

/** point inside (or within slack of) a ring's boundary */
const insideOrOnEdge = (p: Pt, ring: Pt[], slack = 0.5): boolean =>
  pointInRings(p, [ring]) || ring.some((q, i) => distToSegment(p, q, ring[(i + 1) % ring.length]) < slack)

/** strictly inside a ring — a clip seam vertex sitting on the boundary doesn't count */
const strictlyInside = (p: Pt, ring: Pt[], slack = 0.5): boolean =>
  pointInRings(p, [ring]) && ring.every((q, i) => distToSegment(p, q, ring[(i + 1) % ring.length]) >= slack)

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}

const dryTerrain: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 0,
  water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  riverSlice: null,
}

const corpDistrict: District = {
  id: 'D01', zone: 'corp', name: '', bounds: { x: 0, y: 0, w: 400, h: 400 },
  poly: rectPoly(0, 0, 400, 400), shore: false, irregularity: 0.5, labelAt: { x: 200, y: 200 }, flags: {},
}
const slumDistrict: District = { ...corpDistrict, id: 'D02', zone: 'slum' }

const makeBlock = (districtId: string, id = 'B0001'): Block => ({
  id,
  districtId,
  poly: rectPoly(0, 0, 120, 120),
  footprint: rectPoly(0, 0, 120, 120),
  flags: {},
})

describe('insetRing', () => {
  it('inset of a square shrinks by d on every side', () => {
    const square = rectPoly(0, 0, 100, 100)
    const inset = insetRing(square, 6)
    expect(inset).not.toBeNull()
    const xs = inset!.map((p) => p.x)
    const ys = inset!.map((p) => p.y)
    expect(Math.min(...xs)).toBeCloseTo(6)
    expect(Math.max(...xs)).toBeCloseTo(94)
    expect(Math.min(...ys)).toBeCloseTo(6)
    expect(Math.max(...ys)).toBeCloseTo(94)
  })
})

describe('fillLots', () => {
  it('lots stay inside the block footprint', () => {
    const block = makeBlock('D01')
    const buildings = fillLots([corpDistrict], [block], base, dryTerrain, [])
    expect(buildings.length).toBeGreaterThan(0)
    for (const bld of buildings) {
      for (const p of bld.footprint) {
        expect(insideOrOnEdge(p, block.footprint)).toBe(true)
      }
    }
  })

  it('lots avoid the no-build strip', () => {
    const block = makeBlock('D01')
    const strip = rectPoly(-10, 50, 140, 20) // crosses the block horizontally
    const buildings = fillLots([corpDistrict], [block], base, dryTerrain, [strip])
    expect(buildings.length).toBeGreaterThan(0)
    for (const bld of buildings) {
      for (const p of bld.footprint) {
        expect(strictlyInside(p, strip)).toBe(false)
      }
    }
  })

  it('lot count scales with zone minCell', () => {
    const corpBlock = makeBlock('D01')
    const slumBlock = makeBlock('D02')
    const corpCount = fillLots([corpDistrict], [corpBlock], base, dryTerrain, []).length
    const slumCount = fillLots([slumDistrict], [slumBlock], base, dryTerrain, []).length
    expect(slumCount).toBeGreaterThan(corpCount)
  })

  it('is deterministic', () => {
    const block = makeBlock('D01')
    const a = fillLots([corpDistrict], [block], base, dryTerrain, [])
    const b = fillLots([corpDistrict], [block], base, dryTerrain, [])
    expect(a).toEqual(b)
  })

  it('keeps the block id chain', () => {
    const block = makeBlock('D01')
    const buildings = fillLots([corpDistrict], [block], base, dryTerrain, [])
    expect(buildings.length).toBeGreaterThan(0)
    for (const bld of buildings) {
      expect(bld.blockId).toBe(block.id)
      expect(bld.districtId).toBe(block.districtId)
    }
  })
})
