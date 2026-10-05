import { describe, expect, it } from 'vitest'
import { ringArea, type Pt } from '../geometry'
import { sampleTerrain } from '../terrain'
import type { Road, SectorParams } from '../types'
import {
  buildPlanarGraph, clipFacesToLand, degree4Vertices, facesOf, dropSlivers, pruneDanglers, windowRing,
} from './graph'

const road = (id: string, points: Pt[]): Road => ({ id, class: 'street', points, width: 9, name: null })

const coastalParams: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'coastal', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}

const totalArea = (faces: Pt[][]): number => faces.reduce((s, f) => s + Math.abs(ringArea(f)), 0)

describe('streets/graph', () => {
  it('two crossing roads on a square give four faces', () => {
    const roads = [
      road('r1', [{ x: 500, y: 0 }, { x: 500, y: 1000 }]),
      road('r2', [{ x: 0, y: 500 }, { x: 1000, y: 500 }]),
    ]
    const g = buildPlanarGraph(roads, [windowRing(1000)])
    const faces = facesOf(g)
    expect(faces.length).toBe(4)
    for (const f of faces) {
      expect(Math.abs(ringArea(f) - 250000)).toBeLessThan(10)
      expect(ringArea(f)).toBeGreaterThan(0) // CCW
    }
    expect(totalArea(faces)).toBeCloseTo(1000000, 0)
  })

  it('welds endpoints within snapTol', () => {
    const roads = [
      road('r1', [{ x: 500, y: 0 }, { x: 500, y: 1000 }]),
      // stops 3 m short of r1 (x=500) — still within the default 5 m snapTol
      road('r2', [{ x: 0, y: 500 }, { x: 497, y: 500 }]),
    ]
    const g = buildPlanarGraph(roads, [windowRing(1000)])
    const faces = facesOf(g)
    expect(faces.length).toBe(3)
    const areas = faces.map((f) => Math.abs(ringArea(f))).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(250000, -1)
    expect(areas[1]).toBeCloseTo(250000, -1)
    expect(areas[2]).toBeCloseTo(500000, -1)
  })

  it('faces close against window and land boundary', () => {
    const sizeM = coastalParams.size * 1000
    const terrain = sampleTerrain(coastalParams, sizeM)
    const boundaries: Pt[][] = terrain.land.flatMap((poly) => poly.map((ring) => ring.map(([x, y]) => ({ x, y }))))
    const landArea = boundaries.reduce((s, ring) => s + ringArea(ring), 0)
    const roads = [road('r1', [{ x: 0, y: sizeM / 2 }, { x: sizeM, y: sizeM / 2 }])]
    const g = pruneDanglers(buildPlanarGraph(roads, boundaries))
    const faces = facesOf(g)
    expect(faces.length).toBeGreaterThanOrEqual(2)
    expect(Math.abs(totalArea(faces) - Math.abs(landArea)) / Math.abs(landArea)).toBeLessThan(0.01)
  })

  it('dangling road does not split a face', () => {
    const roads = [road('r1', [{ x: 500, y: 0 }, { x: 500, y: 400 }])]
    const g = pruneDanglers(buildPlanarGraph(roads, [windowRing(1000)]))
    const faces = facesOf(g)
    expect(faces.length).toBe(1)
    expect(Math.abs(ringArea(faces[0]))).toBeCloseTo(1000000, 0)
  })

  it('dropSlivers drops thin faces without touching neighbours', () => {
    const rect = (x0: number, x1: number): Pt[] => [
      { x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 1000 }, { x: x0, y: 1000 },
    ]
    const faces = [rect(-1000, 0), rect(0, 15), rect(15, 1015)]
    const kept = dropSlivers(faces)
    expect(kept.length).toBe(2)
    expect(kept[1]).toEqual(faces[2])
  })

  it('degree4Vertices counts crossroads', () => {
    const roads = [
      road('r1', [{ x: 500, y: 0 }, { x: 500, y: 1000 }]),
      road('r2', [{ x: 0, y: 500 }, { x: 1000, y: 500 }]),
    ]
    const g = buildPlanarGraph(roads, [windowRing(1000)])
    const verts = degree4Vertices(g)
    expect(verts.length).toBe(1)
    expect(verts[0].x).toBeCloseTo(500, 0)
    expect(verts[0].y).toBeCloseTo(500, 0)
  })

  it('is deterministic', () => {
    const sizeM = coastalParams.size * 1000
    const terrain = sampleTerrain(coastalParams, sizeM)
    const boundaries: Pt[][] = terrain.land.flatMap((poly) => poly.map((ring) => ring.map(([x, y]) => ({ x, y }))))
    const roads = [
      road('r1', [{ x: 0, y: sizeM / 2 }, { x: sizeM, y: sizeM / 2 }]),
      road('r2', [{ x: sizeM / 2, y: 0 }, { x: sizeM / 2, y: sizeM }]),
    ]
    const run = () => {
      const g = pruneDanglers(buildPlanarGraph(roads, boundaries))
      return { g, faces: facesOf(g) }
    }
    const a = run()
    const b = run()
    expect(a.g).toEqual(b.g)
    expect(a.faces).toEqual(b.faces)
  })

  it('isolated loop inside a square yields exactly two faces', () => {
    // a closed square road loop, entirely disconnected from the window boundary
    const loop = [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }, { x: 400, y: 600 }]
    const roads = [road('loop', [...loop, loop[0]])]
    const g = buildPlanarGraph(roads, [windowRing(1000)])
    const faces = facesOf(g)
    expect(faces.length).toBe(2)
    // distinct faces (not the same loop returned twice, once reversed): the
    // window's own face (still the full 1,000,000 — the loop is a disjoint
    // component, so subtracting its hole is out of scope) and the loop's
    // small interior, both concentric so centroids alone can't tell them
    // apart — compare areas instead.
    const areas = faces.map((f) => Math.abs(ringArea(f))).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(40000, 0)
    expect(areas[1]).toBeCloseTo(1000000, 0)
  })

  it('disconnected stub does not add a face', () => {
    // a 2-point road touching nothing — fully isolated
    const roads = [road('stub', [{ x: 200, y: 200 }, { x: 250, y: 250 }])]
    const g = buildPlanarGraph(roads, [windowRing(1000)])
    const rawFaces = facesOf(g)
    expect(rawFaces.every((f) => Math.abs(ringArea(f)) > 1)).toBe(true) // no zero-area ring leaked
    const faces = facesOf(pruneDanglers(g))
    expect(faces.length).toBe(1)
  })

  it('clipFacesToLand keeps only the land footprint', () => {
    const sizeM = coastalParams.size * 1000
    const terrain = sampleTerrain(coastalParams, sizeM)
    const g = buildPlanarGraph([], [windowRing(sizeM)])
    const faces = facesOf(g)
    const clipped = clipFacesToLand(faces, terrain)
    expect(clipped.length).toBeGreaterThan(0)
    for (const { poly, footprint } of clipped) {
      expect(Math.abs(ringArea(footprint))).toBeGreaterThan(0)
      for (const ring of [poly, footprint]) expect(ring[0]).not.toEqual(ring[ring.length - 1])
    }
  })
})
