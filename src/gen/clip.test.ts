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
  it('empty rings and NaN input give no result, not a throw', () => {
    expect(union([[]], [rect(0, 0, 1, 1)])).toHaveLength(1)
    expect(union([[[]]] as never, [])).toEqual([])
    expect(intersection([[[NaN, 0], [1, 0], [1, 1]]], [rect(0, 0, 1, 1)])).toEqual([])
  })
  it('a hole touching its outer edge stays a hole of that outer', () => {
    const r = difference([rect(0, 0, 10, 10)], [[[3, 3], [6, 3], [6, 6], [3, 6]]], [[[3, 6], [6, 6], [6, 6.5], [3, 6.5]]])
    expect(r).toHaveLength(1)
    expect(r[0]).toHaveLength(2)
    // pass-through hole sharing an edge with the outer: a notch, no hole
    const n = difference([rect(0, 0, 10, 10)], [[[0, 3], [4, 3], [4, 6], [0, 6]]])
    expect(n).toHaveLength(1)
    expect(n[0]).toHaveLength(1)
    // a hole with a vertex on the outer's boundary: the outer with the other two outers present
    const two = union(difference([rect(0, 0, 30, 30)], [rect(5, 5, 25, 25)]), [rect(10, 10, 20, 20)])
    expect(two).toHaveLength(2)
    expect(two.every((p) => p.length <= 2)).toBe(true)
  })

  it('does not hang on lots sharing a front edge (clipper2-js moved an input vertex in place)', () => {
    // seed 42 default params, size 4: the R9 leftover of a strip piece minus nine of its lots
    const piece: R = [[2131.496, 2631.045], [2168.337, 2629.757], [2185.306, 2672.432], [2190.396, 2681.068], [2206.471, 2691.501], [2239.405, 2691.454], [2279.214, 2681.992], [2293.435, 2700.662], [2318.862, 2757.31], [2294.748, 2771.06], [2248.41, 2785.252], [2210.119, 2790.063], [2147.4, 2786.285], [2150.197, 2732.348], [2135.032, 2692.601], [2008.037, 2683.673], [2012.133, 2622.965]]
    const lots: R[] = [
      [[2029.097, 2624.113], [2027.95, 2641.075], [2010.988, 2639.93], [2012.133, 2622.965]],
      [[2045.919, 2625.252], [2044.771, 2642.213], [2027.95, 2641.075], [2029.097, 2624.113]],
      [[2045.9195321243635, 2625.252100521643], [2059.493238849061, 2626.1709409523924], [2058.34509105384, 2643.1321247742935], [2044.7713843291426, 2642.2132843435443]],
      [[2059.493238849061, 2626.1709409523924], [2074.31850906977, 2627.1745030560874], [2073.1703612745487, 2644.1356868779885], [2058.34509105384, 2643.1321247742935]],
      [[2074.31850906977, 2627.1745030560874], [2091.411064865603, 2628.3315437708006], [2090.2629170703817, 2645.292727592702], [2073.1703612745487, 2644.1356868779885]],
      [[2091.411064865603, 2628.3315437708006], [2105.635559014895, 2629.294437739001], [2104.487411219674, 2646.255621560902], [2090.2629170703817, 2645.292727592702]],
      [[2105.635559014895, 2629.294437739001], [2121.1414537224773, 2630.3440731305145], [2119.993305927256, 2647.3052569524157], [2104.487411219674, 2646.255621560902]],
      [[2131.495, 2631.049], [2136.409, 2630.877], [2137.002, 2647.859], [2131.217, 2648.061], [2119.998, 2647.301], [2121.145, 2630.349]],
      [[2027.95, 2641.075], [2027.004, 2655.094], [2010.042, 2653.95], [2010.988, 2639.93]],
    ]
    const before = JSON.stringify(lots)
    const r = difference([piece], ...lots.map((l) => [l]))
    expect(total(r)).toBeGreaterThan(0)
    expect(JSON.stringify(lots)).toBe(before)
  })
})
