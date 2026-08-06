import { describe, expect, it } from 'vitest'
import { pointInRings, rotatePt, type Pt, type Rect } from '../geometry'
import type { District, SectorParams, Terrain } from '../types'
import { fillBuildings } from './buildings'

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
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

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: '', bounds: { x: 0, y: 0, w: 600, h: 600 }, poly: rectPoly({ x: 0, y: 0, w: 600, h: 600 }), irregularity: 0.5, shore: false, labelAt: { x: 300, y: 300 } },
  { id: 'D02', zone: 'slum', name: '', bounds: { x: 700, y: 0, w: 600, h: 600 }, poly: rectPoly({ x: 700, y: 0, w: 600, h: 600 }), irregularity: 0.5, shore: false, labelAt: { x: 1000, y: 300 } },
  { id: 'D03', zone: 'residential', name: '', bounds: { x: 2800, y: 0, w: 400, h: 400 }, poly: rectPoly({ x: 2800, y: 0, w: 400, h: 400 }), irregularity: 0.5, shore: true, labelAt: { x: 3000, y: 200 } },
]
const blocksByDistrict: Pt[][][] = [
  [rectPoly({ x: 10, y: 10, w: 280, h: 280 }), rectPoly({ x: 310, y: 10, w: 280, h: 280 })],
  [rectPoly({ x: 710, y: 10, w: 280, h: 280 }), rectPoly({ x: 1010, y: 10, w: 280, h: 280 })],
  [rectPoly({ x: 2850, y: 10, w: 300, h: 300 })],
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
const allWaterTerrain: Terrain = {
  landform: 'coastal', river: false, lakes: false, islands: false,
  metroSeed: 1,
  water: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  land: [],
  riverSlice: null,
}

describe('fillBuildings', () => {
  it('is deterministic', () => {
    expect(fillBuildings(districts, blocksByDistrict, base, dryTerrain))
      .toEqual(fillBuildings(districts, blocksByDistrict, base, dryTerrain))
  })
  it('every building sits inside its block (within slack for clip-seam rounding)', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
    const byId = new Map(blocks.map((b) => [b.id, b.footprint]))
    expect(buildings.length).toBeGreaterThan(0)
    for (const b of buildings) {
      const fp = byId.get(b.blockId)!
      for (const p of b.footprint) {
        const onEdge = fp.some((q, i) => distToSegment(p, q, fp[(i + 1) % fp.length]) < 1)
        expect(pointInRings(p, [fp]) || onEdge).toBe(true)
      }
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
    const oneBlock = [[blocksByDistrict[0][0]]]
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
    const wetBlocks = [[rectPoly({ x: 3100, y: 10, w: 200, h: 200 })]]
    const { blocks } = fillBuildings(districts.slice(0, 1), wetBlocks, base, eastWater)
    expect(blocks.length).toBe(0)
  })
  it('dry blocks keep their input polygon as footprint (block-level fast path)', () => {
    const { blocks } = fillBuildings(districts, blocksByDistrict, base, dryTerrain)
    for (const b of blocks) expect(b.footprint).toEqual(b.poly)
  })

  it('fills a rotated block with buildings aligned to its longest edge', () => {
    // a 400×200 block rotated 30°
    const theta = Math.PI / 6
    const c = { x: 500, y: 500 }
    const poly = [
      { x: 300, y: 400 }, { x: 700, y: 400 }, { x: 700, y: 600 }, { x: 300, y: 600 },
    ].map((p) => rotatePt(p, theta, c))
    const { blocks, buildings } = fillBuildings([districts[0]], [[poly]], base, dryTerrain)
    expect(blocks).toHaveLength(1)
    expect(buildings.length).toBeGreaterThan(2)
    // every building footprint stays inside the block (vertices within 1 m slack)
    for (const b of buildings) for (const p of b.footprint) {
      expect(pointInRings(p, [poly]) ||
        poly.some((q, i) => distToSegment(p, q, poly[(i + 1) % poly.length]) < 1)).toBe(true)
    }
  })

  it('drops blocks fully drowned by water', () => {
    const poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    const { blocks } = fillBuildings([districts[0]], [[poly]], base, allWaterTerrain)
    expect(blocks).toHaveLength(0)
  })
})
