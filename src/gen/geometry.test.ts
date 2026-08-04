import { describe, expect, it } from 'vitest'
import { bspSplit, insetRect, pointInRings, ringArea, type Rect } from './geometry'
import { mulberry32 } from './rng'

const within = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1e-9 &&
  inner.y >= outer.y - 1e-9 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-9

describe('insetRect', () => {
  it('shrinks on all sides', () => {
    expect(insetRect({ x: 0, y: 0, w: 100, h: 60 }, 10)).toEqual({ x: 10, y: 10, w: 80, h: 40 })
  })
  it('returns null when too small', () => {
    expect(insetRect({ x: 0, y: 0, w: 15, h: 60 }, 10)).toBeNull()
  })
})

describe('ringArea', () => {
  it('is signed: reversing winding flips the sign, magnitude = area', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(ringArea(square)).toBe(100)
    expect(ringArea(square.slice().reverse())).toBe(-100)
  })
})

describe('pointInRings', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const hole = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }]
  it('is true inside the outer ring and outside the hole', () => {
    expect(pointInRings({ x: 1, y: 1 }, [outer, hole])).toBe(true)
  })
  it('is false inside the hole (even-odd: crossed by both rings)', () => {
    expect(pointInRings({ x: 5, y: 5 }, [outer, hole])).toBe(false)
  })
  it('is false fully outside the outer ring', () => {
    expect(pointInRings({ x: 20, y: 20 }, [outer, hole])).toBe(false)
  })
})

describe('bspSplit', () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 800 }
  const opts = { minCell: 100, gap: 10, jitter: 0.15 }

  it('is deterministic for the same seed', () => {
    const a = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    const b = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(a).toEqual(b)
  })
  it('produces multiple cells all inside the input rect', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(cells.length).toBeGreaterThan(3)
    for (const c of cells) expect(within(c, rect)).toBe(true)
  })
  it('respects minCell: no cell side smaller than minCell * (0.5 - jitter)', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    const floor = opts.minCell * (0.5 - opts.jitter)
    for (const c of cells) {
      expect(c.w).toBeGreaterThanOrEqual(floor)
      expect(c.h).toBeGreaterThanOrEqual(floor)
    }
  })
  it('cells do not overlap', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j]
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap).toBe(false)
      }
  })
  it('records one cut per split (cells - 1)', () => {
    const { cells, cuts } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(cuts.length).toBe(cells.length - 1)
  })
  it('leaves an unsplittable rect whole', () => {
    const { cells, cuts } = bspSplit({ x: 0, y: 0, w: 150, h: 150 }, { ...opts, rng: mulberry32(1) })
    expect(cells).toEqual([{ x: 0, y: 0, w: 150, h: 150 }])
    expect(cuts).toEqual([])
  })
})
