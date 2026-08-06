import { describe, expect, it } from 'vitest'
import { contourWater } from './contour'

const win = { x: 0, y: 0, w: 1000, h: 1000 }
const area = (mp: number[][][][]) =>
  mp.reduce(
    (s, poly) =>
      s +
      poly.reduce((ps, ring, ri) => {
        let a = 0
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i]
          const [x2, y2] = ring[(i + 1) % ring.length]
          a += x1 * y2 - x2 * y1
        }
        return ps + (ri === 0 ? Math.abs(a / 2) : -Math.abs(a / 2))
      }, 0),
    0,
  )

describe('contourWater', () => {
  it('circular lake: water area ≈ circle area', () => {
    // height < 0 inside a radius-250 circle at (500,500)
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    const { water, land } = contourWater(sample, win, 128)
    const circle = Math.PI * 250 * 250
    expect(area(water)).toBeGreaterThan(circle * 0.93)
    expect(area(water)).toBeLessThan(circle * 1.07)
    expect(area(land)).toBeGreaterThan(1000 * 1000 - circle * 1.07)
  })
  it('half-plane coast: water on one side, land+water tile the window', () => {
    const sample = (x: number) => (x - 600) / 1000 // height < 0 (water) where x < 600
    const { water, land } = contourWater(sample, win, 128)
    expect(area(water)).toBeGreaterThan(1000 * 600 * 0.97)
    expect(area(water)).toBeLessThan(1000 * 600 * 1.03)
    expect(area(water) + area(land)).toBeGreaterThan(1000 * 1000 * 0.99)
    expect(area(water) + area(land)).toBeLessThan(1000 * 1000 * 1.01)
  })
  it('island: land polygon appears inside water', () => {
    const sample = (x: number, y: number) => (200 - Math.hypot(x - 500, y - 500)) / 1000
    const { water, land } = contourWater(sample, win, 128)
    expect(area(land)).toBeGreaterThan(Math.PI * 200 * 200 * 0.9)
    expect(area(water)).toBeGreaterThan(1000 * 1000 - Math.PI * 200 * 200 * 1.1 - 1)
  })
  it('dry window: empty water, land = window', () => {
    const { water, land } = contourWater(() => 0.5, win, 32)
    expect(water).toEqual([])
    expect(area(land)).toBeCloseTo(1000 * 1000, -2)
  })
  it('is deterministic', () => {
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    expect(contourWater(sample, win, 64)).toEqual(contourWater(sample, win, 64))
  })
  it('saddle cell: dry center → two disjoint polygons, wet center → one connected polygon', () => {
    // single cell (n=1) over a 2x2 window: TL & BR wet (-1), TR & BL dry (+1) —
    // the classic marching-squares saddle ambiguity.
    const saddleWin = { x: 0, y: 0, w: 2, h: 2 }
    const dryCenter = (x: number, y: number) => ((x < 1) === (y < 1) ? -1 : 1)
    const { water: dryWater, land: dryLand } = contourWater(dryCenter, saddleWin, 1)
    expect(dryWater.length).toBe(2) // two disjoint triangles, one per wet corner
    expect(area(dryWater)).toBeCloseTo(1, 5) // linear approx of the two wet quadrants
    expect(area(dryWater) + area(dryLand)).toBeCloseTo(4, 5)

    // shift so the center height is < 0: same corners, now connected.
    const wetCenter = (x: number, y: number) => dryCenter(x, y) - 0.6
    const { water: wetWater } = contourWater(wetCenter, saddleWin, 1)
    expect(wetWater.length).toBe(1) // single connected hexagon
    expect(area(wetWater)).toBeGreaterThan(area(dryWater)) // markedly larger
  })
  it('corner exactly on the 0-contour does not throw (degenerate crossing, C1)', () => {
    // a plane crossing height 0 exactly at grid corner i=5 (x=500) when n=10
    const sample = (x: number) => x - 500
    expect(() => contourWater(sample, win, 10)).not.toThrow()
  })
  it('water area grows monotonically with the threshold (spec §7)', () => {
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    const a0 = area(contourWater(sample, win, 64).water)
    const a1 = area(contourWater((x, y) => sample(x, y) - 0.05, win, 64).water)
    const a2 = area(contourWater((x, y) => sample(x, y) - 0.1, win, 64).water)
    expect(a1).toBeGreaterThan(a0)
    expect(a2).toBeGreaterThan(a1)
  })
})
