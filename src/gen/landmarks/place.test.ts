import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { buildRoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import { distToPolyline } from '../terrain/rivers'
import { sampleTerrain } from '../terrain'
import type { SectorParams, Terrain } from '../types'
import { octagon, placeLandmarks, ringRoad } from './place'

const mk = (o: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon', ...o,
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
  it('counts follow the power tag', () => {
    const hi = run(mk({ corpDominance: 0.85 })).out
    expect(hi.arcologies.length).toBeGreaterThanOrEqual(2)
    expect(hi.arcologies.length).toBeLessThanOrEqual(3)
    expect(hi.megablocks.length).toBeLessThanOrEqual(1)
    const mid = run(mk({ corpDominance: 0.5 })).out
    expect(mid.arcologies.length).toBeGreaterThanOrEqual(1)
    expect(mid.arcologies.length).toBeLessThanOrEqual(2)
    expect(mid.megablocks.length).toBeGreaterThanOrEqual(1)
    expect(mid.megablocks.length).toBeLessThanOrEqual(2)
    const lo = run(mk({ corpDominance: 0.15 })).out
    expect(lo.arcologies.length).toBeLessThanOrEqual(1)
    expect(lo.megablocks.length).toBeGreaterThanOrEqual(2)
    expect(lo.megablocks.length).toBeLessThanOrEqual(4)
  })
  it('a 2 km sector has at most one of each', () => {
    for (const c of [0.85, 0.5, 0.15]) {
      const { out } = run(mk({ size: 2, corpDominance: c }))
      expect(out.arcologies.length).toBeLessThanOrEqual(1)
      expect(out.megablocks.length).toBeLessThanOrEqual(1)
    }
  })
  it('landmarks keep their distances', () => {
    for (const seed of [42, 7, 99]) {
      const p = mk({ seed, landform: 'coastal', river: true, corpDominance: 0.5 })
      const { out, terrain, hw } = run(p)
      const water = terrain.water.flatMap((poly) => poly.flatMap((r) => {
        const l = r.map(([x, y]) => ({ x, y })); return [[...l, l[0]]]
      }))
      const centres = [...out.arcologies, ...out.megablocks].map((l) => l.center)
      for (const c of centres) {
        for (const line of water) expect(distToPolyline(c, line)).toBeGreaterThanOrEqual(150)
        if (hw.points.length > 1) expect(distToPolyline(c, hw.points)).toBeGreaterThanOrEqual(250)
      }
      for (const a of out.arcologies) {
        for (const b of out.arcologies) if (a !== b) expect(d(a.center, b.center)).toBeGreaterThanOrEqual(900)
        for (const m of out.megablocks) expect(d(a.center, m.center)).toBeGreaterThanOrEqual(700)
      }
    }
  })
  it('works without a highway', () => {
    expect(run(mk(), false).out.arcologies.length).toBeGreaterThan(0)
  })
  it('ring road is closed and inside the window', () => {
    const { out, sizeM } = run(mk({ corpDominance: 0.85 }))
    expect(out.arcologies.length).toBeGreaterThan(0)
    for (const a of out.arcologies) {
      const r = ringRoad(a)
      expect(r.id).toBe(a.ringRoadId)
      expect(r.points).toHaveLength(49)
      expect(r.points[48]).toEqual(r.points[0])
      for (const p of r.points) {
        expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(sizeM)
        expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(sizeM)
      }
    }
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
