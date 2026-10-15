import { describe, expect, it } from 'vitest'
import { ringArea } from '../geometry'
import type { Road, Terrain } from '../types'
import { RoadIndex } from '../streets/trace'
import { difference } from '../clip'
import { boxOf } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import { buildable, edgeSetbacks, pieceSetbacks, roadClearance, sidesOf, type SetbackCtx } from './setback'
import { circleRing, distToRing, dryTerrain, expectBox, rectPoly } from './fixtures'

const road = (id: string, cls: Road['class'], points: Road['points']): Road => ({ id, class: cls, points, width: 9, name: null })
const roads = [
  road('S', 'street', [{ x: -50, y: 0 }, { x: 250, y: 0 }]),
  road('A', 'arterial', [{ x: 200, y: -50 }, { x: 200, y: 250 }]),
]
const index = new RoadIndex(50)
for (const r of roads) index.add(r.id, r.points, r.class)
const bay: Terrain = { ...dryTerrain, water: [[[[0, 120], [400, 120], [400, 400], [0, 400]]]] }
const ctx: SetbackCtx = { index, terrain: bay, sizeM: 200, grounds: [] }

describe('setback per side', () => {
  it('street, arterial, water and window edges', () => {
    const fp = rectPoly(0, 0, 200, 120)
    expect(edgeSetbacks(fp, ctx)).toEqual([7.5, 12, 5, 0])
    const [b] = buildable(fp, [7.5, 12, 5, 0])
    expectBox(b, { x0: 0, y0: 7.5, x1: 188, y1: 115 }, 0.01)
  })
  it('a reflex vertex joins on its bisector', () => {
    const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }]
    const [b] = buildable(L, [7.5, 7.5, 12, 7.5, 7.5, 7.5])
    const onBis = b.filter((p) => Math.abs((p.x - 50) - (p.y - 50)) < 0.01 && p.x > 30 && p.x < 50) // reflex: inward of (50, 50), (38, 38) and (42.5, 42.5)
    expect(onBis).toHaveLength(2)
  })
  it('a 175° vertex makes no spike', () => {
    const fp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 8.75 }, { x: 200, y: 120 }, { x: 0, y: 120 }]
    for (const p of buildable(fp, [7.5, 26, 7.5, 7.5, 7.5])[0]) expect(distToRing(p, fp)).toBeLessThanOrEqual(2 * 26 + 0.01)
  })
  it('clockwise dense shore ring', () => {
    const shore = circleRing({ x: 0, y: 0 }, 150, 200).reverse()
    const out = buildable(shore, shore.map(() => 5))
    expect(out).toHaveLength(1); expect(ringArea(out[0])).toBeGreaterThan(0)
    expect(Math.abs(ringArea(out[0]) - Math.PI * 145 ** 2)).toBeLessThan(0.01 * Math.PI * 145 ** 2)
  })
  it('sides break at 25° and at a class change', () => {
    const s = sidesOf(rectPoly(0, 0, 100, 60), [7.5, 7.5, 12, 7.5])
    expect(s.map((x) => x.setback)).toEqual([7.5, 7.5, 12, 7.5]); expect(sidesOf(circleRing({ x: 0, y: 0 }, 100, 72))).toHaveLength(1)
  })
  const bent = (deg: number, s1: number, s2: number) => {
    const a = (deg * Math.PI) / 180
    const p2 = { x: 100 + 100 * Math.cos(a), y: 100 * Math.sin(a) }
    return sidesOf([{ x: 0, y: 0 }, { x: 100, y: 0 }, p2, { x: p2.x, y: 300 }, { x: 0, y: 300 }], [s1, s2, 7.5, 7.5, 7.5])
  }
  it('sides: a class change splits a near-straight chain', () => {
    const s = bent(10, 7.5, 12)
    expect(s).toHaveLength(5); expect(s.slice(0, 2).map((x) => x.setback)).toEqual([7.5, 12])
  })
  it('sides: 24° bend stays one side, 26° splits', () => {
    expect(bent(24, 7.5, 7.5)).toHaveLength(4)
    expect(bent(26, 7.5, 7.5)).toHaveLength(5)
  })
  it('pieceSetbacks: coincident offset lines resolve by extent', () => {
    // y = 7.5 is the offset line of edge 0 (setback 7.5) and of edge 2 (setback 12)
    const fp = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: -4.5 }, { x: 100, y: -4.5 }, { x: 100, y: 60 }, { x: 0, y: 60 }]
    const piece = [{ x: 10, y: 7.5 }, { x: 40, y: 7.5 }, { x: 90, y: 7.5 }, { x: 90, y: 50 }, { x: 10, y: 50 }]
    expect(pieceSetbacks(piece, fp, [7.5, 7.5, 12, 7.5, 7.5, 7.5]).slice(0, 2)).toEqual([7.5, 12])
  })
  it('pieceSetbacks: an offset line extended past a reflex vertex still matches its edge', () => {
    // reflex vertex (95, 50): the 5 m edge (setback 7.5) meets the 50 m edge (setback 12)
    const fp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 95, y: 50 }, { x: 95, y: 100 }, { x: 0, y: 100 }]
    const sb = [7.5, 5, 7.5, 12, 7.5, 7.5]
    const piece = [{ x: 7.5, y: 7.5 }, { x: 95, y: 7.5 }, { x: 95, y: 42.5 }, { x: 87.5, y: 42.5 }, { x: 83, y: 38 }, { x: 83, y: 92.5 }, { x: 7.5, y: 92.5 }]
    // edge 2 (y = 42.5) runs to x = 87.5, 12.5 m past the 5 m edge's span; edge 3 is the bisector join (previous value)
    expect(pieceSetbacks(piece, fp, sb)).toEqual([7.5, 5, 7.5, 7.5, 12, 7.5, 7.5])
  })

  // an arterial 2.5 m off a front the 2 m simplification straightened: the chord's midpoint misses it, the original edges do not
  const near = (pts: Road['points'], cls: Road['class'] = 'arterial'): SetbackCtx => {
    const ix = new RoadIndex(50); ix.add('R', pts, cls)
    return { index: ix, terrain: dryTerrain, sizeM: 2000, grounds: [] }
  }
  it('a simplified edge takes the largest setback of the original edges it replaced', () => {
    const c = near([{ x: 450, y: 502.5 }, { x: 650, y: 502.5 }])
    const fp = rectPoly(500, 500, 100, 80), original = [{ x: 500, y: 500 }, { x: 550, y: 501.9 }, { x: 600, y: 500 }, { x: 600, y: 580 }, { x: 500, y: 580 }]
    expect(edgeSetbacks(fp, c)[0]).toBe(7.5)
    expect(edgeSetbacks(fp, c, original)).toEqual([12, 7.5, 7.5, 7.5])
  })
  it('roadClearance cuts the buildable back to the setback of a road the midpoints miss', () => {
    // an arterial running past a corner, 1-4 m off the edge: S426 B0101 at the sector window
    const road = [{ x: 497, y: 470 }, { x: 499, y: 530 }, { x: 510, y: 600 }], c = near(road)
    const piece = rectPoly(500, 500, 100, 80)
    const clear = roadClearance(piece, c)
    expect(clear.length).toBeGreaterThan(0)
    const rest = difference([piece.map((p) => [p.x, p.y] as [number, number])], ...clear.map((r) => [r.map((p) => [p.x, p.y] as [number, number])]))
    for (const pg of rest) for (const [x, y] of pg[0]) expect(distToPolyline({ x, y }, road)).toBeGreaterThanOrEqual(12 - 0.01)
    expect(roadClearance(piece, near([{ x: 450, y: 700 }, { x: 650, y: 700 }]))).toEqual([])
    expect(boxOf(rest[0][0].map(([x, y]) => ({ x, y }))).x1).toBeCloseTo(600, 3)
  })
})
