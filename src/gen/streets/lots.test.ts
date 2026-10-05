import polygonClipping from 'polygon-clipping'
import { describe, expect, it, vi } from 'vitest'
import { pointInRings, ringArea, ringCentroid, type Pt } from '../geometry'
import type { Block, District, SectorParams, Terrain } from '../types'
import { generateSector } from '../sector/generate'
import { SIDEWALK, corridorRects, fillLots as fillLotsFull, insetByClipping, insetRing } from './lots'

// pre-style tests assumed BSP rows everywhere, so the shared helper forces 'rows'
const fillLots = (...a: Parameters<typeof fillLotsFull>) => fillLotsFull(a[0], a[1], a[2], a[3], a[4], 'rows').buildings

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
const slumDistrict: District = { ...corpDistrict, id: 'D02', zone: 'slum' }

const makeBlock = (districtId: string, id = 'B0001'): Block => ({
  id,
  districtId,
  poly: rectPoly(0, 0, 120, 120),
  footprint: rectPoly(0, 0, 120, 120),
  style: 'rows', alleys: [],
  flags: {},
})

const resDistrict: District = { ...corpDistrict, id: 'D04', zone: 'residential' }
const bigBlock = (districtId: string, x = 0, y = 0): Block => ({
  ...makeBlock(districtId), poly: rectPoly(x, y, 200, 200), footprint: rectPoly(x, y, 200, 200),
})

describe('block styles', () => {
  it('styles follow zone and density', () => {
    const industrial: District = { ...corpDistrict, id: 'D03', zone: 'industrial' }
    expect(fillLotsFull([industrial], [bigBlock('D03')], base, dryTerrain, []).blocks[0].style).toBe('sheds')
    expect(fillLotsFull([corpDistrict], [bigBlock('D01')], { ...base, density: 0.1 }, dryTerrain, []).blocks[0].style).toBe('plaza')
    const blocks = Array.from({ length: 20 }, (_, i) => bigBlock('D04', i * 700, (i % 3) * 900))
    const styles = fillLotsFull([resDistrict], blocks, { ...base, density: 0.9 }, dryTerrain, []).blocks.map((b) => b.style)
    expect(styles.filter((s) => s === 'rows').length).toBeGreaterThan(styles.length / 2)
  })
  it('courtyard blocks keep their middle empty', () => {
    const out = fillLotsFull([resDistrict], [bigBlock('D04')], base, dryTerrain, [], 'courtyard')
    expect(out.buildings.length).toBeGreaterThan(0)
    for (const b of out.buildings) for (const p of b.footprint) expect(Math.hypot(p.x - 100, p.y - 100)).toBeGreaterThan(30)
  })
  it('plaza blocks have at most three buildings', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const out = fillLotsFull([resDistrict], [bigBlock('D04')], { ...base, seed }, dryTerrain, [], 'plaza')
      expect(out.buildings.length).toBeLessThanOrEqual(3)
    }
  })
  it('notched lots are concave', () => {
    let notched = 0
    for (let seed = 1; seed <= 40; seed++) {
      const out = fillLotsFull([resDistrict], [bigBlock('D04')], { ...base, seed }, dryTerrain, [], 'plaza')
      notched += out.buildings.filter((b) => b.footprint.length >= 6).length
    }
    expect(notched).toBeGreaterThan(0)
  })
  it('sheds stay rectangles', () => {
    for (let seed = 1; seed <= 20; seed++)
      for (const b of fillLotsFull([resDistrict], [bigBlock('D04')], { ...base, seed }, dryTerrain, [], 'sheds').buildings)
        expect(b.footprint.length).toBe(4)
  })
  it('alleys stay inside the block inset', () => {
    // an L-shaped (concave) rows block: a bbox-spanning cut would poke out of the notch
    const ring = [{x:0,y:0},{x:240,y:0},{x:240,y:120},{x:120,y:120},{x:120,y:240},{x:0,y:240}]
    const block: Block = { ...makeBlock('D04'), poly: ring, footprint: ring }
    const out = fillLotsFull([resDistrict], [block], base, dryTerrain, [], 'rows')
    const inset = insetRing(ring, 6)!
    expect(out.blocks[0].alleys.length).toBeGreaterThan(0)
    const nearRing = (p: Pt) => {
      let d = Infinity
      for (let i = 0; i < inset.length; i++) {
        const a = inset[i], b = inset[(i + 1) % inset.length]
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2))
        d = Math.min(d, Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))))
      }
      return d
    }
    for (const [a, b] of out.blocks[0].alleys) {
      for (const p of [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
        expect(pointInRings(p, [inset]) || nearRing(p) < 0.5).toBe(true)
      }
    }
  })

  it('rows blocks carry alleys and other styles do not', () => {
    const alleys = (style: 'rows' | 'courtyard' | 'plaza' | 'sheds') =>
      fillLotsFull([resDistrict], [bigBlock('D04')], base, dryTerrain, [], style).blocks[0].alleys.length
    expect(alleys('rows')).toBeGreaterThan(0)
    for (const s of ['courtyard', 'plaza', 'sheds'] as const) expect(alleys(s)).toBe(0)
  })
})

describe('road strips', () => {
  it('lots never overlap a road strip', () => {
    const block: Block = { ...makeBlock('D01'), poly: rectPoly(0, 0, 200, 200), footprint: rectPoly(0, 0, 200, 200) }
    const street = [{ x: 0, y: 100 }, { x: 100, y: 108 }, { x: 200, y: 100 }]
    const strips = corridorRects(street, 4.5 + 6)
    const buildings = fillLots([corpDistrict], [block], base, dryTerrain, strips)
    expect(buildings.length).toBeGreaterThan(0)
    for (const b of buildings) for (const p of b.footprint)
      for (let i = 1; i < street.length; i++) expect(distToSegment(p, street[i - 1], street[i])).toBeGreaterThanOrEqual(10.5 - 0.01)
  })
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

  it('insetRing rejects a ring thinner than the inset', () => {
    expect(insetRing([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 4 }], 6)).toBeNull()
  })

  it('insetRing handles a clockwise ring', () => {
    const ccw = insetRing(rectPoly(0, 0, 100, 100), 6)!
    const cw = insetRing(rectPoly(0, 0, 100, 100).reverse(), 6)!
    expect(cw).not.toBeNull()
    expect(Math.abs(ringArea(cw))).toBeCloseTo(Math.abs(ringArea(ccw)))
  })
})

describe('fillLots', () => {
  it('fillLots yields nothing outside a thin block', () => {
    const thin: Block = { ...makeBlock('D01'), footprint: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 4 }] }
    expect(fillLots([corpDistrict], [thin], base, dryTerrain, [])).toEqual([])
  })

  it('density changes lot count', () => {
    const count = (density: number) =>
      fillLots([slumDistrict], [makeBlock('D02')], { ...base, density }, dryTerrain, []).length
    expect(count(0.9)).toBeGreaterThan(count(0.1))
  })
  it('lots vary in size', () => {
    const district: District = { ...corpDistrict, zone: 'residential', bounds: { x: 0, y: 0, w: 300, h: 300 }, poly: rectPoly(0, 0, 300, 300) }
    const block: Block = { ...makeBlock('D01'), poly: rectPoly(0, 0, 240, 240), footprint: rectPoly(0, 0, 240, 240) }
    const areas = fillLots([district], [block], base, dryTerrain, []).map((b) => Math.abs(ringArea(b.footprint)))
    expect(new Set(areas.map(Math.round)).size).toBeGreaterThanOrEqual(4)
    expect(Math.max(...areas) / Math.min(...areas)).toBeGreaterThanOrEqual(2)
  })

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

  it('concave block never gets an unclipped lot across its notch', () => {
    // U shape: 200x200 with an 80 m deep, 40 m wide notch cut from the bottom;
    // the 80 m industrial grid puts a lot's corners either side of the notch
    const u: Pt[] = [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 140, y: 200 },
      { x: 140, y: 120 }, { x: 100, y: 120 }, { x: 100, y: 200 }, { x: 0, y: 200 },
    ]
    const block: Block = { id: 'B0001', districtId: 'D03', poly: u, footprint: u, style: 'rows', alleys: [], flags: {} }
    const industrial: District = { ...corpDistrict, id: 'D03', zone: 'industrial' }
    const inset = insetRing(u, 6)!
    const buildings = fillLots([industrial], [block], base, dryTerrain, [])
    expect(buildings.length).toBeGreaterThan(0)
    for (const bld of buildings) {
      const f = bld.footprint
      for (let i = 0; i < f.length; i++) {
        const q = f[(i + 1) % f.length]
        const mid = { x: (f[i].x + q.x) / 2, y: (f[i].y + q.y) / 2 }
        expect(insideOrOnEdge(f[i], inset)).toBe(true)
        expect(insideOrOnEdge(mid, inset)).toBe(true)
      }
    }
  })

  it('concave U block gets buildings via the clipping inset', () => {
    const u: Pt[] = [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 120, y: 200 },
      { x: 120, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 200 }, { x: 0, y: 200 },
    ]
    const block: Block = { id: 'B0001', districtId: 'D03', poly: u, footprint: u, style: 'rows', alleys: [], flags: {} }
    const industrial: District = { ...corpDistrict, id: 'D03', zone: 'industrial' }
    const buildings = fillLots([industrial], [block], base, dryTerrain, [])
    expect(buildings.length).toBeGreaterThan(0)
    for (const bld of buildings) for (const p of bld.footprint) expect(insideOrOnEdge(p, u, 1e-3)).toBe(true)
  })

  it('insetByClipping shrinks a square by the inset on every side', () => {
    const rings = insetByClipping(rectPoly(0, 0, 100, 100), 6)
    expect(rings.length).toBe(1)
    expect(Math.abs(ringArea(rings[0]))).toBeCloseTo(88 * 88, 0)
  })

  it('a clipping failure drops the lot instead of throwing', () => {
    const block = makeBlock('D01') // corp 60 m cells on a 108 m inset: straddling lots need clipping
    const clean = fillLots([corpDistrict], [block], base, dryTerrain, [])
    const spy = vi.spyOn(polygonClipping, 'intersection')
    // first clipped lot fails on the initial try and all three epsilon retries
    for (let i = 0; i < 4; i++) spy.mockImplementationOnce(() => { throw new Error('Unable to complete output ring') })
    try {
      const hit = fillLots([corpDistrict], [block], base, dryTerrain, [])
      expect(hit.length).toBe(clean.length - 1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('landmark blocks', () => {
  // 4 km generates are slow: one model per seed, shared across the its
  const arc = generateSector({ ...base, seed: 42, size: 4, corpDominance: 0.85, landform: 'inland' })
  const mega = generateSector({ ...base, seed: 7, size: 4, corpDominance: 0.15, landform: 'bay' })
  it('arcology blocks have no buildings', () => {
    const flagged = arc.blocks.filter((b) => b.flags.arcology)
    expect(flagged.length).toBeGreaterThan(0)
    for (const b of flagged) {
      expect(b.alleys).toEqual([])
      expect(arc.buildings.filter((x) => x.blockId === b.id)).toEqual([])
    }
  })
  it('a megablock block is one hive of packed cells', () => {
    expect(mega.megablocks.length).toBeGreaterThan(0)
    for (const m of mega.megablocks) {
      const block = mega.blocks.find((b) => b.flags.megablock === m.id)!
      expect(block.style).toBe('megablock')
      expect(m.footprint.length).toBeGreaterThanOrEqual(3)
      expect(block.alleys.length).toBeGreaterThanOrEqual(1)
      const hive = mega.buildings.filter((x) => x.blockId === block.id)
      expect(hive.length).toBeGreaterThanOrEqual(6)
      for (const b of hive) {
        expect(pointInRings(ringCentroid(b.footprint), [m.footprint])).toBe(true)
        const a = Math.abs(ringArea(b.footprint))
        expect(a).toBeGreaterThanOrEqual(40)
        expect(a).toBeLessThanOrEqual(4000) // BSP bound (2 * minCell + gap)^2 = 3844
      }
    }
  })
  it('megablock footprint hugs its streets', () => {
    for (const m of mega.megablocks) {
      const block = mega.blocks.find((b) => b.flags.megablock === m.id)!
      for (const p of m.footprint) expect(insideOrOnEdge(p, block.footprint, SIDEWALK + 2)).toBe(true)
    }
  })
})
