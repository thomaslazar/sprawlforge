import { describe, expect, it } from 'vitest'
import { difference, intersection, union, type MultiPolygon } from './clip'

type R = [number, number][]
const rect = (x0: number, y0: number, x1: number, y1: number): R => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const area = (r: R) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + (p[0] * q[1] - q[0] * p[1]) / 2 }, 0)
const total = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((t, r, i) => t + (i === 0 ? 1 : -1) * Math.abs(area(r)), 0), 0)

describe('clip adapter', () => {
  it('rect ∩ rect', () => {
    const r = intersection([rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)])
    expect(r).toHaveLength(1)
    expect(total(r)).toBeCloseTo(25)
  })
  it('rect − rect leaves an L', () => {
    const r = difference([rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)])
    expect(r).toHaveLength(1)
    expect(r[0]).toHaveLength(1)
    expect(total(r)).toBeCloseTo(75)
    expect(r[0][0].length).toBe(7) // 6 corners, closed
  })
  it('difference producing a hole', () => {
    const r = difference([rect(0, 0, 10, 10)], [rect(3, 3, 6, 6)])
    expect(r).toHaveLength(1)
    expect(r[0]).toHaveLength(2)
    expect(total(r)).toBeCloseTo(91)
    expect(area(r[0][1])).toBeLessThan(0)
  })
  it('union of overlapping rects, n-ary', () => {
    const r = union([rect(0, 0, 10, 10)], [rect(5, 0, 15, 10)], [rect(100, 0, 110, 10)])
    expect(r).toHaveLength(2)
    expect(total(r)).toBeCloseTo(250)
  })
  it('accepts a bare polygon or a multipolygon', () => {
    expect(total(intersection([rect(0, 0, 10, 10)], [[rect(5, 5, 15, 15)]]))).toBeCloseTo(25)
  })
  it('rings are closed, outer positive, holes negative', () => {
    const r = difference([rect(0, 0, 10, 10)], [rect(3, 3, 6, 6)])
    for (const ring of r[0]) expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(area(r[0][0])).toBeGreaterThan(0)
    // clockwise input comes back counter-clockwise
    const cw = rect(0, 0, 10, 10).reverse()
    expect(area(union([cw], [cw])[0][0])).toBeGreaterThan(0)
  })
  it('drops collinear and duplicate vertices', () => {
    const noisy: R = [[0, 0], [5, 0], [10, 0], [10, 0], [10, 10], [5, 10], [0, 10]]
    const r = union([noisy], [rect(0, 0, 10, 10)])
    expect(r[0][0]).toHaveLength(5)
  })
  it('empty results', () => {
    expect(intersection([rect(0, 0, 1, 1)], [rect(5, 5, 6, 6)])).toEqual([])
    expect(difference([rect(0, 0, 1, 1)], [rect(-1, -1, 2, 2)])).toEqual([])
    expect(union([], [])).toEqual([])
    expect(intersection([], [rect(0, 0, 1, 1)])).toEqual([])
  })
})
