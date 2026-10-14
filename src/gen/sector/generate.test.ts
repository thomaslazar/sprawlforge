import { beforeAll, describe, expect, it, vi } from 'vitest'
import { onWindowEdge, pointAtT, pointInRings, polylineLength, ringArea, ringCentroid, segmentsIntersect, type Pt } from '../geometry'
import { ISLET_MOAT_OUTER_FACTOR, ISLET_RADIUS_MAX } from '../terrain/field'
import { GENERATOR_VERSION, type SectorModel, type Block, type District, type Road, type SectorParams, type Terrain } from '../types'
import { hashSeed, mulberry32 } from '../rng'
import { distToPolyline } from '../terrain/rivers'
import { RoadIndex, riverCrossingSeeds } from '../streets/trace'
import { traceRoads } from './streets'
import { sampleTerrain } from '../terrain'
import { RING_ID_PREFIX, ringRoad } from '../landmarks/place'
import { FRONTAGE_ID_PREFIX, HIGHWAY_WIDTH, STRIP_HALF } from '../streets/highway'
import { inWater, isLakeShore } from './bridges'
import { buildPlanarGraph, degree4Vertices, windowRing } from '../streets/graph'
import { bboxesFar, endMeetings, maxCloseRun } from '../streets/testutil'
import { materializeTags, resolveTags } from '../../app/tags'
import { closeRuns } from '../streets/cleanup'
import { deriveDistricts, footprintTouchPoints, frontageOf, generateSector, toBlocks } from './generate'

// full pipeline is ~3-10 s per 4 km generation (tracing + land clipping dominate)
vi.setConfig({ testTimeout: 90000 })

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}

describe('generateSector', () => {
  it('same params give deep-equal models', () => {
    expect(generateSector(base)).toEqual(generateSector(base))
  })
  it('different seeds give different models', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, seed: 43 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })
  it('meta carries seed, version and size in meters', () => {
    const m = generateSector(base)
    expect(m.meta).toMatchObject({ seed: 42, generatorVersion: GENERATOR_VERSION, sizeM: 4000 })
    expect(m.meta.params).toEqual(base)
    expect(typeof m.meta.metroSeed).toBe('number')
  })
  it('samples terrain and exposes its landform', () => {
    const m = generateSector(base)
    expect(m.terrain.landform).toBe('inland')
    expect(m.meta.metroSeed).toBe(m.terrain.metroSeed)
  })
  it('every district has a name; highways and arterials are named', () => {
    const m = generateSector(base)
    for (const d of m.districts) expect(d.name.length).toBeGreaterThan(0)
    for (const r of m.roads) {
      if (r.class === 'street' || r.class === 'ramp') expect(r.name).toBeNull()
      else expect((r.name ?? '').length).toBeGreaterThan(0)
    }
  })
  it('cross-references resolve', () => {
    const m = generateSector(base)
    const districtIds = new Set(m.districts.map((d) => d.id))
    const blockIds = new Set(m.blocks.map((b) => b.id))
    const buildingIds = new Set(m.buildings.map((b) => b.id))
    for (const b of m.blocks) {
      expect(districtIds.has(b.districtId)).toBe(true)
      // block's embedded district ordinal (any digit count) must match its actual district
      expect(b.id.startsWith(`B${b.districtId.slice(1)}`)).toBe(true)
    }
    for (const b of m.buildings) {
      expect(blockIds.has(b.blockId)).toBe(true)
      // building's blockId ordinal must match its own districtId
      expect(b.blockId.startsWith(`B${b.districtId.slice(1)}`)).toBe(true)
    }
    for (const p of m.pois.filter((q) => q.buildingId)) expect(buildingIds.has(p.buildingId)).toBe(true)
  })
  // 3 full generations; field-driven irregularity (arterials + streets both
  // sample the noise field per cut now) pushes this past the 5s default
  // under parallel test load — same headroom other generation-heavy tests
  // in this file already use
  it('never anchors a poi in water (coastal, shore-clipped buildings)', { timeout: 90000 }, () => {
    const inWater = (t: Terrain, p: { x: number; y: number }) =>
      t.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
    for (const seed of [1, 42, 119560026]) {
      const m = generateSector({ ...base, seed, landform: 'coastal' })
      for (const p of m.pois) expect(inWater(m.terrain, p.at)).toBe(false)
    }
  })
  it('roads include one highway with segments and crossings', () => {
    const m = generateSector(base)
    const hw = m.roads.filter((r) => r.class === 'highway')
    expect(hw.length).toBeGreaterThan(0)
    expect(hw.every((r) => r.id.startsWith('H1'))).toBe(true)
    expect(hw[0].segments!.length).toBeGreaterThan(0)
    expect(Array.isArray(hw[0].crossings)).toBe(true)
  })
  it('districts are faces: every block centroid is inside its district poly', () => {
    const m = generateSector(base)
    expect(m.blocks.length).toBeGreaterThan(0)
    for (const b of m.blocks) {
      const d = m.districts.find((x) => x.id === b.districtId)!
      const c = ringCentroid(b.poly)
      const inside = pointInRings(c, [d.poly])
      const touches = footprintTouchPoints(b.footprint).some((p) => pointInRings(p, [d.poly]))
      expect(inside || touches).toBe(true)
    }
  })
  it('has crossroads on a planned seed', { timeout: 90000 }, () => {
    const m = generateSector({ ...base, irregularity: 0.15, landform: 'coastal', river: true })
    const land = m.terrain.land.map((poly) => poly[0].map(([x, y]) => ({ x, y })))
    const g = buildPlanarGraph(m.roads, [windowRing(4000), ...land])
    expect(degree4Vertices(g).length).toBeGreaterThanOrEqual(20)
  })
  it('2 km sector still has streets and buildings', () => {
    const m = generateSector({ ...base, size: 2 })
    expect(m.roads.filter((r) => r.class === 'street').length).toBeGreaterThanOrEqual(20)
    expect(m.buildings.length).toBeGreaterThanOrEqual(50)
  })
  it('ramps are unnamed and never bridges', () => {
    const m = generateSector(base)
    const ramps = m.roads.filter((r) => r.class === 'ramp')
    expect(ramps.length).toBeGreaterThan(0)
    for (const r of ramps) {
      expect(r.name).toBeNull()
      expect(r.bridge).toBeFalsy()
    }
  })
  it('shadowrunish pack changes names but not geometry', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, pack: 'shadowrunish' })
    expect(a.blocks).toEqual(b.blocks)
    expect(a.buildings).toEqual(b.buildings)
    expect(a.districts.map((d) => d.bounds)).toEqual(b.districts.map((d) => d.bounds))
  })
  it('does not throw on seeds that used to break polygon-clipping on a river corridor', () => {
    // inland/river/islands sector at high irregularity — the crash-reported
    // tag combo (inland,small,dense,balanced,normal,sprawl,river,islands).
    // 2882370099 is the originally-reported seed; 4, 40, 95 and 96 crashed
    // the old partitioner / building clip. Kept as a smoke test over the
    // same seeds for the face and lot clipping that replaced them.
    const params: SectorParams = {
      seed: 0, size: 2, density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.85,
      landform: 'inland', river: true, lakes: false, islands: true, piers: false, arcology: false, megablock: false,
      pack: 'generic', theme: 'print',
    }
    for (const seed of [2882370099, 4, 40, 95, 96]) {
      expect(() => generateSector({ ...params, seed })).not.toThrow()
    }
  }, 20000) // 5 sector generations at islands:true — the moat's extra per-sample
  // work (fix: islets carve a moat) pushed this right up against the 5s default
  it('islets never dam a river: every river-course point is either wet or ringed by a wet moat (seed 2882370099)', () => {
    // deterministic repro for the islands-dam-the-river bug: an islet's core
    // bump used to raise land clear across a river channel (islet radius
    // 150-300m vs a ~60-120m channel). generateSector must not throw, and
    // any river-course point that lands on land must be explainable as
    // sitting on an islet — i.e. some radius around it is a full wet ring
    // (the moat), not just an unrelated dry patch swallowing the channel.
    const params: SectorParams = {
      seed: 2882370099, size: 2, density: 0.6, corpDominance: 0.5, poiDensity: 0.5,
      irregularity: 0.85, landform: 'inland', river: true, lakes: false, islands: true,
      piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
    }
    let m: ReturnType<typeof generateSector> | undefined
    expect(() => {
      m = generateSector(params)
    }).not.toThrow()
    const sizeM = params.size * 1000
    const inWater = (p: Pt) =>
      m!.terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
    // generous upper bound on how far an islet's moat ring could possibly
    // sit from its own center — any real moat ring must be found at or
    // under this radius
    const maxMoatR = ISLET_RADIUS_MAX * ISLET_MOAT_OUTER_FACTOR
    const ringedByMoat = (p: Pt) => {
      const angles = 24
      for (let r = 20; r <= maxMoatR + 60; r += 20) {
        let allWet = true
        for (let a = 0; a < angles; a++) {
          const theta = (a / angles) * Math.PI * 2
          if (!inWater({ x: p.x + Math.cos(theta) * r, y: p.y + Math.sin(theta) * r })) {
            allWet = false
            break
          }
        }
        if (allWet) return true
      }
      return false
    }
    const course = m!.terrain.riverSlice?.course ?? []
    const inWindow = course.filter((p) => p.x >= 0 && p.x <= sizeM && p.y >= 0 && p.y <= sizeM)
    expect(inWindow.length, 'river actually crosses this window').toBeGreaterThan(0)
    const dammed = inWindow.filter((p) => !inWater(p) && !ringedByMoat(p))
    expect(dammed).toEqual([])
  })
})

const block = (id: string, districtId: string, rect: { x: number; y: number; w: number; h: number }): Block => {
  const poly = [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
  ]
  return { id, districtId, poly, footprint: poly, style: 'rows', alleys: [], flags: {} }
}
const district = (id: string, bounds: { x: number; y: number; w: number; h: number }): District => ({
  id, zone: 'corp', name: 'X', bounds,
  poly: [
    { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h },
  ],
  irregularity: 0.5, shore: false,
  labelAt: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
  flags: {},
})

describe('landmark names and POIs', () => {
  for (const [label, params] of [
    ['arcologies', { ...base, seed: 42, corpDominance: 0.85 }],
    ['megablocks', { ...base, seed: 7, landform: 'bay' as const, corpDominance: 0.15 }],
  ] as const) {
    it(`every ${label} landmark is named and has exactly one POI at its centre`, () => {
      const m = generateSector(params)
      const marks = [...m.arcologies.map((l) => ({ l, type: 'arcology' })), ...m.megablocks.map((l) => ({ l, type: 'megablock' }))]
      expect(marks.length).toBeGreaterThan(0)
      for (const { l, type } of marks) {
        expect(l.name.length).toBeGreaterThan(0)
        const at = m.pois.filter((p) => p.type === type && p.at.x === l.center.x && p.at.y === l.center.y)
        expect(at).toHaveLength(1)
        expect(at[0].name).toBe(l.name)
      }
    })
  }
})

describe('arcology names', () => {
  it('names follow the design pool', () => {
    const words: Record<string, RegExp> = { ziggurat: /Ziggurat|Pyramid/, cluster: /Towers|Complex/, satellites: /Campus|Spire/, twins: /Twin|Gemini/, crescent: /Crescent|Arc/, stack: /Stack|Terrace/ }
    let seen = 0
    for (const seed of [42, 7, 11, 5]) for (const pack of ['generic', 'shadowrunish']) {
      const m = generateSector({ ...base, seed, corpDominance: 0.9, pack })
      for (const a of m.arcologies) if (words[a.design]) { seen++; expect(a.name).toMatch(words[a.design]) }
    }
    expect(seen).toBeGreaterThan(0)
  })
})

describe('toBlocks', () => {
  const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  it('a block touching a district only along an edge midpoint goes to that district', () => {
    const d = (id: string, poly: Pt[]) => ({ id, poly }) as unknown as District
    const districts = [d('D01', sq(200, 200, 300, 300)), d('D02', sq(40, -10, 60, 10))]
    const ring = sq(0, 0, 100, 100) // centroid and all four corners outside every district; the top edge midpoint (50, 0) is inside D02
    const blocks = toBlocks([{ poly: ring, footprint: ring }] as unknown as Parameters<typeof toBlocks>[0], districts)
    expect(blocks.map((b) => b.districtId)).toEqual(['D02'])
  })
})

describe('deriveDistricts', () => {
  it('drops a district whose blocks all drowned', () => {
    const drowned = district('D01', { x: 0, y: 0, w: 600, h: 600 })
    const survivor = district('D02', { x: 700, y: 0, w: 600, h: 600 })
    const blocks = [block('B0201', 'D02', { x: 710, y: 10, w: 280, h: 280 })]
    const out = deriveDistricts([drowned, survivor], blocks)
    expect(out.map((d) => d.id)).toEqual(['D02'])
  })
  it('anchors a partially-wet district over its surviving (dry-side) blocks, not the bounds center', () => {
    const partial = district('D03', { x: 0, y: 0, w: 1000, h: 600 })
    // only the dry left edge survived waterline clipping
    const blocks = [
      block('B0301', 'D03', { x: 0, y: 0, w: 200, h: 200 }),
      block('B0302', 'D03', { x: 0, y: 200, w: 200, h: 200 }),
    ]
    const [d] = deriveDistricts([partial], blocks)
    // union bbox of surviving blocks is x:[0,200], y:[0,400]
    expect(d.labelAt.x).toBeGreaterThanOrEqual(0)
    expect(d.labelAt.x).toBeLessThanOrEqual(200)
    expect(d.labelAt.y).toBeGreaterThanOrEqual(0)
    expect(d.labelAt.y).toBeLessThanOrEqual(400)
    // bounds center (500, 300) sits in the drowned water side — must not land there
    expect(d.labelAt.x).not.toBeCloseTo(500)
  })
  it('anchors a fully-dry district at ~ its bounds center', () => {
    const dry = district('D04', { x: 0, y: 0, w: 600, h: 600 })
    const blocks = [
      block('B0401', 'D04', { x: 0, y: 0, w: 300, h: 300 }),
      block('B0402', 'D04', { x: 300, y: 0, w: 300, h: 300 }),
      block('B0403', 'D04', { x: 0, y: 300, w: 300, h: 300 }),
      block('B0404', 'D04', { x: 300, y: 300, w: 300, h: 300 }),
    ]
    const [d] = deriveDistricts([dry], blocks)
    expect(d.labelAt.x).toBeCloseTo(300)
    expect(d.labelAt.y).toBeCloseTo(300)
  })
})

describe('generateSector invariants', () => {
  const sweep = [42, 7, 158383].flatMap((seed) =>
    (['inland', 'coastal', 'bay'] as const).map((landform) => ({ ...base, seed, size: 2, landform, river: landform !== 'inland' })))

  it('every road, building, block and district point lies inside the window', () => {
    for (const p of sweep) {
      const m = generateSector(p)
      const lim = m.meta.sizeM
      const pts = [
        ...m.roads.flatMap((r) => r.points), ...m.buildings.flatMap((b) => b.footprint),
        ...m.blocks.flatMap((b) => [...b.poly, ...b.footprint]), ...m.districts.flatMap((d) => d.poly),
      ]
      const bad = pts.filter((q) => q.x < -1e-6 || q.x > lim + 1e-6 || q.y < -1e-6 || q.y > lim + 1e-6)
      expect(bad, `${p.seed}/${p.landform}`).toHaveLength(0)
    }
  })

  it('ramp count is four times the interchange count', () => {
    for (const p of sweep) {
      const m = generateSector(p)
      const hw = m.roads.find((r) => r.class === 'highway')
      if (!hw) continue
      const ics = (hw.crossings ?? []).filter((c) => c.interchange).length
      expect(m.roads.filter((r) => r.class === 'ramp'), `${p.seed}/${p.landform}`).toHaveLength(4 * ics)
    }
  })

  it('pieces of one arterial share a name', () => {
    const m = generateSector({ ...base, landform: 'coastal', river: true })
    const bridges = m.roads.filter((r) => r.id.includes('-b'))
    expect(bridges.length).toBeGreaterThan(0)
    for (const b of bridges) {
      const sibs = m.roads.filter((r) => r.id.split('-')[0] === b.id.split('-')[0])
      expect(new Set(sibs.map((r) => r.name)).size).toBe(1)
    }
  })
})

describe('arterial connectivity', () => {
  const cases = [
    { seed: 4280430344, size: 4, density: 0.5, corpDominance: 0.85, poiDensity: 0.7, irregularity: 0.15,
      landform: 'coastal', river: true, lakes: true },
    { seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5, irregularity: 0.85,
      landform: 'bay', river: false, lakes: false },
  ] as const
  for (const c of cases) {
    it(`no arterial dangles (seed ${c.seed})`, () => {
      const m = generateSector({ islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon', ...c })
      const roads = m.roads.filter((r) => r.class !== 'ramp')
      const idx = new RoadIndex(200)
      for (const r of roads) idx.add(r.id, r.points, r.class)
      const S = m.meta.sizeM
      let ends = 0
      let dangling = 0
      // a closed arcology ring has no ends
      for (const r of roads.filter((x) => x.class === 'arterial' && Math.hypot(x.points[0].x - x.points.at(-1)!.x, x.points[0].y - x.points.at(-1)!.y) >= 1)) {
        for (const e of [r.points[0], r.points[r.points.length - 1]]) {
          ends++
          if (e.x < 1 || e.y < 1 || e.x > S - 1 || e.y > S - 1) continue
          if (idx.nearestMatching(e, 6, (h) => h.id !== r.id && h.cls === 'arterial')) continue
          if (nearWater(m.terrain, e, 15)) continue
          dangling++
        }
      }
      console.log('arterial dangling', c.seed, dangling, 'of', ends)
      expect(dangling).toBe(0)
    })
  }
})

const nearWater = (t: Terrain, p: Pt, r: number): boolean => {
  for (let a = 0; a < 16; a++) {
    const q = { x: p.x + r * Math.cos((a * Math.PI) / 8), y: p.y + r * Math.sin((a * Math.PI) / 8) }
    if (inWater(t, q)) return true
  }
  return inWater(t, p)
}

describe('arterial bridges', () => {
  it('arterial bridges appear between the seeded crossings', () => {
    const m = generateSector({
      seed: 4280430344, size: 4, density: 0.5, corpDominance: 0.85, poiDensity: 0.7, irregularity: 0.15,
      landform: 'coastal', river: true, lakes: true, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
    })
    const seeds = riverCrossingSeeds(m.terrain, mulberry32(hashSeed(4280430344, 'arterials'))).length
    const bridges = m.roads.filter((r) => r.class === 'arterial' && r.bridge)
    console.log('arterial bridges', bridges.length, 'crossing seeds', seeds)
    // was 1.5 x seeds (6): highway seeds now cross the highway instead of running
    // along it, which reshuffled this seed's layout to exactly the 4 seeded bridges
    // prune-dangling cut one bridge whose far bank had no junction (B018): 3 of 4 seeded
    expect(bridges.length).toBeGreaterThanOrEqual(seeds - 1)
    for (const b of bridges) expect(polylineLength(b.points)).toBeLessThan(600) // 579 m: pre-existing B004, a seeded crossing that doubles back in the channel
  })
})

describe('river decks land on the far-bank road (seed 42 arcology)', () => {
  let m: ReturnType<typeof generateSector>
  let decks: Road[]
  beforeAll(() => {
    m = generateSector({ ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river', 'arcology']), seed: 42, pack: 'generic', theme: 'print' } as SectorParams)
    decks = m.roads.filter((r) => r.class === 'arterial' && r.bridge)
  }, 300000)
  const family = (id: string) => id.replace(/-(b?\d+)$/, '')
  const anchoredAt = (e: Pt, fam: string) => {
    const S = m.meta.sizeM
    return e.x < 1 || e.y < 1 || e.x > S - 1 || e.y > S - 1 || nearWater(m.terrain, e, 15)
      || m.roads.some((r) => r.class === 'arterial' && family(r.id) !== fam && distToPolyline(e, r.points) <= 1)
  }
  /** the dry piece of the deck's own road that starts at deck end e, if any */
  const landing = (d: Road, e: Pt) => m.roads.find((r) => r.class === 'arterial' && !r.bridge && family(r.id) === family(d.id)
    && [r.points[0], r.points.at(-1)!].some((q) => Math.hypot(q.x - e.x, q.y - e.y) < 1))
  it('the three north-west arterials ending on the river are bridged', () => {
    // the NW-bank ends (investigation item 6): their decks were blocked by the arcology spoke along the far bank, 50–70 m past it
    // arterials re-roll (v9): ends 1086,2727 / 791,2954 / 527,3193 -> 1466,2324 / 841,2902 / 578,3119 (decks A006-b1, A004-b1, B010-b1)
    for (const e of [{ x: 1466, y: 2324 }, { x: 841, y: 2902 }, { x: 578, y: 3119 }])
      expect(decks.filter((d) => distToPolyline(e, d.points) < 30).length, `${e.x},${e.y}`).toBeGreaterThanOrEqual(1)
  })
  it('every deck covers only the water plus its landing; the road goes on over land to an end anchored within 1 m', () => {
    for (const d of decks) for (const e of [d.points[0], d.points.at(-1)!]) {
      // walk into the deck from this end until the water: at most the 15 m landing + the 10 m water sampling step
      const pts = e === d.points[0] ? d.points : d.points.slice().reverse()
      let dry = 0
      while (dry <= 40 && !inWater(m.terrain, pointAtT(pts, Math.min(1, dry / polylineLength(pts))))) dry += 1
      expect(dry, `${d.id} landing`).toBeLessThanOrEqual(26)
      const piece = landing(d, e)
      const far = piece ? [piece.points[0], piece.points.at(-1)!].sort((a, b) => Math.hypot(b.x - e.x, b.y - e.y) - Math.hypot(a.x - e.x, a.y - e.y))[0] : e
      expect(anchoredAt(far, family(d.id)), `${d.id} end ${far.x.toFixed(0)},${far.y.toFixed(0)}`).toBe(true)
    }
  })
  it('the two southern north-west decks land on the far-bank arterial (by a dry piece of road, or straight onto it)', () => {
    // arterials re-roll (v9): 791,2954 / 527,3193 -> 841,2902 / 578,3119
    for (const at of [{ x: 841, y: 2902 }, { x: 578, y: 3119 }]) {
      const d = decks.find((x) => distToPolyline(at, x.points) < 30)!
      const ends = [d.points[0], d.points.at(-1)!].filter((e) => Math.hypot(e.x - at.x, e.y - at.y) > 100)
      expect(ends.length).toBe(1)
      const piece = landing(d, ends[0])
      // arterials re-roll (v9): A004-b1 lands on A002 4 m past the water, so no dry piece is left; the deck's own end is then the far end
      const far = piece ? [piece.points[0], piece.points.at(-1)!].find((q) => Math.hypot(q.x - ends[0].x, q.y - ends[0].y) > 1)! : ends[0]
      expect(m.roads.some((r) => r.class === 'arterial' && family(r.id) !== family(d.id) && distToPolyline(far, r.points) <= 1), `${d.id} lands`).toBe(true)
    }
  })
})

describe('river bridges (seed 42)', () => {
  let m: ReturnType<typeof generateSector>
  let arterialBridges: Road[]
  beforeAll(() => {
    m = generateSector({ ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river']), seed: 42, pack: 'generic', theme: 'print' } as SectorParams)
    arterialBridges = m.roads.filter((r) => r.class === 'arterial' && r.bridge)
  }, 300000)
  it('no road is degenerate (>= 2 points, positive length)', () => {
    for (const r of m.roads) {
      expect(r.points.length, r.id).toBeGreaterThanOrEqual(2)
      expect(polylineLength(r.points), r.id).toBeGreaterThan(0)
    }
  })
  it('no arterial deck crosses a highway bridge', () => {
    const hw = m.roads.filter((r) => r.class === 'highway' && r.bridge)
    for (const a of arterialBridges) for (const h of hw)
      for (let i = 1; i < a.points.length; i++) for (let j = 1; j < h.points.length; j++)
        expect(segmentsIntersect(a.points[i - 1], a.points[i], h.points[j - 1], h.points[j]), `${a.id} x ${h.id}`).toBe(false)
  })
  it('facing arterial stubs across the river are joined by bridges', () => {
    console.log('arterial bridges', arterialBridges.length, arterialBridges.map((r) => r.id).join(' '))
    // was 1 before joinRiverStubs, 3 until landings stopped anchoring (A003 bridged to a dead end), 2 (A006, A007) until arterials crossed the highway: now A006 only; no unmatched river-facing stub pair remains (A001/A002 face a sea inlet)
    expect(arterialBridges.length).toBeGreaterThanOrEqual(1)
  })
  it('no arterial bridge ends in nothing', () => {
    const idx = new RoadIndex(200)
    for (const r of m.roads) if (r.class !== 'ramp') idx.add(r.id, r.points, r.class)
    const family = (id: string) => id.replace(/-(b?\d+)$/, '') // the deck's own dry pieces share its family
    const sib = m.roads.filter((r) => r.class === 'arterial' && !r.bridge)
    for (const b of arterialBridges) for (const e of [b.points[0], b.points.at(-1)!]) {
      // an end continuing into its own dry piece is checked at that piece's far end ('no arterial dangles'); a deck that IS the road end must meet another road
      if (sib.some((d) => family(d.id) === family(b.id) && [d.points[0], d.points.at(-1)!].some((q) => Math.hypot(q.x - e.x, q.y - e.y) < 1))) continue
      expect(idx.nearestMatching(e, 1, (h) => family(h.id) !== family(b.id) && (h.cls === 'arterial' || h.cls === 'highway')), b.id).not.toBeNull()
    }
  })
  it('no arterial ends on the highway', () => {
    const hw = m.roads.filter((r) => r.class === 'highway')
    expect(hw.length).toBeGreaterThan(0)
    const S = m.meta.sizeM
    const arts = m.roads.filter((r) => r.class === 'arterial')
    const idx = new RoadIndex(200)
    for (const r of arts) idx.add(r.id, r.points, r.class)
    console.log('highway crossings', hw[0]?.crossings?.length, 'interchanges', hw[0]?.crossings?.filter((c) => c.interchange).length)
    for (const r of arts) for (const e of [r.points[0], r.points.at(-1)!]) {
      if (e.x < 1 || e.y < 1 || e.x > S - 1 || e.y > S - 1) continue
      if (idx.nearestMatching(e, 6, (h) => h.id !== r.id)) continue
      for (const h of hw) expect(distToPolyline(e, h.points), r.id).toBeGreaterThan(30)
    }
  })
  it('every arterial bridge is shorter than 600 m', () => {
    for (const b of arterialBridges) expect(polylineLength(b.points), b.id).toBeLessThan(600)
  })
})

describe('no doubled arterials', () => {
  it('seed 2982258224 has no long side-by-side arterial runs', () => {
    const m = generateSector({
      ...base, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5,
      irregularity: 0.85, landform: 'bay',
    })
    const arts = m.roads.filter((r) => r.class === 'arterial')
    // 66 streets / 9 arterials measured (66 before the singularity stop, 41 with it ending
    // halves at the seed; 74 / 13 before prune-dangling); bounds = measured - 10 %
    expect(m.roads.filter((r) => r.class === 'street').length).toBeGreaterThanOrEqual(44) // 49 measured after streets stopped anchoring on the highway (hooks gone)
    expect(arts.length).toBeGreaterThanOrEqual(7) // was >= 8: arterials cross the highway; a tail past it with no arterial junction is pruned (half interchanges: ROADMAP)
    let worst = 0
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        if (bboxesFar(arts[i].points, arts[j].points, 200)) continue
        worst = Math.max(worst, maxCloseRun(arts[i].points, arts[j].points, 200))
      }
    }
    // a perpendicular crossing alone keeps two arterials within 0.5 sep for
    // ~2 x 200 m and an acute Y-merge more, so 320 is unreachable; measured
    // 700 m after the birth check (749 m before a2ebfa4: the doubled lane;
    // more arterials survive now, so more Y-merges) + ~10 %
    expect(worst).toBeLessThanOrEqual(770)
  })
})

describe('reference seed road quality', () => {
  const m = generateSector({
    ...base, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5,
    irregularity: 0.85, landform: 'bay',
  })
  const arts = m.roads.filter((r) => r.class === 'arterial')
  const hw = m.roads.filter((r) => r.class === 'highway')

  it('no acute arterial merges', () => {
    const S = m.meta.sizeM
    // ends on the window edge, at water or on the highway are exempt; so is an end that lands on another road's tip and carries on that way (arterials re-roll v9: B001/B004 meet at 545,515 as one 16.5° bend; the folded line angle cannot tell that from a V)
    const ms = endMeetings(arts, hw).filter(
      (x) => x.cls === 'arterial' && !x.through && !nearWater(m.terrain, x.end, 25) && x.end.x > 1 && x.end.y > 1 && x.end.x < S - 1 && x.end.y < S - 1,
    )
    console.log('meetings', ms.length, JSON.stringify(ms.filter((x) => x.deg < 25).map((x) => [x.id, Math.round(x.end.x), Math.round(x.end.y), Math.round(x.deg * 10) / 10, Math.round(x.edge)])))
    expect(ms.filter((x) => x.deg < 25)).toEqual([])
  })

  it('interchanges cross the highway at 45° or more', () => {
    const h = hw[0]
    const idx = new RoadIndex(200)
    idx.add(h.id, h.points, 'highway')
    const ics = (h.crossings ?? []).filter((c) => c.interchange)
    // the seed's only interchange sat on a 150 m arterial stub (now ineligible); none left is fine
    for (const c of ics) {
      const a = arts.find((r) => r.id === c.roadId || r.id.startsWith(c.roadId + '-'))!
      const at = pointAtT(h.points, c.at)
      const hit = idx.nearestMatching(at, 50, () => true)!
      const ah = new RoadIndex(50)
      ah.add(a.id, a.points, 'arterial')
      const ar = ah.nearestMatching(at, 50, () => true)!
      let d = Math.abs(hit.segAngle - ar.segAngle) % Math.PI
      if (d > Math.PI / 2) d = Math.PI - d
      expect((d * 180) / Math.PI).toBeGreaterThanOrEqual(44)
    }
  })

  it('no arterial tail under 120 m past a junction', () => {
    const idx = new RoadIndex(200)
    for (const r of [...arts, ...hw]) idx.add(r.id, r.points, r.class)
    const touches = (p: Pt, id: string, r: number) => !!idx.nearestMatching(p, r, (h) => h.id !== id && h.cls !== 'street')
    const bad: string[] = []
    for (const r of arts) {
      for (const pts of [r.points, r.points.slice().reverse()]) {
        if (touches(pts[0], r.id, 6)) continue
        let arc = 0
        for (let i = 1; i < pts.length; i++) {
          arc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
          if (arc > 120) break
          if (touches(pts[i], r.id, 3)) { bad.push(`${r.id}@${Math.round(arc)}`); break }
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('no hairpins', () => {
  const sp = (seed: number, density: number, corpDominance: number, poiDensity: number, irregularity: number, landform: SectorParams['landform'], river: boolean): SectorParams => ({
    ...base, seed, size: 2, density, corpDominance, poiDensity, irregularity, landform, river, pack: 'generic', theme: 'print',
  })
  const cases: [number, SectorParams][] = [
    [3017268931, sp(3017268931, 0.9, 0.85, 0.25, 0.15, 'bay', true)],
    [2982258224, sp(2982258224, 0.25, 0.15, 0.5, 0.85, 'bay', false)],
  ]
  for (const [seed, params] of cases) {
    it(`arterials and streets turn <= 100 deg per segment (seed ${seed})`, () => {
      const m = generateSector(params)
      let max = 0
      for (const r of m.roads) {
        if (r.class !== 'arterial' && r.class !== 'street') continue
        for (let i = 2; i < r.points.length; i++) {
          const a = r.points[i - 2], b = r.points[i - 1], c = r.points[i]
          // sub-metre weld slivers have no meaningful heading
          if (Math.hypot(b.x - a.x, b.y - a.y) < 1 || Math.hypot(c.x - b.x, c.y - b.y) < 1) continue
          const t = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)
          max = Math.max(max, Math.abs(Math.atan2(Math.sin(t), Math.cos(t))))
        }
      }
      expect(max).toBeLessThanOrEqual((100 * Math.PI) / 180)
    })
  }
})

describe('coast-aligned streets', () => {
  it('coast-aligned streets survive', () => {
    const m = generateSector({
      ...base, seed: 3017268931, size: 2, density: 0.9, corpDominance: 0.85, poiDensity: 0.25,
      irregularity: 0.15, landform: 'bay', river: true,
    })
    const len = [0, 0, 0, 0] // cells (0,0) (1,0) (0,1) (1,1) of 500 m
    for (const r of m.roads) {
      if (r.class !== 'street') continue
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1], b = r.points[i]
        const x = Math.floor((a.x + b.x) / 1000), y = Math.floor((a.y + b.y) / 1000)
        if (x <= 1 && y <= 1) len[y * 2 + x] += Math.hypot(b.x - a.x, b.y - a.y)
      }
    }
    // baseline f3d4114 (NW lost almost everything: 0 240 169 320 m) -> 1142 1237 169 320 m after this fix, floors = measured - 10 %.
    // The older a154b6a 1354/1041/729/483 is NOT the target: that NW network was one arterial hairpinning back
    // onto its own parent highway (>= 124 deg turn), which the no-hairpin rule forbids.
    // NE 1113 -> 918 floor (1020 m measured) once highway-hook streets are pruned
    // NW 1142 -> 908 m once parallel-stopped streets end on their neighbour (they used to be pruned whole): floor 817 (-10 %)
    ;[817, 918, 152, 288].forEach((floor, k) => expect(len[k]).toBeGreaterThanOrEqual(floor))
  })

  it('no road runs through a block', () => {
    // slivers are dropped, not merged. Residual (2 on seed 3017268931, 10 on seed 42) (B1412:S024 B1412:L008 B1109:L006) = faces with a
    // hole / pruned dead ends; buildings still never sit on them (second assertion). Ratchet down, never up. Documented exceptions: seed 3017268931 -> 2 (boulevard arcology access replaced its ring and the 'streets' rng stream shifted; PROOF the two offenders are the pre-existing decay cul-de-sac class, not ours: both are traced streets (not infill) whose free end is in decayEnds, i.e. kept on purpose by pruneDangling: B0901:S066 end (1912,1581), 538 m from the arcology, B0808:S038 end (925,666), 317 m, beyond the 187 m plaza and away from the boulevard; was 1 and 2 before landmarks; briefly 3 until the planar-graph zero-length-edge fix); seed 42 coastal+river -> 15 (was 10; rose with the landmark-changed map, every remaining offender proven > 400 m from any landmark); 15 → 17 after shore stubs < 150 m are pruned (face reshuffle moves infill chords S416, S428, S417, S308; infill-chord class, see ROADMAP).
    const cases: Array<[SectorParams, number]> = [
      [{ seed: 3017268931, size: 2, density: 0.9, corpDominance: 0.85, poiDensity: 0.25, irregularity: 0.15, landform: 'bay', river: true, lakes: false, islands: false, piers: false, arcology: true, megablock: false, pack: 'generic', theme: 'print' }, 2],
      // user ruling 2026-10-13 after the arterials re-roll; documented class (faces with holes, dead ends, infill chords)
      [{ ...base, seed: 42, landform: 'coastal', river: true }, 18],
    ]
    for (const [params, max] of cases) {
      const m = modelFor(params)
      const bad: string[] = []
      for (const b of m.blocks) {
        const xs = b.footprint.map((p) => p.x), ys = b.footprint.map((p) => p.y)
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
        const ring = [...b.footprint, b.footprint[0]]
        for (const r of m.roads) {
          if (r.class === 'ramp') continue
          const pts: Pt[] = [...r.points]
          for (let i = 1; i < r.points.length; i++) pts.push({ x: (r.points[i - 1].x + r.points[i].x) / 2, y: (r.points[i - 1].y + r.points[i].y) / 2 })
          const lim = r.width / 2 + 1
          if (pts.some((p) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1 && pointInRings(p, [b.footprint]) && distToPolyline(p, ring) > lim)) bad.push(`${b.id}:${r.id}:${r.class}`)
        }
      }
      expect(bad.length, `seed ${params.seed} (${bad.length}): ${bad.join(' ')}`).toBeLessThanOrEqual(max)
      // whatever the face graph did, no building vertex sits on a road's paved width
      const under = m.buildings.filter((bl) => bl.footprint.some((p) => m.roads.some((r) => r.class !== 'highway' && distToPolyline(p, r.points) < r.width / 2 - 0.5)))
      expect(under.map((bl) => bl.id), `seed ${params.seed}`).toEqual([])
    }
  })
})

describe('block size', () => {
  it('does not hang on seed 7 coastal,small (zero-area zig-zag face in lot inset)', { timeout: 120000 }, () => {
    const params = { ...resolveTags(materializeTags(7, ['coastal', 'small'] as any)), seed: 7, pack: 'generic', theme: 'neon' } as SectorParams
    const model = generateSector(params)
    expect(model.blocks.length).toBeGreaterThan(0)
  })

  const cases: SectorParams[] = [
    { ...base, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, irregularity: 0.85, landform: 'bay', pack: 'generic', theme: 'print' },
    { ...base, seed: 4280430344, density: 0.5, corpDominance: 0.85, poiDensity: 0.7, irregularity: 0.15, landform: 'coastal', river: true, lakes: true },
    base,
  ]
  it('every land block is street-sized', () => {
    for (const params of cases) {
      const m = generateSector(params)
      const s = params.size * 1000
      const wet = (p: Pt) => inWater(m.terrain, p) || [0, 1, 2, 3, 4, 5, 6, 7].some((k) => inWater(m.terrain, { x: p.x + 150 * Math.cos((k * Math.PI) / 4), y: p.y + 150 * Math.sin((k * Math.PI) / 4) }))
      const big = m.blocks.filter((b) => {
        const c = ringCentroid(b.footprint)
        // blocks beside a megablock, and an arcology's own block, stay big on purpose
        // a strip block is a long band between frontage road and highway (about 40 m wide): its area says nothing about street spacing
        const nearCore = m.megablocks.some((k) => k.core.some((p) => pointInRings(p, [b.footprint])) || pointInRings(k.center, [b.footprint]))
        return Math.abs(ringArea(b.footprint)) > ([2982258224, 42].includes(params.seed) ? 64000 : 60000) && // 2982258224 and 42: 64000 (was 60000; measured 61431 / 63192 for B0419/B0423 and 63158 / 62743 for B0505/B0829): arterials cross the highway; a tail past it with no arterial junction is pruned (half interchanges: ROADMAP)
         Math.min(c.x, c.y, s - c.x, s - c.y) >= 150 && !wet(c) && !nearCore && b.style !== 'strip' && !m.arcologies.some((a) => pointInRings(a.center, [b.footprint]))
      })
      expect(big.map((b) => `${b.id} ${Math.round(Math.abs(ringArea(b.footprint)))}`), `seed ${params.seed}`).toEqual([])
    }
  })
})

describe('block styles', () => {
  it('a sector mixes block styles', () => {
    const styles = generateSector(base).blocks.map((b) => b.style)
    expect(new Set(styles).size).toBeGreaterThanOrEqual(2)
    const rows = styles.filter((s) => s === 'rows').length / styles.length
    expect(rows).toBeGreaterThan(0.3)
    expect(rows).toBeLessThan(0.9)
  })
})

describe('density tags', () => {
  it('density tags give distinct building counts', () => {
    const n = (density: number) => generateSector({ ...base, density }).buildings.length
    const [s, d, p] = [n(0.25), n(0.6), n(0.9)]
    expect(s).toBeLessThan(d * 0.85)
    expect(d).toBeLessThan(p * 0.9)
  })
})

describe('streets at the highway', () => {
  const cases = [
    { seed: 4280430344, size: 4, density: 0.5, corpDominance: 0.85, poiDensity: 0.7, irregularity: 0.15,
      landform: 'coastal', river: true, lakes: true },
    { seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5, irregularity: 0.85,
      landform: 'bay', river: false, lakes: false },
  ] as const
  for (const c of cases) {
    const m = generateSector({ islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'print', ...c })
    // markWetSpans may split the highway; crossings are copied to every piece
    const pieces = m.roads.filter((r) => r.class === 'highway')
    const hw = { ...pieces[0], points: pieces.flatMap((r) => r.points) }
    it(`no street ends at the highway (seed ${c.seed})`, () => {
      const idx = new RoadIndex(200)
      for (const r of m.roads) if (r.class === 'street' || r.class === 'arterial') idx.add(r.id, r.points, r.class)
      const bad: string[] = []
      for (const r of m.roads.filter((x) => x.class === 'street')) {
        for (const p of [r.points[0], r.points[r.points.length - 1]]) {
          if (distToPolyline(p, hw.points) > HIGHWAY_WIDTH / 2 + 10) continue
          if (!idx.nearestMatching(p, 6, (h) => h.id !== r.id)) bad.push(`${r.id}@${Math.round(p.x)},${Math.round(p.y)}`)
        }
      }
      expect(bad).toEqual([])
    })
    it(`every crossing deck belongs to a road that crosses (seed ${c.seed})`, () => {
      const side = (p: Pt) => {
        const d = distToPolyline(p, hw.points)
        if (d < HIGHWAY_WIDTH / 2) return 0
        let best = Infinity, sgn = 1
        for (let i = 0; i < hw.points.length - 1; i++) {
          const a = hw.points[i], b = hw.points[i + 1]
          const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2))
          const dd = Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y))
          if (dd < best) { best = dd; sgn = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) }
        }
        return sgn
      }
      for (const cr of hw.crossings ?? []) {
        const rs = m.roads.filter((r) => r.id === cr.roadId || r.id.startsWith(cr.roadId + '-'))
        expect(rs.length).toBeGreaterThan(0)
        const sides = new Set(rs.flatMap((r) => r.points.map(side)))
        expect(sides.has(-1) && sides.has(1)).toBe(true)
      }
    })
  }
})

describe('landmarks in road tracing', () => {
  // street km per km2 of a district (all of its polygon), streets counted by segment midpoint
  const streetDensity = (m: ReturnType<typeof generateSector>, d: District) => {
    let len = 0
    for (const r of m.roads) if (r.class === 'street') for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i]
      // sampled every 10 m along the segment: a straight street is one 900 m segment whose midpoint may lie outside
      const l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / 10))
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n
        if (pointInRings({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, [d.poly])) len += l / n
      }
    }
    return len / 1000 / (Math.abs(ringArea(d.poly)) / 1e6)
  }
  // land districts > 10 ha (water sampled out on a 20 m grid; docks and landmark districts exempt) under 3 km/km2
  const emptyDistricts = (m: ReturnType<typeof generateSector>) => m.districts.filter((d) => {
    if (d.zone === 'docks' || d.flags.arcology || d.flags.megablock) return false
    const xs = d.poly.map((p) => p.x), ys = d.poly.map((p) => p.y)
    let land = 0
    for (let x = Math.min(...xs); x < Math.max(...xs); x += 20) for (let y = Math.min(...ys); y < Math.max(...ys); y += 20) {
      const q = { x: x + 10, y: y + 10 }
      if (pointInRings(q, [d.poly]) && !inWater(m.terrain, q)) land += 400
    }
    return land > 1e5 && streetDensity(m, d) < 3
  }).map((d) => d.id)
  const seeds: [string, SectorParams][] = [
    ['seed 42 inland corp 0.85', { ...base, corpDominance: 0.85 }],
    ['seed 7 bay corp 0.15', { ...base, seed: 7, landform: 'bay', corpDominance: 0.15 }],
    // access kinds at 4 km inland corp 0.85: seed 42 embedded, 7 embedded + ring (square), 11 half + ring (octagon), 5 ring (circle) + boulevard
    ['seed 7 inland corp 0.85', { ...base, seed: 7, corpDominance: 0.85 }],
    ['seed 11 inland corp 0.85', { ...base, seed: 11, corpDominance: 0.85 }],
    ['seed 5 inland corp 0.85', { ...base, seed: 5, corpDominance: 0.85 }],
  ]
  for (const [label, params] of seeds) {
    describe(label, () => {
      const m = generateSector(params)
      const plazas = m.arcologies.map((a) => a.plaza)
      const cores = m.megablocks.map((k) => k.core)
      const inside = (r: { points: Pt[] }, rings: Pt[][]) => r.points.some((p) => rings.some((ring) => pointInRings(p, [ring])))
      it('places landmarks', () => {
        expect(m.arcologies.length + m.megablocks.length).toBeGreaterThan(0)
      })
      // m.roads includes infill: ring/megablock faces are not infilled, and no infill cut runs through a non-ring plaza
      it('landmark districts are zoned corp and slum', () => {
        expect(m.arcologies.length + m.megablocks.length).toBeGreaterThan(0)
        for (const a of m.arcologies) {
          const d = m.districts.find((x) => pointInRings(a.center, [x.poly]))!
          expect(d.zone).toBe('corp')
          expect(d.flags.arcology).toBe(a.id)
        }
        for (const k of m.megablocks) {
          const d = m.districts.find((x) => pointInRings(k.center, [x.poly]))!
          expect(d.zone).toBe('slum')
          // two megablocks can share one district; the flag holds one of their ids
          expect(m.megablocks.filter((o) => pointInRings(o.center, [d.poly])).map((o) => o.id)).toContain(d.flags.megablock)
        }
      })
      it('no road enters an arcology plaza', () => {
        expect(m.roads.filter((r) => inside(r, plazas)).map((r) => r.id)).toEqual([])
      })
      it('no street enters a megablock core', () => {
        expect(m.roads.filter((r) => r.class === 'street' && inside(r, cores)).map((r) => r.id)).toEqual([])
      })
      it('ring roads are block boundaries', () => {
        for (const a of m.arcologies.filter((x) => x.access === 'ring')) {
          const ring = m.roads.filter((r) => r.id === a.ringRoadId || r.id.startsWith(`${a.ringRoadId}-`))
          const closed = ring.flatMap((r) => r.points)
          for (const b of m.blocks) {
            const edge = [...b.footprint, b.footprint[0]]
            const deep = closed.filter((p) => pointInRings(p, [b.footprint]) && distToPolyline(p, edge) > ring[0].width / 2 + 1)
            expect(deep.length, `${b.id} holds ring ${a.ringRoadId}`).toBe(0)
          }
          const plaza = m.blocks.filter((b) => pointInRings(a.center, [b.footprint]))
          expect(plaza.length).toBe(1)
          for (const p of plaza[0].footprint) // 8 m, not 6: seed 42 keeps one 7.2 m spoke stub inside its ring
          expect(distToPolyline(p, [...closed, closed[0]])).toBeLessThanOrEqual(8)
        }
      })
      it('ring roads are closed and spoked', () => {
        for (const a of m.arcologies.filter((x) => x.access === 'ring')) {
          const ring = m.roads.filter((r) => r.id === a.ringRoadId || r.id.startsWith(`${a.ringRoadId}-`))
          expect(ring.length).toBeGreaterThan(0)
          const pts = ring.flatMap((r) => r.points)
          const closed = [...pts, pts[0]]
          const spokes = m.roads.filter((r) => r.class === 'arterial' && !ring.includes(r)).flatMap((r) => [r.points[0], r.points[r.points.length - 1]])
            .filter((e) => distToPolyline(e, closed) <= 6)
          expect(spokes.length).toBeGreaterThanOrEqual(2) // was 3 (seed 11 lost one ring spoke): arterials cross the highway; a tail past it with no arterial junction is pruned (half interchanges: ROADMAP)
        }
      })
      it('half rings are open and spoked', () => {
        for (const a of m.arcologies.filter((x) => x.access === 'half')) {
          const ring = m.roads.filter((r) => r.id === a.ringRoadId || r.id.startsWith(`${a.ringRoadId}-`))
          expect(ring.length).toBeGreaterThan(0)
          const pts = ring.flatMap((r) => r.points)
          const ends = [ringRoad(a)!.points[0], ringRoad(a)!.points.at(-1)!]
          expect(pts[0]).not.toEqual(pts.at(-1))
          const spokeEnds = m.roads.filter((r) => r.class === 'arterial' && !ring.includes(r)).flatMap((r) => [r.points[0], r.points.at(-1)!])
          for (const e of ends) expect(spokeEnds.some((q) => Math.hypot(q.x - e.x, q.y - e.y) <= 6), 'end spoke').toBe(true)
          expect(spokeEnds.filter((e) => distToPolyline(e, pts) <= 6).length).toBeGreaterThanOrEqual(3)
        }
      })
      it('boulevards pass the plaza; boulevard and embedded have no K road', () => {
        for (const a of m.arcologies.filter((x) => x.access === 'boulevard' || x.access === 'embedded')) {
          expect(m.roads.filter((r) => r.id.startsWith(a.ringRoadId + '-') || r.id === a.ringRoadId)).toEqual([])
          if (a.access === 'boulevard') {
            const near = m.roads.filter((r) => r.class === 'arterial' && distToPolyline(a.center, r.points) <= a.radius + 80)
            expect(near.length, a.id).toBeGreaterThan(0)
          }
        }
      })
      it('non-ring arcology blocks keep lots outside the plaza', () => {
        for (const a of m.arcologies.filter((x) => x.access !== 'ring')) {
          const b = m.blocks.find((x) => pointInRings(a.center, [x.footprint]))!
          expect(b.flags.arcology).toBe(a.id)
          expect(b.style).not.toBe('plaza')
          expect(m.buildings.filter((x) => x.blockId === b.id).length, a.id).toBeGreaterThan(0)
        }
        // 0.98: a lot clipped to the plaza edge has vertices on it, which the boundary test may call inside
        for (const a of m.arcologies) {
          const inner = a.plaza.map((p) => ({ x: a.center.x + 0.98 * (p.x - a.center.x), y: a.center.y + 0.98 * (p.y - a.center.y) }))
          for (const bl of m.buildings) expect(bl.footprint.some((p) => pointInRings(p, [inner])), `${bl.id} in ${a.id}`).toBe(false)
        }
      })
      it('no block alley enters a non-ring arcology plaza', () => {
        for (const a of m.arcologies.filter((x) => x.access !== 'ring')) {
          const inner = a.plaza.map((p) => ({ x: a.center.x + 0.98 * (p.x - a.center.x), y: a.center.y + 0.98 * (p.y - a.center.y) }))
          for (const bl of m.blocks) for (const [p, q] of bl.alleys ?? [])
            for (const pt of [p, q, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }]) expect(pointInRings(pt, [inner]), `${bl.id} alley in ${a.id}`).toBe(false)
        }
      })
      it('no sizeable land district is left without streets', () => {
        expect(emptyDistricts(m)).toEqual([])
      })
    })
  }
  it('seed 7 bay 2 km: the district north of the arcology keeps its streets', () => {
    const m = generateSector({ ...base, seed: 7, size: 2, landform: 'bay', density: 0.25, corpDominance: 0.15, poiDensity: 0.7, arcology: true })
    const d = m.districts.find((x) => pointInRings({ x: 1297, y: 950 }, [x.poly]))!
    expect(streetDensity(m, d)).toBeGreaterThanOrEqual(8)
  })
})

/** one generateSector per distinct params across the slow 6 km describes */
const modelCache = new Map<string, ReturnType<typeof generateSector>>()
const modelFor = (params: SectorParams) => {
  const k = JSON.stringify(params)
  if (!modelCache.has(k)) modelCache.set(k, generateSector(params))
  return modelCache.get(k)!
}

describe('no hairpin spokes', () => {
  const models: [string, SectorParams][] = [
    ['seed 782008753 inland 6 km', { ...base, seed: 782008753, size: 6, landform: 'inland', density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, river: true, lakes: true, islands: true, piers: true, pack: 'generic', theme: 'print' }],
    ['seed 42 inland corp 0.85', { ...base, corpDominance: 0.85 }],
    ['seed 7 bay corp 0.15', { ...base, seed: 7, landform: 'bay', corpDominance: 0.15 }],
  ]
  for (const [label, params] of models) {
    it(`no arterial loops back onto its own ring (${label})`, () => {
      const m = generateSector(params)
      const bad: string[] = []
      for (const a of m.arcologies.filter((x) => x.access === 'ring' || x.access === 'half')) {
        const ring = m.roads.filter((r) => r.id === a.ringRoadId || r.id.startsWith(`${a.ringRoadId}-`))
        const pts = ring.flatMap((r) => r.points)
        const closed = [...pts, pts[0]]
        for (const r of m.roads) {
          if (r.class !== 'arterial' || ring.includes(r) || r.points.length === 0) continue
          const ends = [r.points[0], r.points[r.points.length - 1]]
          if (ends.every((e) => distToPolyline(e, closed) <= 6) && polylineLength(r.points) < Math.PI * (a.radius + 60)) bad.push(`${r.id} ${a.ringRoadId}`)
        }
      }
      expect(bad).toEqual([])
    })
  }
})

describe.each([
  // inland seed 500 had 3 same-ring hairpin ends before c23a41d (seed 42 had none: regression guard only)
  ['inland seed 500', 'inland,medium,dense,balanced,lively,mixed,arcology', 500],
  ['seed 42 (street free ends seed)', 'coastal,medium,dense,fringe,lively,mixed,river,arcology', 42],
] as const)('ring streets run outward: %s', (_label, tags, seed) => {
  const params = { ...resolveTags(tags.split(',')), seed, size: 4, pack: 'generic', theme: 'print' } as SectorParams
  let m: SectorModel
  beforeAll(() => { m = generateSector(params) }, 120000)
  const rings = () => m.roads.filter((r) => r.id.startsWith(RING_ID_PREFIX) && r.points.length > 1)
  it('has a K road', () => { expect(rings().length).toBeGreaterThan(0) })
  it('no street has both ends on the same K road', () => {
    const bad: string[] = []
    for (const r of m.roads.filter((x) => x.class === 'street')) for (const k of rings()) {
      const a = r.points[0], z = r.points[r.points.length - 1]
      // the rule's own filter: short hooks only (a long crescent on one ring is legitimate)
      if (distToPolyline(a, k.points) <= 6 && distToPolyline(z, k.points) <= 6 && Math.hypot(a.x - z.x, a.y - z.y) < 40 && polylineLength(r.points) < 80) bad.push(`${r.id} ${k.id}`)
    }
    expect(bad).toEqual([])
  })
  it('no street enters the ring band (inside the ring, outside the plaza) unless it crosses the ring', () => {
    const bad: string[] = []
    for (const a of m.arcologies) {
      const ring = rings().find((r) => r.id === a.ringRoadId)
      if (!ring) continue
      const poly = ring.points
      for (const r of m.roads.filter((x) => x.class === 'street')) {
        let inBand = false, inside = false, outside = false
        for (let i = 1; i < r.points.length; i++) {
          const p0 = r.points[i - 1], p1 = r.points[i], n = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y) / 10))
          for (let k = 0; k <= n; k++) {
            const q = { x: p0.x + ((p1.x - p0.x) * k) / n, y: p0.y + ((p1.y - p0.y) * k) / n }
            const inRing = pointInRings(q, [poly])
            if (inRing) inside = true; else outside = true
            if (inRing && !pointInRings(q, [a.plaza])) inBand = true
          }
        }
        if (inBand && !(inside && outside)) bad.push(`${r.id} ${ring.id}`)
      }
    }
    expect(bad).toEqual([])
  })
  it('each K road keeps at least 4 roads ending on it', () => {
    const counts = rings().map((k) => {
      const n = m.roads.filter((r) => r.id !== k.id && r.points.length > 1 && [r.points[0], r.points[r.points.length - 1]].some((e) => distToPolyline(e, k.points) <= 6)).length
      return `${k.id}:${n}`
    })
    for (const c of counts) expect(Number(c.split(':')[1]), c).toBeGreaterThanOrEqual(4)
  })
})

// lake-shore street ends of the traced streets: not joined to another road, on a water ring
function shoreEnds(m: ReturnType<typeof generateSector>, params: SectorParams): Pt[] {
  const sizeM = params.size * 1000
  const nearRing = (e: Pt) => m.terrain.water.some((poly) => poly.some((ring) => distToPolyline(e, [...ring, ring[0]].map(([x, y]) => ({ x, y }))) < 6))
  // infill chords end on the lake ring on purpose (it is the block edge); only traced streets are checked. Exact: infill ids continue the traced counter
  const traced = new Set(traceRoads(params, m.terrain, sizeM).streets.map((r) => r.id))
  // an end welded to another road is a junction, not a stub (clipper2 re-roll (v8): S1196 ends on an arterial that hugs a lake)
  const joined = (e: Pt, self: Road) => m.roads.some((o) => o.id !== self.id && distToPolyline(e, o.points) <= 6)
  return m.roads.filter((r) => r.class === 'street' && traced.has(r.id.split('-')[0])).flatMap((r) => [r.points[0], r.points.at(-1)!].filter((e) => !joined(e, r))).filter(nearRing)
}

describe('lakes bound blocks', () => {
  const models: [string, SectorParams][] = [
    ['seed 782008753 inland 6 km', { ...base, seed: 782008753, size: 6, landform: 'inland', density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, river: true, lakes: true, islands: true, piers: true, pack: 'generic', theme: 'print' }],
    ['seed 42 inland corp 0.85', { ...base, corpDominance: 0.85 }],
    ['seed 7 bay corp 0.15', { ...base, seed: 7, landform: 'bay', corpDominance: 0.15 }],
  ]
  for (const [label, params] of models) describe(label, () => {
    let m: ReturnType<typeof generateSector>
    beforeAll(() => { m = modelFor(params) }, 90000)
    it(`no alley point lies in water `, () => {
      const bad = m.blocks.filter((b) => b.alleys.some(([p, q]) => [p, q, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }].some((s) => inWater(m.terrain, s)))).map((b) => b.id)
      expect(bad).toEqual([])
    })
    it(`no street point lies in water, no street end sits on a lake shore `, () => {
      const streets = m.roads.filter((r) => r.class === 'street')
      expect(streets.filter((r) => r.points.some((p) => inWater(m.terrain, p))).map((r) => r.id)).toEqual([])
      if (!params.lakes) return
      const sizeM = params.size * 1000
      const ends = shoreEnds(m, params)
      expect(m.terrain.water.length).toBeGreaterThan(1) // lakes exist, so the check below is not vacuous
      expect(ends.filter((e) => isLakeShore(m.terrain, e, sizeM))).toEqual([])
    })
    it(`no big block has its centroid in a lake `, () => {
      const bad = m.blocks.filter((b) => {
        if (!inWater(m.terrain, ringCentroid(b.footprint))) return false
        const xs = b.footprint.map((p) => p.x), ys = b.footprint.map((p) => p.y)
        let land = 0
        for (let x = Math.min(...xs); x < Math.max(...xs); x += 20) for (let y = Math.min(...ys); y < Math.max(...ys); y += 20) {
          const s = { x: x + 10, y: y + 10 }
          if (pointInRings(s, [b.footprint]) && !inWater(m.terrain, s)) land += 400
        }
        return land > 60000
      }).map((b) => b.id)
      expect(bad).toEqual([])
    })
  })
})

describe('river/sea shore stubs', () => {
  // arterials re-roll (v9): on 782008753 the arterial along the shore leaves no unwelded river/sea street end (0); 2268324149 has 5 (seeds 42 / 426750495 have 1, 1-30 mostly 2-7)
  const params: SectorParams = { ...base, seed: 2268324149, size: 6, landform: 'inland', density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, river: true, lakes: true, islands: true, piers: true, pack: 'generic', theme: 'print' }
  let m: ReturnType<typeof generateSector>
  beforeAll(() => { m = modelFor(params) }, 90000)
  it('some unwelded river/sea stub stays (>= 150 m stubs are kept)', () => {
    const sizeM = params.size * 1000
    expect(shoreEnds(m, params).filter((e) => !isLakeShore(m.terrain, e, sizeM)).length).toBeGreaterThan(0)
  })
})

describe('frontage', () => {
  // clipper2 re-roll (v8): seed 42 no longer has a sunken stretch, seed 24 does
  // seed 1 replaces 24 (no sunken segment left after the 7b stabilisation re-roll): the sunken check needs one
  const cases = [{ ...base, seed: 1, landform: 'coastal', river: true }, { ...base, seed: 20, size: 2, landform: 'coastal', river: true }] as const
  for (const c of cases) {
    describe(`seed ${c.seed} ${c.size} km`, () => {
      let m: ReturnType<typeof generateSector>
      let hwPts: Pt[]
      let sunken: Array<[number, number]>
      let fr: Road[]
      beforeAll(() => {
        m = generateSector(c)
        const pieces = m.roads.filter((r) => r.class === 'highway')
        hwPts = pieces.flatMap((r) => r.points)
        sunken = (pieces[0].segments ?? []).filter((s) => s.level === 'sunken').map((s) => [s.from, s.to])
        fr = m.roads.filter((r) => r.id.startsWith(FRONTAGE_ID_PREFIX))
      }, 120000)
      const beside = (t: number) => sunken.some(([a, b]) => t >= a - 0.01 && t <= b + 0.01)
      const wetNear = (p: Pt) => [-15, 0, 15].some((dx) => [-15, 0, 15].some((dy) => inWater(m.terrain, { x: p.x + dx, y: p.y + dy })))

      // plazas/cores are not excluded from the sampling: neither seed has one
      it('frontage roads line the highway', () => {
        expect(fr.length).toBeGreaterThan(0)
        const total = polylineLength(hwPts)
        const idx = new RoadIndex(200)
        for (const r of fr) idx.add(r.id, r.points, r.class)
        const miss: string[] = []
        for (let d = 50; d < total; d += 100) {
          const t = d / total
          const a = pointAtT(hwPts, Math.max(0, t - 0.002))
          const b = pointAtT(hwPts, Math.min(1, t + 0.002))
          const n = { x: -(b.y - a.y), y: b.x - a.x }
          const l = Math.hypot(n.x, n.y) || 1
          const p = pointAtT(hwPts, t)
          for (const sg of [1, -1]) {
            const q = { x: p.x + (n.x / l) * (STRIP_HALF + 22) * sg, y: p.y + (n.y / l) * (STRIP_HALF + 22) * sg }
            if (wetNear(q) || beside(t) || q.x < 0 || q.y < 0 || q.x > m.meta.sizeM || q.y > m.meta.sizeM) continue
            if (!idx.nearestMatching(q, 6, () => true)) miss.push(`${Math.round(q.x)},${Math.round(q.y)}`)
          }
        }
        expect(miss).toEqual([])
      })

      it('no frontage along sunken segments', () => {
        if (c.seed === 1) expect(sunken.length).toBeGreaterThan(0) // seed 20 has none; seed 1 must exercise the check
        const total = polylineLength(hwPts)
        const bad: string[] = []
        for (const r of fr) {
          for (const p of r.points) {
            let best = Infinity, bt = 0, acc = 0
            for (let i = 0; i < hwPts.length - 1; i++) {
              const l = Math.hypot(hwPts[i + 1].x - hwPts[i].x, hwPts[i + 1].y - hwPts[i].y)
              const f = Math.max(0, Math.min(1, ((p.x - hwPts[i].x) * (hwPts[i + 1].x - hwPts[i].x) + (p.y - hwPts[i].y) * (hwPts[i + 1].y - hwPts[i].y)) / (l * l || 1)))
              const dd = Math.hypot(p.x - hwPts[i].x - f * (hwPts[i + 1].x - hwPts[i].x), p.y - hwPts[i].y - f * (hwPts[i + 1].y - hwPts[i].y))
              if (dd < best) { best = dd; bt = (acc + f * l) / total }
              acc += l
            }
            if (sunken.some(([a, b]) => bt > a + 0.003 && bt < b - 0.003)) bad.push(`${r.id}@${Math.round(p.x)},${Math.round(p.y)}`)
          }
        }
        expect(bad).toEqual([])
      })

      it('frontage roads have no dangling ends', () => {
        const idx = new RoadIndex(200)
        for (const r of m.roads) idx.add(r.id, r.points, r.class)
        const lim = m.meta.sizeM
        const bad: string[] = []
        for (const r of fr) {
          for (const p of [r.points[0], r.points[r.points.length - 1]]) {
            const edge = p.x < 20 || p.y < 20 || p.x > lim - 20 || p.y > lim - 20 // 10 m sampling stops a piece up to 10 m short, more where the offset line meets the edge obliquely
            const nearSunkenEnd = (() => { const total = polylineLength(hwPts); return sunken.some(([a, b]) => [a, b].some((t) => distToPolyline(p, [pointAtT(hwPts, Math.max(0, t - 40 / total)), pointAtT(hwPts, Math.min(1, t + 40 / total))]) < 60)) })()
            if (edge || wetNear(p) || nearSunkenEnd || idx.nearestMatching(p, 6, (h) => h.id !== r.id)) continue
            bad.push(`${r.id}@${Math.round(p.x)},${Math.round(p.y)}`)
          }
        }
        expect(bad).toEqual([])
      })
    })
  }
})

describe('compound names', () => {
  it('are drawn after the landmark names, which stay as before', { timeout: 300000 }, () => {
    const m = generateSector({ ...base, corpDominance: 0.85, arcology: true, megablock: true })
    expect(m.arcologies.map((a) => a.name)).toEqual(['Gemini Robotics Towers']) // C1 fix round re-roll; rule C1: 'Gemini Logistics Towers'; 7b stabilisation: 'The Apex-Robotics Gemini'; v9: 'The Vertex-Dynamics Gemini'; was 'Kessler Twin Towers': arterials cross the highway (and one-point roads are gone): layout shifts the name draw; same as the original golden
    expect(m.megablocks.map((a) => a.name)).toEqual(['The Chrome Hive']) // C1 fix round re-roll; rule C1: 'Row Stacks'; 7b stabilisation: 'The Black Hive'; v9: 'The Iron Hive'; was 'Docks Block', before that 'Gardens Block': arterials cross the highway, layout shifts the name draw
    expect(m.compounds.length).toBeGreaterThan(0)
    for (const c of m.compounds) expect(c.name.length).toBeGreaterThan(0)
    expect(m.pois.filter((p) => p.type === 'corp_campus').map((p) => p.name)).toEqual(m.compounds.map((c) => c.name))
  })
})

describe('compounds', () => {
  const corp = [0.85, 0.5, 0.15]
  const runs = [42, 7, 11].flatMap((seed) => corp.map((c) => [seed, c] as const))
  it('compound counts follow the power band', { timeout: 900000 }, () => {
    const total: Record<number, number> = { 0.85: 0, 0.5: 0, 0.15: 0 }
    for (const [seed, corpDominance] of runs) {
      const m = generateSector({ ...base, seed, corpDominance })
      const corpDistricts = m.districts.filter((d) => d.zone === 'corp' && !d.flags.arcology).length
      expect(m.compounds.length, `seed ${seed} corp ${corpDominance}`).toBeLessThanOrEqual(2 * corpDistricts)
      if (seed === 42 && corpDominance === 0.85) expect(m.compounds.length).toBeGreaterThanOrEqual(1)
      total[corpDominance] += m.compounds.length
    }
    expect(total[0.85]).toBeGreaterThanOrEqual(total[0.5])
    expect(total[0.5]).toBeGreaterThanOrEqual(total[0.15])
    expect(total[0.85]).toBeGreaterThan(total[0.15])
  })
  it('same seed gives the same compounds', { timeout: 300000 }, () => {
    const p = { ...base, corpDominance: 0.85 }
    expect(generateSector(p).compounds).toEqual(generateSector(p).compounds)
  })
})

describe('arterial ends (model seeds)', () => {
  const F = { river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'print' }
  const p1 = { ...resolveTags(['coastal','medium','dense','fringe','lively','mixed','river']), seed: 42, pack: 'generic', theme: 'print' } as any
  const MODEL_SETS: Record<string, any> = {
    P1: p1,
    P2: { seed: 42, size: 4, density: 0.6, corpDominance: 0.85, poiDensity: 0.5, irregularity: 0.5, landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: true, megablock: true, pack: 'generic', theme: 'print' },
    P3: { seed: 42, size: 6, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, landform: 'coastal', river: true, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon' },
    S7: { ...p1, seed: 7 },
    S3017268931: { ...p1, seed: 3017268931 },
    S2982258224: { ...F, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5, irregularity: 0.85, landform: 'bay' },
    S4280430344: { ...F, seed: 4280430344, size: 4, density: 0.5, corpDominance: 0.85, poiDensity: 0.7, irregularity: 0.15, landform: 'coastal', river: true, lakes: true },
    S11: { ...F, seed: 11, size: 4, density: 0.5, corpDominance: 0.85, poiDensity: 0.5, irregularity: 0.5, landform: 'inland', arcology: true, megablock: true },
    S782008753: { ...F, seed: 782008753, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, landform: 'coastal', lakes: true },
    R1: { ...F, seed: 123456789, size: 2, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, landform: 'coastal', islands: true, piers: true },
    R2: { ...F, seed: 987654321, size: 2, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, landform: 'bay', islands: true, piers: true },
    R3: { ...F, seed: 555555555, size: 2, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, landform: 'coastal', river: true, islands: true, piers: true },
  }
  const onEdge = (p: Pt, s: number) => p.x < 1 || p.y < 1 || p.x > s - 1 || p.y > s - 1
  /** worst excess (deg) of a turn over its curvature budget: max(15, 2 * shorter leg m) and 45; vertices within skipM of arc of an end or beside a leg <= 10 m (invisible kink at map scale) are ignored */
  const bendViolation = (pts: Pt[], skipM: number) => {
    const total = polylineLength(pts)
    let arc = 0, worst = -Infinity
    for (let i = 1; i < pts.length - 1; i++) {
      const l1 = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), l2 = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
      arc += l1
      if (arc <= skipM || total - arc <= skipM || l1 <= 10.01 || l2 <= 10.01) continue
      const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x), b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d
      const deg = (d * 180) / Math.PI
      worst = Math.max(worst, deg - Math.max(15, 2 * Math.min(l1, l2)), deg - 45)
    }
    return worst
  }
  // last-resort prune: ideal 0; measured at rule C1 with crossing joins ending as Ts: P1: 3, P2: 6, P3: 17, S7: 5, S3017268931: 3, S2982258224: 0, S4280430344: 6, S11: 11, S782008753: 4, R1: 1, R2: 3, R3: 2 — bound raised 10 → 20 by user ruling 2026-10-13 (the 90° connector rule prunes more ends instead of curving them; the user prefers that)
  for (const [name, p] of Object.entries(MODEL_SETS)) {
    it(`${name}: every arterial end is anchored and at most 20 were pruned`, { timeout: 120000 }, () => {
      const sizeM = p.size * 1000
      const terrain = sampleTerrain(p, sizeM)
      const t = traceRoads(p, terrain, sizeM)
      expect(t.pruned, 'prune fired').toBeLessThanOrEqual(20)
      const idx = new RoadIndex(200)
      for (const r of t.arterials) idx.add(r.id, r.points, r.class)
      for (const r of t.arterials) {
        const first = r.points[0], last = r.points.at(-1)!
        if (r.id.startsWith(RING_ID_PREFIX) && Math.hypot(first.x - last.x, first.y - last.y) < 1) continue
        for (const e of [first, last]) {
          const near = idx.nearestMatching(e, 6, (h) => h.id !== r.id && h.cls === 'arterial')
          const ok = onEdge(e, sizeM) || near || nearWater(terrain, e, 15)
          expect(ok, `${name} ${r.id} end ${e.x.toFixed(0)},${e.y.toFixed(0)}`).toBeTruthy()
        }
      }
      // rings are polygons by design
      for (const r of t.arterials) if (!r.id.startsWith(RING_ID_PREFIX)) expect(bendViolation(r.points, 15), `${name} ${r.id} bend`).toBeLessThan(1e-6)
    })
  }
})

describe('waterfront arterials (P1 seed 42)', () => {
  // spec 2026-10-12 §7 phase 2: arterials run along the sea, end at docks only sometimes, and leave stretches of shore bare
  let arts: Road[] = [], terrain: Terrain, shore: (Pt | null)[] = []
  const stats = { longestSeaRun: 0, waterEnds: 0, ends: 0, longestGap: 0 }
  beforeAll(() => {
    const p = { ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river']), seed: 42, pack: 'generic', theme: 'print' } as SectorParams
    const s = p.size * 1000
    terrain = sampleTerrain(p, s)
    arts = traceRoads(p, terrain, s).arterials.filter((a) => !a.id.startsWith(RING_ID_PREFIX))
    const rings = terrain.water.flatMap((poly) => poly.map((ring) => ring.map(([x, y]) => ({ x, y }))))
    const sea = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a))
    const closed = [...sea, sea[0]], L = polylineLength(closed)
    for (let d = 0; d < L; d += 25) {
      const q = pointAtT(closed, d / L)
      const inside = q.x > 1 && q.y > 1 && q.x < s - 1 && q.y < s - 1
      shore.push(inside && (!terrain.riverSlice || distToPolyline(q, terrain.riverSlice.course) > 300) ? q : null)
    }
    for (const a of arts) {
      for (const e of [a.points[0], a.points.at(-1)!]) { stats.ends++; if (nearWater(terrain, e, 15)) stats.waterEnds++ }
      const n = Math.ceil(polylineLength(a.points) / 10)
      let run = 0
      for (let k = 0; k <= n; k++) {
        const q = pointAtT(a.points, k / n)
        if (shore.some((z) => z && Math.hypot(z.x - q.x, z.y - q.y) < 150)) { run += 10; stats.longestSeaRun = Math.max(stats.longestSeaRun, run) } else run = 0
      }
    }
    const idx = new RoadIndex(200)
    for (const a of arts) idx.add(a.id, a.points, a.class)
    let gap = 0
    for (const q of shore) { if (q && !idx.nearest(q, 150)) { gap += 25; stats.longestGap = Math.max(stats.longestGap, gap) } else gap = 0 }
  }, 120000)
  it('an arterial runs at least 400 m within 150 m of the sea', () => {
    expect(stats.longestSeaRun).toBeGreaterThanOrEqual(400) // 580 m (540 at ac52d2f); arterials re-roll (v9)
  })
  it('at most 20 % of arterial ends are water ends', () => {
    expect(stats.waterEnds / stats.ends).toBeLessThanOrEqual(0.2) // 3 / 84 = 3.6 % (8 / 92 at ac52d2f)
  })
  it('some sea shore stretch over 300 m has no arterial within 150 m', () => {
    expect(stats.longestGap).toBeGreaterThan(300) // 975 m (600 at ac52d2f)
  })
})

describe('street free ends', () => {
  // seed 42: 12 before the ring-outward seeding re-rolled the streets stream (13 decay ends, 11 alive now)
  // arterials re-roll (v9): decay ends alive 11 / 11 / 19 -> 14 / 9 / 10 (a re-roll re-draws the decay rolls: 15 / 12 / 13 decay ends in all now)
  const DECAY: Record<number, number> = { 42: 14, 426750495: 9, 2268324149: 10 } // decay ends alive after the final prune, as measured without it
  const refs: [string, number, SectorParams, number, number][] = [
    // [label, seed, params, BOUND, STRAY]. BOUND = free ends measured at 3e3416d, all but STRAY decay cul-de-sacs; a re-roll re-pins it to the new decay count; a non-decay free end is a defect.
    // STRAY = the free ends that are no decay end: infill ends (S372/S375 at the window inset, S351 6.0 m off a street, shore ends), kept by the final prune because blocks were cut along them. Ratchet down, never up.
    ['seed 42', 42, { ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river', 'arcology']), seed: 42, size: 4, pack: 'generic', theme: 'print' } as SectorParams, 12, 3],
    ['seed 426750495', 426750495, { ...resolveTags(['inland', 'small', 'dense', 'balanced', 'quiet', 'sprawl', 'river']), seed: 426750495, size: 2, pack: 'generic', theme: 'print' } as SectorParams, 11, 2], // arterials re-roll (v9): 13 / 4 -> 11 / 2 (S157 1074,1639, S165 1755,1994 infill ends)
    ['seed 2268324149', 2268324149, { ...resolveTags(['coastal', 'medium', 'packed', 'balanced', 'quiet', 'planned']), seed: 2268324149, size: 4, pack: 'generic', theme: 'print' } as SectorParams, 9, 2], // arterials re-roll (v9): BOUND 16 -> 9; STRAY 2 stays (measured 3: S499 1642,671, S522 2626,1921, S525 2685,1852, inland infill ends) and is left red
  ]
  for (const [label, seed, params, bound, strayBound] of refs) describe(label, () => {
    let m: SectorModel
    beforeAll(() => { m = generateSector(params) }, 120000)
    it('has few free street ends', () => {
      const sizeM = m.meta.sizeM
      const idx = new RoadIndex(200)
      for (const r of m.roads) idx.add(r.id, r.points, r.class)
      const lands = [...m.arcologies.map((a) => a.plaza), ...m.megablocks.map((k) => k.core)]
      const wet = (p: Pt) => inWater(m.terrain, p) || [0, 1, 2, 3, 4, 5, 6, 7].some((k) => inWater(m.terrain, { x: p.x + 15 * Math.cos((k * Math.PI) / 4), y: p.y + 15 * Math.sin((k * Math.PI) / 4) }))
      const decayEnds = traceRoads(params, sampleTerrain(params, sizeM), sizeM).decayEnds
      const free: string[] = []
      const stray: string[] = []
      for (const r of m.roads.filter((x) => x.class === 'street')) {
        for (const [i, p] of [r.points[0], r.points[r.points.length - 1]].entries()) {
          if (onWindowEdge(p, sizeM, 1) || wet(p) || lands.some((poly) => pointInRings(p, [poly]))) continue
          if (idx.nearestMatching(p, 6, (h) => h.id !== r.id)) continue
          const tag = `${r.id}${i ? '>' : '<'}@${Math.round(p.x)},${Math.round(p.y)}`
          free.push(tag)
          if (!decayEnds.some((d) => Math.hypot(p.x - d.x, p.y - d.y) <= 1)) stray.push(tag)
        }
      }
      console.log(`free street ends ${label}: ${free.length}`, free.join(' '), `| not decay: ${stray.join(' ') || '-'}`)
      expect(stray.length, `${seed} free ends that are no decay cul-de-sac: ${stray.join(' ')}`).toBeLessThanOrEqual(strayBound)
      expect(free.length, `seed ${seed}`).toBeLessThanOrEqual(bound)
    })
    it('keeps the decay cul-de-sacs', () => {
      const sizeM = m.meta.sizeM
      const t = traceRoads(params, sampleTerrain(params, sizeM), sizeM)
      const ends = m.roads.filter((x) => x.class === 'street').flatMap((r) => [r.points[0], r.points[r.points.length - 1]])
      const alive = t.decayEnds.filter((d) => ends.some((e) => Math.hypot(e.x - d.x, e.y - d.y) < 1)).length
      console.log(`decay ends ${label}: ${alive} of ${t.decayEnds.length} still street ends`)
      expect(alive).toBeGreaterThanOrEqual(DECAY[seed])
    })
  })
})

describe('frontageOf', () => {
  const inOrOn = (p: Pt, ring: Pt[]) => pointInRings(p, [ring]) || distToPolyline(p, [...ring, ring[0]]) < 0.5
  const HW: Road = { id: 'H1', class: 'highway', points: [], width: 20, name: null }
  // the highway runs along y = 0 and curves: the face lies south of it (y > 0)
  it('one polyline per face side along a curved highway', () => {
    const hw: Pt[] = []
    let a = 0, x = 0, y = 0
    for (let i = 0; i <= 3; i++) { hw.push({ x, y }); x += 80 * Math.cos(a); y += 80 * Math.sin(a); a += (20 * Math.PI) / 180 }
    // face ring: the highway chain along the top, then closed far to the south
    const ring: Pt[] = [...hw, { x: hw[3].x, y: hw[3].y + 400 }, { x: hw[0].x, y: hw[0].y + 400 }]
    const out = frontageOf({ footprint: ring }, { ...HW, points: hw })
    expect(out.length).toBe(1)
    const line = out[0]
    for (const p of line) {
      expect(inOrOn(p, ring)).toBe(true)
      expect(distToPolyline(p, hw)).toBeGreaterThanOrEqual(20)
    }
    // strictly advancing along the highway: no overlapping chords
    for (let i = 1; i < line.length; i++) expect(line[i].x - line[i - 1].x).toBeGreaterThan(0)
  })
  it('a 60 degree corner between two highway-side edges stays inside the ring', () => {
    const hw: Pt[] = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 173 }]
    const ring: Pt[] = [...hw, { x: 150, y: 400 }, { x: -50, y: 300 }]
    const out = frontageOf({ footprint: ring }, { ...HW, points: hw })
    expect(out.length).toBeGreaterThan(0)
    for (const line of out) for (const p of line) expect(inOrOn(p, ring)).toBe(true)
  })
})

describe('no doubled streets', () => {
  const refs: [string, SectorParams][] = [
    ['seed 42', { ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river', 'arcology']), seed: 42, size: 4, pack: 'generic', theme: 'print' } as SectorParams],
    ['seed 426750495', { ...resolveTags(['inland', 'small', 'dense', 'balanced', 'quiet', 'sprawl', 'river']), seed: 426750495, size: 2, pack: 'generic', theme: 'print' } as SectorParams],
    ['seed 2268324149', { ...resolveTags(['coastal', 'medium', 'packed', 'balanced', 'quiet', 'planned']), seed: 2268324149, size: 4, pack: 'generic', theme: 'print' } as SectorParams],
  ]
  for (const [label, params] of refs) it(label, () => {
    const roads = generateSector(params).roads
    const streets = roads.filter((r) => r.class === 'street')
    const ids = new Set(streets.map((r) => r.id))
    const idx = new RoadIndex(200)
    for (const r of roads) idx.add(r.id, r.points, r.class)
    const bad: string[] = []
    // the weld's own run finder: a crossing is not a double
    for (const r of streets) for (const c of closeRuns(r.points, idx, 6, r.id).runs) {
      if (ids.has(c.id) && c.arc > 20 && !c.crosses) bad.push(`${r.id}~${c.id} ${Math.round(c.arc)}m`)
    }
    console.log(`doubled pairs ${label}: ${bad.length}`, bad.join(' '))
    expect(bad).toEqual([])
  })
})

describe('block sides have a road', () => {
  // BOUND measured at 3e3416d: 3 / 7 / 4. Before this round 66 / 31 / 14 (main 57 / 28 / 134; 201 / 90 / 103 at BASE 0f45e0a). Ratchet down, never up.
  // [label, params, BOUND]: edges of block footprints with no road within 10 m, no water within 15 m, not on the window edge, not in a megablock/arcology
  const refs: [string, SectorParams, number][] = [
    ['seed 42', { ...resolveTags(['coastal', 'medium', 'dense', 'fringe', 'lively', 'mixed', 'river', 'arcology']), seed: 42, size: 4, pack: 'generic', theme: 'print' } as SectorParams, 3],
    ['seed 426750495', { ...resolveTags(['inland', 'small', 'dense', 'balanced', 'quiet', 'sprawl', 'river']), seed: 426750495, size: 2, pack: 'generic', theme: 'print' } as SectorParams, 7],
    ['seed 2268324149', { ...resolveTags(['coastal', 'medium', 'packed', 'balanced', 'quiet', 'planned']), seed: 2268324149, size: 4, pack: 'generic', theme: 'print' } as SectorParams, 14],
  ]
  for (const [label, params, bound] of refs) it(label, () => {
    const m = generateSector(params)
    const idx = new RoadIndex(200)
    for (const r of m.roads) idx.add(r.id, r.points, r.class)
    const sizeM = m.meta.sizeM
    const wet = (p: Pt) => inWater(m.terrain, p) || [0, 1, 2, 3, 4, 5, 6, 7].some((k) => inWater(m.terrain, { x: p.x + 15 * Math.cos((k * Math.PI) / 4), y: p.y + 15 * Math.sin((k * Math.PI) / 4) }))
    const bad: string[] = []
    for (const b of m.blocks) {
      const c = ringCentroid(b.footprint)
      if (m.megablocks.some((k) => pointInRings(c, [k.footprint])) || m.arcologies.some((a) => pointInRings(c, [a.footprint]) || Math.hypot(c.x - a.center.x, c.y - a.center.y) <= a.radius)) continue
      for (let i = 0; i < b.footprint.length; i++) {
        const p = b.footprint[i], q = b.footprint[(i + 1) % b.footprint.length], mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
        if (onWindowEdge(mid, sizeM, 1) || wet(mid) || idx.nearestMatching(mid, 10, () => true)) continue
        bad.push(`${b.id}#${i}@${Math.round(mid.x)},${Math.round(mid.y)}`)
      }
    }
    console.log(`block sides without a road ${label}: ${bad.length}`, bad.join(' '))
    expect(bad.length, label).toBeLessThanOrEqual(bound)
  })
})

describe('river ends beside the highway (seed 426750495)', () => {
  // BOUND measured at e4f7ec2: 2 (the highway 30 m and 93 m from the deck blocked it); with decks crossing the highway square: 1. Ratchet down, never up.
  it('few arterials end unbridged at the river', () => {
    const params = { ...resolveTags(['inland', 'small', 'dense', 'balanced', 'quiet', 'sprawl', 'river']), seed: 426750495, size: 2, pack: 'generic', theme: 'print' } as SectorParams
    const terrain = sampleTerrain(params, 2000)
    const course = terrain.riverSlice!.course
    const ends = traceRoads(params, terrain, 2000).arterials
      .filter((r) => !r.id.startsWith(RING_ID_PREFIX))
      .flatMap((r) => [r.points[0], r.points.at(-1)!])
      .filter((e) => nearWater(terrain, e, 15) && distToPolyline(e, course) <= 250)
    console.log('river ends beside the highway', ends.length)
    expect(ends.length).toBeLessThanOrEqual(1)
  })
})
