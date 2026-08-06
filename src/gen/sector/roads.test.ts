import { describe, expect, it } from 'vitest'
import { bboxOf, pointInRings, type Pt } from '../geometry'
import { sampleTerrain } from '../terrain'
import { distToPolyline } from '../terrain/rivers'
import type { SectorParams, Terrain } from '../types'
import { districtDomains, layoutRoads, layoutStreets, partitionDistricts } from './roads'
import { assignZones } from './zoning'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000
const noWater = sampleTerrain(base, sizeM)

function landBounds(terrain: ReturnType<typeof sampleTerrain>) {
  const pts = terrain.land.flat().flat()
  return {
    minX: Math.min(...pts.map(([x]) => x)),
    minY: Math.min(...pts.map(([, y]) => y)),
    maxX: Math.max(...pts.map(([x]) => x)),
    maxY: Math.max(...pts.map(([, y]) => y)),
  }
}

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
  it('coast keeps all districts within the land bounding box', () => {
    const terrain = sampleTerrain({ ...base, landform: 'coastal' }, sizeM)
    const r = layoutRoads({ ...base, landform: 'coastal' }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('river keeps all districts within the land bounding box', () => {
    const terrain = sampleTerrain({ ...base, river: true }, sizeM)
    const r = layoutRoads({ ...base, river: true }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('tolerates an all-water window (I5): no land yields no districts, no crash', () => {
    const allWater: Terrain = {
      landform: 'coastal', river: false, lakes: false, islands: false,
      metroSeed: 1,
      water: [[[[0, 0], [sizeM, 0], [sizeM, sizeM], [0, sizeM]]]],
      land: [],
      riverSlice: null,
    }
    expect(() => layoutRoads(base, allWater, sizeM)).not.toThrow()
    const r = layoutRoads(base, allWater, sizeM)
    expect(r.districtRects).toEqual([])
    expect(r.blocksByDistrict).toEqual([])
    expect(r.roads).toEqual([])
  })
  it('road ids are stable and prefixed by class', () => {
    const r = layoutRoads(base, noWater, sizeM)
    for (const road of r.roads) {
      if (road.class === 'highway') expect(road.id).toMatch(/^H\d+$/)
      if (road.class === 'arterial') expect(road.id).toMatch(/^A\d\d$/)
      if (road.class === 'street') expect(road.id).toMatch(/^S\d\d\d$/)
    }
  })
  it('no non-bridge road of any class ever has a point in water', { timeout: 20000 }, () => {
    // strong invariant: only the bridge deck may span water — every host
    // road (street, arterial, or highway) must be truncated/split at the
    // shoreline instead (the old code let arterials/highways draw straight
    // through the water under a "bridge floats over it" excuse). Covers
    // both a river cutting through inland, and a coastal shoreline — the
    // two shapes of "water" the invariant has to hold against.
    const cases = [
      ...[1, 42, 119560026].map((seed) => ({ ...base, seed, river: true })),
      ...[1, 42, 999].map((seed) => ({ ...base, seed, landform: 'coastal' as const })),
    ]
    for (const params of cases) {
      const terrain = sampleTerrain(params, sizeM)
      const { roads } = layoutRoads(params, terrain, sizeM)
      const inWater = (p: Pt) =>
        terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
      for (const road of roads) {
        if (road.bridge) continue
        for (const p of road.points) expect(inWater(p)).toBe(false)
      }
    }
  })
  it('joins at least one arterial across the highway gap (no uncrossable wall)', () => {
    const params: SectorParams = {
      seed: 119560026, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
      landform: 'coastal', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
    }
    const terrain = sampleTerrain(params, sizeM)
    const { roads } = layoutRoads(params, terrain, sizeM)
    const hw = roads.find((r) => r.class === 'highway')
    expect(hw).toBeDefined()
    const hx = hw!.points[0].x
    const crosses = roads.some(
      (r) =>
        !r.bridge &&
        r.class !== 'highway' &&
        r.points.some((p) => p.x < hx - 10) &&
        r.points.some((p) => p.x > hx + 10),
    )
    expect(crosses).toBe(true)
  })
  it('every bridge is collinear with its host road, or perpendicular-ish to a river crossing', { timeout: 20000 }, () => {
    const angleOf = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x)
    const lineDiff = (a1: number, a2: number) => {
      let diff = Math.abs(a1 - a2) % Math.PI
      if (diff > Math.PI / 2) diff = Math.PI - diff
      return diff
    }
    for (const seed of [1, 42, 119560026]) {
      for (const [landform, river] of [
        ['inland', true],
        ['coastal', false],
      ] as const) {
        const params = { ...base, seed, landform, river }
        const terrain = sampleTerrain(params, sizeM)
        const { roads } = layoutRoads(params, terrain, sizeM)
        for (const bridge of roads.filter((r) => r.bridge)) {
          const [p, q] = bridge.points
          const bridgeAngle = angleOf(p, q)
          const host = roads.find(
            (r) =>
              !r.bridge &&
              r.class === bridge.class &&
              r.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < 1 || Math.hypot(pt.x - q.x, pt.y - q.y) < 1),
          )
          if (host) {
            const hostAngle = angleOf(host.points[0], host.points[host.points.length - 1])
            if (lineDiff(bridgeAngle, hostAngle) < (5 * Math.PI) / 180) continue // collinear — OK
          }
          // not collinear with any host piece — the only by-spec exception is
          // a river crossing re-oriented perpendicular to local flow, which
          // by construction lands near the river course itself
          expect(terrain.riverSlice).not.toBeNull()
          const course = terrain.riverSlice!.course
          const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
          const nearRiver = course.some(
            (_, i) => i < course.length - 1 && distToPolyline(mid, [course[i], course[i + 1]]) < 300,
          )
          expect(nearRiver).toBe(true)
        }
      }
    }
  })
  it('road graph stays connected across water (river seeds)', { timeout: 20000 }, () => {
    for (const seed of [1, 42, 999]) {
      const params = { ...base, seed, river: true }
      const terrain = sampleTerrain(params, 4000)
      const { roads } = layoutRoads(params, terrain, 4000)
      // union-find over road endpoints; endpoints within 20 m are joined
      const pts: Pt[] = []
      const parent: number[] = []
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
      const idx = (p: Pt): number => {
        for (let i = 0; i < pts.length; i++)
          if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) < 20) return i
        pts.push(p)
        parent.push(pts.length - 1)
        return pts.length - 1
      }
      for (const r of roads) {
        const a = idx(r.points[0])
        const b = idx(r.points[r.points.length - 1])
        parent[find(a)] = find(b)
        // segments cross mid-polyline too: join consecutive points
        for (let i = 1; i < r.points.length; i++) parent[find(idx(r.points[i - 1]))] = find(idx(r.points[i]))
      }
      // T-junctions: road A's endpoint touching mid-span of road B (not B's own
      // endpoints) is a real intersection, not a gap — BSP cut endpoints sit
      // exactly gap/2 (up to 9m for an arterial) off the parent road's centerline,
      // and a bridge landing needs a little more slack. Join on point-to-segment
      // distance, reusing the same math nearestOnPolyline uses for river distance.
      for (const A of roads) {
        for (const B of roads) {
          if (A === B) continue
          for (const end of [A.points[0], A.points[A.points.length - 1]]) {
            for (let i = 0; i < B.points.length - 1; i++) {
              if (distToPolyline(end, [B.points[i], B.points[i + 1]]) <= 30)
                parent[find(idx(end))] = find(idx(B.points[i]))
            }
          }
        }
      }
      const sizes = new Map<number, number>()
      pts.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1))
      // honest bridge geometry (no sideways "pull onto the network" hack)
      // means a handful of small, genuinely isolated stubs are expected —
      // a short street clip near the shoreline, or a lone bridge into a
      // pocket-sized block. The real invariant: the map isn't bisected into
      // large disconnected halves — nearly everything sits in one component.
      expect(roads.some((r) => r.bridge)).toBe(true)
      expect(Math.max(...sizes.values()) / pts.length).toBeGreaterThan(0.9)
    }
  })
})

// dryTerrain: all-land, no water — reuse the existing all-land fixture
const dryTerrain = noWater

const lakeTerrain: Terrain = {
  landform: 'inland', river: false, lakes: true, islands: false, metroSeed: 1,
  water: [[[[1500, 1500], [2500, 1500], [2500, 2500], [1500, 2500]]]],
  land: [[
    [[0, 0], [4000, 0], [4000, 4000], [0, 4000]],
    [[1500, 1500], [1500, 2500], [2500, 2500], [2500, 1500]], // lake hole
  ]],
  riverSlice: null,
}

const riverTerrain: Terrain = {
  landform: 'inland', river: true, lakes: false, islands: false, metroSeed: 1,
  water: [[[[1900, 0], [2100, 0], [2100, 4000], [1900, 4000]]]],
  land: [
    [[[0, 0], [1900, 0], [1900, 4000], [0, 4000]]],
    [[[2100, 0], [4000, 0], [4000, 4000], [2100, 4000]]],
  ],
  riverSlice: { course: [{ x: 2000, y: 0 }, { x: 2000, y: 4000 }], width: 250 },
}

// gap (400 m) wider than 2×riverSlice.width (200) but under 6× (600) — a
// tight ×2 reconnect corridor misses both banks; ×6 (the actual carve can
// run much wider than the metro-wide width constant) reaches them
const wideRiverTerrain: Terrain = {
  landform: 'inland', river: true, lakes: false, islands: false, metroSeed: 1,
  water: [[[[1800, 0], [2200, 0], [2200, 4000], [1800, 4000]]]],
  land: [
    [[[0, 0], [1800, 0], [1800, 4000], [0, 4000]]],
    [[[2200, 0], [4000, 0], [4000, 4000], [2200, 4000]]],
  ],
  riverSlice: { course: [{ x: 2000, y: 0 }, { x: 2000, y: 4000 }], width: 100 },
}

const isletTerrain: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: true, metroSeed: 1,
  water: [],
  land: [
    [[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]],
    [[[10, 10], [40, 10], [40, 20], [10, 20]]], // 300 m² islet, well under MIN_DISTRICT_AREA
  ],
  riverSlice: null,
}

describe('districtDomains', () => {
  it('returns land outer rings, filling lake holes', () => {
    const domains = districtDomains(lakeTerrain)
    expect(domains).toHaveLength(1)
    expect(domains[0].length).toBeGreaterThanOrEqual(4)
  })

  it('reconnects river banks into one domain', () => {
    const domains = districtDomains(riverTerrain)
    expect(domains).toHaveLength(1)
  })

  it('reconnects banks even when the channel runs wider than 2x the width constant', () => {
    const domains = districtDomains(wideRiverTerrain)
    expect(domains).toHaveLength(1)
  })

  it('drops islet rings below the minimum district area', () => {
    const domains = districtDomains(isletTerrain)
    expect(domains).toHaveLength(1)
  })
})

describe('partitionDistricts', () => {
  it('is deterministic and covers the domain with districts', () => {
    const a = partitionDistricts(base, dryTerrain)
    const b = partitionDistricts(base, dryTerrain)
    expect(a).toEqual(b)
    expect(a.districtPolys.length).toBeGreaterThan(3)
    expect(a.roads.some((r) => r.class === 'arterial')).toBe(true)
  })

  it('adds a highway for size >= 3', () => {
    const { roads } = partitionDistricts({ ...base, size: 4 }, dryTerrain)
    expect(roads.some((r) => r.class === 'highway')).toBe(true)
  })
})

describe('layoutStreets', () => {
  it('partitions each district by its own irregularity, 1:1 indexed', () => {
    const { districtPolys } = partitionDistricts(base, dryTerrain)
    const districts = assignZones(districtPolys, base, dryTerrain)
    const { streets, blocksByDistrict } = layoutStreets(districts, base)
    expect(blocksByDistrict).toHaveLength(districts.length)
    expect(streets.length).toBeGreaterThan(0)
    districts.forEach((d, i) => {
      for (const block of blocksByDistrict[i]) {
        const bb = bboxOf(block)
        expect(bb.x).toBeGreaterThanOrEqual(d.bounds.x - 1)
        expect(bb.x + bb.w).toBeLessThanOrEqual(d.bounds.x + d.bounds.w + 1)
      }
    })
  })
})
