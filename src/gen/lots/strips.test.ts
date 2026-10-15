import { describe, expect, it } from 'vitest'
import { boxOf, ringArea } from '../geometry'
import { mulberry32 } from '../rng'
import { fitBox, holds } from './fitbox'
import { arcSide, frontage, lShape, pairOverlapMax, rectPoly } from './fixtures'
import { sidesOf } from './setback'
import { stripLots, type StripParams } from './strips'

const P: StripParams = { depth: 16, width: [10, 18], gap: null }
const run = (piece: ReturnType<typeof rectPoly>, seed: number, p = P) => stripLots(piece, sidesOf(piece), p, mulberry32(seed))

describe('stripLots', () => {
  it('strips on a rectangle', () => {
    const lots = run(rectPoly(0, 0, 100, 60), 1)
    const corners = lots.filter((l) => l.corner !== undefined)
    expect(corners).toHaveLength(4)
    for (const c of corners) {
      const b = boxOf(c.poly)
      expect(c.corner).toBeCloseTo(90, 6)
      expect(b.x1 - b.x0).toBeCloseTo(16, 2); expect(b.y1 - b.y0).toBeCloseTo(16, 2); expect(ringArea(c.poly)).toBeCloseTo(256, 2)
    }
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(lots.filter((l) => l.filler).reduce((a, l) => a + ringArea(l.poly), 0) - 68 * 28)).toBeLessThan(1)
    for (const l of lots.filter((l) => !l.filler && l.corner === undefined)) expect(frontage(l)).toBeGreaterThanOrEqual(10)
  })
  it('reflex corner strips do not overlap', () => {
    const L = lShape(120, 120, 60)
    expect(pairOverlapMax(run(L, 2).map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  })
  it('lots along a curved side', () => {
    const piece = [...arcSide({ x: 0, y: 0 }, 200, 60, 12), { x: 0, y: 150 }]
    const lots = run(piece, 3).filter((l) => !l.filler)
    expect(lots.length).toBeGreaterThan(3)
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
    for (const l of lots) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
  })
  it('a lot too narrow for 6 x 8 merges into its neighbour', () => {
    const lots = run(rectPoly(0, 0, 37.5, 60), 4, { ...P, width: [5.5, 5.5] })
    expect(lots.some((l) => !l.filler && l.corner === undefined)).toBe(true)
    for (const l of lots.filter((l) => !l.filler)) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
  })
  it('acute corner lot', () => {
    const tri = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 * Math.tan((40 * Math.PI) / 180) }]
    expect(run(tri, 5).some((l) => Math.abs((l.corner ?? 0) - 40) < 0.5)).toBe(true)
  })
  it('a block narrower than the strip depth', () => {
    expect(run(rectPoly(0, 0, 100, 12), 6).filter((l) => !l.filler).length).toBeLessThanOrEqual(1)
  })
  it('gaps become filler lots', () => {
    const lots = run(rectPoly(0, 0, 100, 60), 7, { ...P, gap: [3, 5] })
    expect(lots.filter((l) => l.filler).length).toBeGreaterThan(1)
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  })
})
