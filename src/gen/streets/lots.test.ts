import { describe, expect, it } from 'vitest'
import { ringArea, ringCentroid, type Pt } from '../geometry'
import type { Block, District, Road, SectorParams, Terrain } from '../types'
import { selectCompounds } from '../landmarks/compounds'
import { generateSector } from '../sector/generate'
import { FRONTAGE_OFF, STRIP_HALF } from './highway'
import { distToPolyline } from '../terrain/rivers'
import { insetByClipping, insetRing, isLandmarkBlock, isStripBlock } from './lots'

const rectPoly = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
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

const makeBlock = (districtId: string, id = 'B0001'): Block => ({
  id,
  districtId,
  poly: rectPoly(0, 0, 120, 120),
  footprint: rectPoly(0, 0, 120, 120),
  style: 'rows', alleys: [],
  flags: {},
})

const SEED7_RING: Pt[] = ([[0,1236.214],[40.834,1239.875],[70.225,1245.833],[156.112,1272.689],[377.551,1334.838],[386.232,1336.995],[371.77,1366.376],[312.109,1349.64],[120.57,1295.913],[120.778,1295.168],[102.466,1290.505],[0,1264.41],[96.382,1283.786],[95.146,1288.641],[89.705,1287.255],[102.466,1290.505],[95.146,1288.641],[96.382,1283.786],[0,1264.41]] as Array<[number, number]>).map(([x, y]) => ({ x, y }))

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

  it('insetRing rejects a ring thinner than the inset', () => {
    expect(insetRing([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 4 }], 6)).toBeNull()
  })

  it('insetRing rejects an offset that folds over itself', () => {
    // seed 4280430344 coastal+river+lakes 4 km: this courtyard inset has every vertex inside the ring yet
    // self-crosses; polygon-clipping took > 10 min on it. Guard is structural (no wall clock).
    const ring = ([[3116.32, 1516.05], [3118.87, 1487.67], [3127.8, 1460.39], [3141.89, 1435.0], [3173.79, 1390.7], [3226.63, 1416.48], [3215.17, 1438.6], [3214.24, 1438.31], [3212.61, 1443.54], [3210.09, 1448.4], [3210.96, 1448.84], [3208.05, 1458.17], [3207.25, 1458.04], [3206.37, 1463.54], [3204.72, 1468.85], [3205.49, 1469.09], [3203.93, 1478.94], [3202.75, 1479.01], [3203.07, 1484.35], [3202.23, 1489.63], [3203.39, 1489.82], [3204.6, 1510.24], [3203.29, 1510.67], [3204.92, 1515.63], [3205.23, 1520.84], [3206.61, 1520.76], [3296.9, 1795.67], [3212.81, 1823.27], [3130.14, 1572.66], [3119.24, 1534.69]] as Array<[number, number]>).map(([x, y]) => ({ x, y }))
    expect(insetRing(ring, 19.81)).toBeNull()
  })

  it('insetRing handles a clockwise ring', () => {
    const ccw = insetRing(rectPoly(0, 0, 100, 100), 6)!
    const cw = insetRing(rectPoly(0, 0, 100, 100).reverse(), 6)!
    expect(cw).not.toBeNull()
    expect(Math.abs(ringArea(cw))).toBeCloseTo(Math.abs(ringArea(ccw)))
  })
})

describe('insetByClipping', () => {
  it('insetByClipping shrinks a square by the inset on every side', () => {
    const rings = insetByClipping(rectPoly(0, 0, 100, 100), 6)
    expect(rings.length).toBe(1)
    expect(Math.abs(ringArea(rings[0]))).toBeCloseTo(88 * 88, 0)
  })

  it('insetByClipping terminates on the seed-7 face', () => {
    expect(insetByClipping(SEED7_RING, 6).length).toBeGreaterThanOrEqual(1)
  })
})
describe('isStripBlock', () => {
  const road = (id: string, y: number, cls: Road['class']): Road => ({ id, class: cls, points: [{ x: 0, y }, { x: 1000, y }], width: 9, name: null })
  const hw = road('H1', 0, 'highway')
  const fr = [road('F1', FRONTAGE_OFF, 'street')]
  const blockOf = (footprint: Pt[]): Block => ({ ...makeBlock('D01'), poly: footprint, footprint })
  it('a band from the highway to its frontage road is a strip however its centroid falls', () => {
    // wedge: most of the area hugs the highway, so its centroid sits inside STRIP_HALF; every vertex is within FRONTAGE_OFF
    const wedge = blockOf([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: FRONTAGE_OFF }, { x: 900, y: FRONTAGE_OFF }, { x: 0, y: 10 }])
    expect(distToPolyline(ringCentroid(wedge.footprint), hw.points)).toBeLessThan(STRIP_HALF)
    expect(isStripBlock(wedge, hw, fr)).toBe(true)
  })
  it('a far-side block with a dense near edge is not a strip', () => {
    // 10 vertices along the frontage road, 2 a full block-depth further out: vertex count must not decide
    const pts: Pt[] = []
    for (let i = 0; i <= 9; i++) pts.push({ x: i * 100, y: FRONTAGE_OFF })
    pts.push({ x: 1000, y: FRONTAGE_OFF + 60 }, { x: 0, y: FRONTAGE_OFF + 60 })
    expect(isStripBlock(blockOf(pts), hw, fr)).toBe(false)
  })
  it('a block on the far side of the frontage road is not a strip', () => {
    expect(isStripBlock(blockOf(rectPoly(0, FRONTAGE_OFF, 1000, 100)), hw, fr)).toBe(false)
  })
})

describe('compounds', () => {
  const m = generateSector({ ...base, seed: 42, size: 4, corpDominance: 0.85, landform: 'inland' })
  it('compounds never sit on strip or landmark blocks', () => {
    const hw = m.roads.find((r) => r.class === 'highway')
    const fr = m.roads.filter((r) => r.id.startsWith('F'))
    for (const c of m.compounds) {
      const b = { ...m.blocks.find((x) => x.id === c.blockId)!, flags: {} }
      expect(isLandmarkBlock(b, { arcologies: m.arcologies, megablocks: m.megablocks })).toBe(false)
      expect(isStripBlock(b, hw, fr)).toBe(false)
    }
  })
})

describe('selectCompounds', () => {
  it('selectCompounds skips strip blocks and megablock blocks', () => {
    const big = (id: string): Block => ({ ...makeBlock('D01', id), poly: rectPoly(0, 0, 200, 200), footprint: rectPoly(0, 0, 200, 200) })
    const params = { ...base, corpDominance: 1 }
    // find a seed whose draw hits so the exclusions are what keeps the list empty
    let seed = 0
    while (selectCompounds([corpDistrict], [big('B1')], { ...params, seed }, dryTerrain, () => false, []).length === 0) seed++
    const p = { ...params, seed }
    expect(selectCompounds([corpDistrict], [big('B1')], p, dryTerrain, () => true, [])).toEqual([])
    const lm = { arcologies: [], megablocks: [{ id: 'M01', name: '', center: { x: 100, y: 100 }, core: [], footprint: [] }] }
    expect(selectCompounds([corpDistrict], [big('B1')], p, dryTerrain, () => false, [], lm)).toEqual([])
  })
})
