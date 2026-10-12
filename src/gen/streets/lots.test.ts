import { describe, expect, it } from 'vitest'
import { pointInRings, ringArea, ringCentroid, type Pt } from '../geometry'
import type { Block, District, Road, SectorParams, Terrain } from '../types'
import { selectCompounds } from '../landmarks/compounds'
import { generateSector } from '../sector/generate'
import { FRONTAGE_OFF, STRIP_HALF } from './highway'
import { distToPolyline } from '../terrain/rivers'
import { SIDEWALK, corridorRects, fillLots as fillLotsFull, insetByClipping, insetRing, isLandmarkBlock, isStripBlock } from './lots'

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

const SEED7_RING: Pt[] = ([[0,1236.214],[40.834,1239.875],[70.225,1245.833],[156.112,1272.689],[377.551,1334.838],[386.232,1336.995],[371.77,1366.376],[312.109,1349.64],[120.57,1295.913],[120.778,1295.168],[102.466,1290.505],[0,1264.41],[96.382,1283.786],[95.146,1288.641],[89.705,1287.255],[102.466,1290.505],[95.146,1288.641],[96.382,1283.786],[0,1264.41]] as Array<[number, number]>).map(([x, y]) => ({ x, y }))

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

  it('insetByClipping terminates on the seed-7 face', () => {
    expect(insetByClipping(SEED7_RING, 6).length).toBeGreaterThanOrEqual(1)
  })
})

describe('landmark blocks', () => {
  // 4 km generates are slow: one model per seed, shared across the its
  const arc = generateSector({ ...base, seed: 7, size: 4, corpDominance: 0.85, landform: 'inland' })
  const mega = generateSector({ ...base, seed: 7, size: 4, corpDominance: 0.15, landform: 'bay' })
  it('arcology blocks have no buildings', () => {
    // ring arcologies only: a half/boulevard/embedded one keeps its block's lots (seed 7 4 km corp 0.85: ring)
    const flagged = arc.blocks.filter((b) => b.flags.arcology && arc.arcologies.find((a) => a.id === b.flags.arcology)!.access === 'ring')
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

describe('strip blocks', () => {
  // the test needs a sunken stretch: seed 15 lost it at v9, seed 12 in the 7b stabilisation (no sunken segment left); seed 3 has one (seed 1 has one, but a 2-lot strip block)
  const m = generateSector({ ...base, seed: 3, size: 4, landform: 'coastal', river: true })
  it('strip blocks are packed with narrow lots facing the highway', { timeout: 120000 }, () => {
    const hws = m.roads.filter((r) => r.class === 'highway')
    const dHw = (p: Pt) => Math.min(...hws.map((r) => distToPolyline(p, r.points)))
    const fr = m.roads.filter((r) => r.id.startsWith('F'))
    const nearHw = m.blocks.filter((b) => {
      const d = dHw(ringCentroid(b.footprint))
      return d <= FRONTAGE_OFF + 1 && d > STRIP_HALF && !b.flags.arcology && !b.flags.megablock
    })
    const hasFr = (b: Block) => fr.some((f) => distToPolyline(ringCentroid(b.footprint), f.points) <= FRONTAGE_OFF + 10)
    // a band whose far end overshoots the frontage road by > 10 m is an ordinary block
    const near = nearHw.filter(hasFr).filter((b) => Math.max(...b.footprint.map(dHw)) <= FRONTAGE_OFF + 10)
    expect(near.length).toBeGreaterThan(0)
    // beside a sunken stretch there is no frontage road: those blocks keep their normal style
    const sunken = nearHw.filter((b) => !hasFr(b))
    expect(sunken.length).toBeGreaterThan(0)
    for (const b of sunken) expect(b.style).not.toBe('strip')
    // converse: nothing styled strip lies outside the distance band
    for (const b of m.blocks.filter((x) => x.style === 'strip')) {
      const ds = b.footprint.map((p) => dHw(p))
      expect(Math.max(...ds)).toBeLessThanOrEqual(FRONTAGE_OFF + 10)
      expect(dHw(ringCentroid(b.footprint))).toBeGreaterThan(0)
    }
    for (const b of near) {
      expect(b.style).toBe('strip')
      expect(b.alleys).toEqual([])
      if (Math.abs(ringArea(b.footprint)) < 500) continue // a degenerate sliver has no ground for lots
      const lots = m.buildings.filter((x) => x.blockId === b.id)
      expect(lots.length).toBeGreaterThanOrEqual(3)
      // extent along the highway direction (the block's long axis, which the lots are cut along)
      const { x: cx, y: cy } = ringCentroid(b.footprint)
      let best = 0, ang = 0
      b.footprint.forEach((p, i) => { const q = b.footprint[(i + 1) % b.footprint.length]; const l = Math.hypot(q.x - p.x, q.y - p.y); if (l > best) { best = l; ang = Math.atan2(q.y - p.y, q.x - p.x) } })
      for (const l of lots) {
        const u = l.footprint.map((p) => (p.x - cx) * Math.cos(ang) + (p.y - cy) * Math.sin(ang))
        expect(Math.max(...u) - Math.min(...u)).toBeLessThanOrEqual(26)
      }
    }
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
  it('a compound has a fence, a gate and 2-4 buildings', { timeout: 120000 }, () => {
    expect(m.compounds.length).toBeGreaterThanOrEqual(1)
    for (const c of m.compounds) {
      const block = m.blocks.find((b) => b.id === c.blockId)!
      expect(block.style).toBe('compound')
      expect(block.flags.compound).toBe(c.id)
      expect(c.id).toMatch(/^CMP\d+$/)
      expect(block.alleys.length).toBe(0)
      for (const p of c.fence) expect(insideOrOnEdge(p, block.footprint, 0.5)).toBe(true)
      const len = Math.hypot(c.gate[1].x - c.gate[0].x, c.gate[1].y - c.gate[0].y)
      expect(Math.abs(len - 12)).toBeLessThanOrEqual(1)
      for (const g of c.gate) expect(Math.min(...c.fence.map((p, i) => distToSegment(g, p, c.fence[(i + 1) % c.fence.length])))).toBeLessThan(1)
      const blds = m.buildings.filter((b) => b.blockId === c.blockId)
      expect(blds.length).toBeGreaterThanOrEqual(2)
      expect(blds.length).toBeLessThanOrEqual(4)
      for (const b of blds) for (const p of b.footprint) {
        expect(insideOrOnEdge(p, c.fence, 0.5)).toBe(true)
        expect(distToSegment(p, c.gate[0], c.gate[1])).toBeGreaterThan(2)
        expect(distToPolyline(p, [...c.fence, c.fence[0]])).toBeGreaterThanOrEqual(8)
      }
      expect(distToPolyline({ x: (c.gate[0].x + c.gate[1].x) / 2, y: (c.gate[0].y + c.gate[1].y) / 2 }, [...c.fence, c.fence[0]])).toBeLessThan(1)
    }
  })
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

describe('compound geometry edge cases', () => {
  const pick = (blockId: string, x: number, y: number) => [{ blockId, gateToward: { x, y } }]
  const run = (fp: Pt[], x = 0, y = 0) => {
    const block: Block = { ...makeBlock('D01'), poly: fp, footprint: fp }
    return fillLotsFull([corpDistrict], [block], base, dryTerrain, [], undefined, undefined, undefined, [], pick(block.id, x, y))
  }
  it('an L-shaped block still gets a valid fence and 2+ buildings', () => {
    const L = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 200 }, { x: 0, y: 200 }]
    const r = run(L, 100, 0)
    expect(r.compounds.length).toBe(1)
    const f = r.compounds[0].fence
    const cross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
      const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
      return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
    }
    for (let i = 0; i < f.length; i++) for (let j = i + 2; j < f.length; j++) {
      if (i === 0 && j === f.length - 1) continue
      expect(cross(f[i], f[i + 1], f[j], f[(j + 1) % f.length])).toBe(false)
    }
    expect(r.buildings.length).toBeGreaterThanOrEqual(2)
    // gate faces the toward point: the edge along y = 4
    expect(Math.abs(r.compounds[0].gate[0].y - 4)).toBeLessThan(1)
  })
  it('a compound whose centre would sit in water is not made', () => {
    // C-shaped block: the fence centroid (110, 120) falls in the bay between the arms
    const C = [[0, 0], [240, 0], [240, 80], [60, 80], [60, 160], [240, 160], [240, 240], [0, 240]].map(([x, y]) => ({ x, y }))
    const block: Block = { ...makeBlock('D01'), poly: C, footprint: C }
    const bay: Terrain = { ...dryTerrain, water: [[[[60, 80], [240, 80], [240, 160], [60, 160]]]] }
    const dry = fillLotsFull([corpDistrict], [block], base, dryTerrain, [], undefined, undefined, undefined, [], pick(block.id, 0, 0))
    expect(dry.compounds.length).toBe(1) // without the bay it is a valid compound
    const wet = fillLotsFull([corpDistrict], [block], base, bay, [], undefined, undefined, undefined, [], pick(block.id, 0, 0))
    expect(wet.compounds).toEqual([])
    expect(wet.blocks[0].style).not.toBe('compound')
  })
  it('a block too small for 2 buildings stays a normal block', () => {
    const r = run(rectPoly(0, 0, 60, 60))
    expect(r.compounds).toEqual([])
    expect(r.blocks[0].style).not.toBe('compound')
    expect(r.blocks[0].flags.compound).toBeUndefined()
    expect(r.buildings.length).toBeGreaterThan(0)
  })
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
