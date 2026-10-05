import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { buildRoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import { distToPolyline } from '../terrain/rivers'
import { sampleTerrain } from '../terrain'
import { inWater } from '../sector/bridges'
import type { Arcology, SectorParams, Terrain } from '../types'
import { octagon, placeLandmarks, ringRoad } from './place'

const mk = (o: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon', ...o,
})
const run = (p: SectorParams, withHighway = true) => {
  const sizeM = p.size * 1000
  const terrain = sampleTerrain(p, sizeM)
  const hw = traceHighway(p, terrain, sizeM).road
  const field = buildRoadField(p, terrain, sizeM)
  return { terrain, hw, sizeM, out: placeLandmarks(p, terrain, sizeM, withHighway ? hw : undefined, field) }
}
const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

describe('placeLandmarks', () => {
  it('is deterministic', () => {
    expect(run(mk()).out).toEqual(run(mk()).out)
  })
  it('designs do not repeat within a sector', () => {
    // ponytail: seed 42 inland 4 km corp 0.85 yields 2 arcologies; 3+ needs a larger sector, asserted on whatever count the seeds give
    for (const o of [{ seed: 42, corpDominance: 0.85 }, { seed: 7, corpDominance: 0.9, size: 6 }, { seed: 11, corpDominance: 0.9, size: 6 }]) {
      const ds = run(mk(o)).out.arcologies.map((a) => a.design)
      expect(new Set(ds).size).toBe(ds.length)
    }
    expect(run(mk({ seed: 42, corpDominance: 0.85 })).out.arcologies.length).toBeGreaterThanOrEqual(1)
  })
  // [lo, hi] per cell, p cells are [0, 1]; rows corp 0.85 / balanced 0.5 / fringe 0.15, columns 2 / 4 / 6 km. Only hi is asserted: placement may fall short of the drawn count when space runs out.
  const ARC = [[[0, 1], [1, 2], [2, 3]], [[0, 0], [0, 1], [0, 1]], [[0, 0], [0, 0], [0, 1]]]
  const MEGA = [[[0, 0], [0, 0], [0, 1]], [[0, 1], [0, 1], [1, 2]], [[1, 1], [1, 3], [2, 4]]]
  const cells = () => [42, 7, 1443928265].flatMap((seed) => [2, 4, 6].flatMap((size, c) => [0.85, 0.5, 0.15].map((corp, r) => ({ seed, size, corp, r, c }))))
  it('counts follow the table', () => {
    for (const { seed, size, corp, r, c } of cells()) {
      const { out } = run(mk({ seed, size, corpDominance: corp, landform: 'coastal', river: true }))
      const at = `${seed}/${size}km/${corp}`
      expect(out.arcologies.length, `arc ${at}`).toBeLessThanOrEqual(ARC[r][c][1])
      expect(out.megablocks.length, `mega ${at}`).toBeLessThanOrEqual(MEGA[r][c][1])
    }
  }, 1_800_000)
  it('toggles guarantee a landmark', () => {
    // find an untoggled cell whose count is 0, then the toggle must give exactly 1
    const zero = cells().find(({ seed, size, corp }) => {
      const { out } = run(mk({ seed, size, corpDominance: corp }))
      return out.arcologies.length === 0
    })!
    expect(zero).toBeDefined()
    const { out } = run(mk({ seed: zero.seed, size: zero.size, corpDominance: zero.corp, arcology: true }))
    expect(out.arcologies.length).toBe(1)
  }, 1_800_000)
  it('a 2 km sector has at most one of each', () => {
    for (const c of [0.85, 0.5, 0.15]) {
      const { out } = run(mk({ size: 2, corpDominance: c }))
      expect(out.arcologies.length).toBeLessThanOrEqual(1)
      expect(out.megablocks.length).toBeLessThanOrEqual(1)
    }
  })
  it('landmarks keep their distances', () => {
    for (const seed of [42, 7, 99]) {
      const p = mk({ seed, landform: 'coastal', river: true, corpDominance: 0.5, arcology: true, megablock: true })
      const { out, terrain, hw } = run(p)
      const water = terrain.water.flatMap((poly) => poly.flatMap((r) => {
        const l = r.map(([x, y]) => ({ x, y })); return [[...l, l[0]]]
      }))
      const centres = [...out.arcologies, ...out.megablocks].map((l) => l.center)
      expect(centres.length).toBeGreaterThan(0)
      for (const c of centres) {
        for (const line of water) expect(distToPolyline(c, line)).toBeGreaterThanOrEqual(200)
        if (hw.points.length > 1) expect(distToPolyline(c, hw.points)).toBeGreaterThanOrEqual(250)
      }
      for (const a of out.arcologies) {
        for (const b of out.arcologies) if (a !== b) expect(d(a.center, b.center)).toBeGreaterThanOrEqual(900)
        for (const m of out.megablocks) expect(d(a.center, m.center)).toBeGreaterThanOrEqual(700)
      }
      for (const a of out.megablocks) for (const b of out.megablocks) if (a !== b) expect(d(a.center, b.center)).toBeGreaterThanOrEqual(700)
    }
  })
  it('ring roads and cores stay on land and off the highway', () => {
    let n = 0
    for (const seed of [42, 7, 99]) for (const corpDominance of [0.85, 0.5, 0.15]) {
      const { out, terrain, hw } = run(mk({ seed, landform: 'coastal', river: true, corpDominance }))
      const pts = [...out.arcologies.flatMap((a) => ringRoad(a)?.points ?? []), ...out.megablocks.flatMap((m) => m.core)]
      n += out.arcologies.length + out.megablocks.length
      for (const p of pts) {
        expect(inWater(terrain, p)).toBe(false)
        if (hw && hw.points.length > 1) expect(distToPolyline(p, hw.points)).toBeGreaterThanOrEqual(100)
      }
    }
    expect(n).toBeGreaterThan(0)
  }, 90000)
  it('works without a highway', () => {
    expect(run(mk(), false).out.arcologies.length).toBeGreaterThan(0)
  })
  it('access kinds vary, designs x access never repeat, draws are deterministic', () => {
    // 4 km inland corp 0.85: seed 42 embedded, 7 ring, 11 half + ring, 5 ring + boulevard
    const kinds = new Set<string>()
    for (const seed of [42, 7, 11, 5, 13]) {
      const { out } = run(mk({ seed, corpDominance: 0.85 }))
      for (const a of out.arcologies) {
        kinds.add(a.access)
        expect(a.access === 'ring' ? a.ringShape : a.ringShape ?? 'none').toBeDefined()
        expect(a.side !== undefined).toBe(a.access === 'half' || a.access === 'boulevard')
      }
      const pairs = out.arcologies.map((a) => `${a.design}/${a.access}`)
      expect(new Set(pairs).size).toBe(pairs.length)
    }
    expect(kinds.size).toBeGreaterThanOrEqual(2)
    expect([...kinds].sort()).toEqual(['boulevard', 'embedded', 'half', 'ring'])
  }, 600000)
  it('ring shapes: closed, vertex counts per shape; half ring open; boulevard/embedded none', () => {
    const base = run(mk({ seed: 42, corpDominance: 0.85 })).out.arcologies[0]
    const R = base.radius + 60
    const at = (o: Partial<Arcology>) => ringRoad({ ...base, ...o })!
    for (const [shape, n] of [['circle', 49], ['square', 49], ['octagon', 9]] as const) {
      const r = at({ access: 'ring', ringShape: shape })
      expect(r.id).toBe(base.ringRoadId)
      expect(r.points).toHaveLength(n)
      expect(r.points.at(-1)).toEqual(r.points[0])
      for (const p of r.points) expect(d(p, base.center)).toBeLessThanOrEqual(R * 1.3)
    }
    // the square's sides are R from the centre along the field angle
    const sq = at({ access: 'ring', ringShape: 'square', angle: 0 }).points
    expect(Math.max(...sq.map((p) => p.x - base.center.x))).toBeCloseTo(R, 5)
    const half = at({ access: 'half', side: 0, angle: 0 }).points
    expect(half).toHaveLength(25)
    expect(half[0]).not.toEqual(half[24])
    expect(half[0].x).toBeCloseTo(base.center.x + R, 5)
    expect(half[24].x).toBeCloseTo(base.center.x - R, 5)
    expect(ringRoad({ ...base, access: 'boulevard' })).toBeNull()
    expect(ringRoad({ ...base, access: 'embedded' })).toBeNull()
    expect(octagon({ x: 0, y: 0 }, 10, 0)).toHaveLength(8)
  })
  it('no candidate -> zero landmarks, no throw', () => {
    const p = mk({ corpDominance: 0.5 })
    const terrain: Terrain = {
      landform: 'coastal', river: false, lakes: false, islands: false, metroSeed: 1,
      land: [[[[0, 0], [200, 0], [200, 200], [0, 200]]]],
      water: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
      riverSlice: null,
    }
    const field = buildRoadField(p, terrain, 4000)
    expect(placeLandmarks(p, terrain, 4000, undefined, field)).toEqual({ arcologies: [], megablocks: [] })
  })
})
