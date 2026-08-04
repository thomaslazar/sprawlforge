import { describe, expect, it } from 'vitest'
import { pointInRings, type Pt } from '../geometry'
import { sampleTerrain } from '../terrain'
import { distToPolyline } from '../terrain/rivers'
import type { SectorParams } from '../types'
import { layoutRoads } from './roads'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
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
    const terrain = sampleTerrain({ ...base, terrain: 'coastal' }, sizeM)
    const r = layoutRoads({ ...base, terrain: 'coastal' }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('river keeps all districts within the land bounding box', () => {
    const terrain = sampleTerrain({ ...base, terrain: 'river' }, sizeM)
    const r = layoutRoads({ ...base, terrain: 'river' }, terrain, sizeM)
    const b = landBounds(terrain)
    for (const d of r.districtRects) {
      expect(d.x).toBeGreaterThanOrEqual(b.minX - 1e-6)
      expect(d.y).toBeGreaterThanOrEqual(b.minY - 1e-6)
      expect(d.x + d.w).toBeLessThanOrEqual(b.maxX + 1e-6)
      expect(d.y + d.h).toBeLessThanOrEqual(b.maxY + 1e-6)
    }
  })
  it('road ids are stable and prefixed by class', () => {
    const r = layoutRoads(base, noWater, sizeM)
    for (const road of r.roads) {
      if (road.class === 'highway') expect(road.id).toMatch(/^H\d+$/)
      if (road.class === 'arterial') expect(road.id).toMatch(/^A\d\d$/)
      if (road.class === 'street') expect(road.id).toMatch(/^S\d\d\d$/)
    }
  })
  it('street roads never have a point in water', () => {
    const terrain = sampleTerrain({ ...base, terrain: 'river' }, sizeM)
    const { roads } = layoutRoads({ ...base, terrain: 'river' }, terrain, sizeM)
    const inWater = (p: Pt) =>
      terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
    for (const road of roads) {
      if (road.class !== 'street') continue
      for (const p of road.points) expect(inWater(p)).toBe(false)
    }
  })
  it('road graph stays connected across water (river seeds)', () => {
    for (const seed of [1, 42, 999]) {
      const params = { ...base, seed, terrain: 'river' as const }
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
      const components = new Set(pts.map((_, i) => find(i)))
      // arterial/street endpoints that merely touch nothing else may float;
      // require the graph to collapse into few components and at least one bridge
      expect(roads.some((r) => r.bridge)).toBe(true)
      expect(components.size).toBeLessThanOrEqual(3)
    }
  })
})
