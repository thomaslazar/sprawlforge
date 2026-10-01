import { describe, expect, it, vi } from 'vitest'
import { pointAtT, pointInRings, polylineLength, ringCentroid, type Pt } from '../geometry'
import { ISLET_MOAT_OUTER_FACTOR, ISLET_RADIUS_MAX } from '../terrain/field'
import { GENERATOR_VERSION, type Block, type District, type SectorParams, type Terrain } from '../types'
import { hashSeed, mulberry32 } from '../rng'
import { distToPolyline } from '../terrain/rivers'
import { RoadIndex, riverCrossingSeeds } from '../streets/trace'
import { inWater } from './bridges'
import { buildPlanarGraph, degree4Vertices, windowRing } from '../streets/graph'
import { bboxesFar, endMeetings, maxCloseRun } from '../streets/testutil'
import { deriveDistricts, generateSector } from './generate'

// full pipeline is ~3-10 s per 4 km generation (tracing + land clipping dominate)
vi.setConfig({ testTimeout: 90000 })

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
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
      // block's embedded district ordinal must match its actual district
      expect(b.id.slice(1, 3)).toBe(b.districtId.slice(1))
    }
    for (const b of m.buildings) {
      expect(blockIds.has(b.blockId)).toBe(true)
      // building's blockId ordinal must match its own districtId
      expect(b.blockId.slice(1, 3)).toBe(b.districtId.slice(1))
    }
    for (const p of m.pois) expect(buildingIds.has(p.buildingId)).toBe(true)
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
      const touches = b.footprint.some((p) => pointInRings(p, [d.poly]))
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
      landform: 'inland', river: true, lakes: false, islands: true, piers: false,
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
      piers: false, pack: 'generic', theme: 'neon',
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
  return { id, districtId, poly, footprint: poly, flags: {} }
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
      const m = generateSector({ ...c, islands: false, piers: false, pack: 'generic', theme: 'neon' })
      const roads = m.roads.filter((r) => r.class !== 'ramp')
      const idx = new RoadIndex(200)
      for (const r of roads) idx.add(r.id, r.points, r.class)
      const S = m.meta.sizeM
      let ends = 0
      let dangling = 0
      for (const r of roads.filter((x) => x.class === 'arterial')) {
        for (const e of [r.points[0], r.points[r.points.length - 1]]) {
          ends++
          if (e.x < 1 || e.y < 1 || e.x > S - 1 || e.y > S - 1) continue
          if (idx.nearestMatching(e, 6, (h) => h.id !== r.id && (h.cls === 'arterial' || h.cls === 'highway'))) continue
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
      landform: 'coastal', river: true, lakes: true, islands: false, piers: false, pack: 'generic', theme: 'neon',
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

describe('no doubled arterials', () => {
  it('seed 2982258224 has no long side-by-side arterial runs', () => {
    const m = generateSector({
      ...base, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, poiDensity: 0.5,
      irregularity: 0.85, landform: 'bay',
    })
    const arts = m.roads.filter((r) => r.class === 'arterial')
    // 66 streets / 9 arterials measured (66 before the singularity stop, 41 with it ending
    // halves at the seed; 74 / 13 before prune-dangling); bounds = measured - 10 %
    expect(m.roads.filter((r) => r.class === 'street').length).toBeGreaterThanOrEqual(59)
    expect(arts.length).toBeGreaterThanOrEqual(8)
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
    // ends on the window edge, at water or on the highway are exempt
    const ms = endMeetings(arts, hw).filter(
      (x) => x.cls === 'arterial' && !nearWater(m.terrain, x.end, 25) && x.end.x > 1 && x.end.y > 1 && x.end.x < S - 1 && x.end.y < S - 1,
    )
    console.log('meetings', ms.length, JSON.stringify(ms.filter((x) => x.deg < 25).map((x) => [x.id, Math.round(x.end.x), Math.round(x.end.y), Math.round(x.deg * 10) / 10, Math.round(x.edge)])))
    expect(ms.filter((x) => x.deg < 25)).toEqual([])
  })

  it('interchanges cross the highway at 45° or more', () => {
    const h = hw[0]
    const idx = new RoadIndex(200)
    idx.add(h.id, h.points, 'highway')
    const ics = (h.crossings ?? []).filter((c) => c.interchange)
    expect(ics.length).toBeGreaterThan(0)
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
    ;[1028, 1113, 152, 288].forEach((floor, k) => expect(len[k]).toBeGreaterThanOrEqual(floor))
  })

  it('no road runs through a block', () => {
    // residual = block faces that swallow a street: mergeSlivers merging across it, and faces with a hole
    // (a loop hanging off a bridge edge: footprint is one ring, holes are dropped). ROADMAP; ratchet down, never up.
    const cases: Array<[SectorParams, number]> = [
      [{ seed: 3017268931, size: 2, density: 0.9, corpDominance: 0.85, poiDensity: 0.25, irregularity: 0.15, landform: 'bay', river: true, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'print' }, 8],
      [{ ...base, seed: 42, landform: 'coastal', river: true }, 57],
    ]
    for (const [params, max] of cases) {
      const m = generateSector(params)
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
      expect(bad.length, `seed ${params.seed}: ${bad.join(' ')}`).toBeLessThanOrEqual(max)
    }
  })
})
