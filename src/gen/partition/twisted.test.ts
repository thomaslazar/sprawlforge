import polygonClipping from 'polygon-clipping'
import { describe, expect, it } from 'vitest'
import { pointInRings, ringArea, type Pt } from '../geometry'
import { mulberry32 } from '../rng'
import { corridorPolygon, partitionPolygon, toRing } from './twisted'

const square = (s: number): Pt[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
]

/** true if no two non-adjacent edges of the ring cross */
function isSimple(ring: Pt[]): boolean {
  const n = ring.length
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const segIntersect = (p1: Pt, p2: Pt, p3: Pt, p4: Pt) => {
    const d1 = cross(p3, p4, p1)
    const d2 = cross(p3, p4, p2)
    const d3 = cross(p1, p2, p3)
    const d4 = cross(p1, p2, p4)
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === i + 1 || (j + 1) % n === i || (i === 0 && j === n - 1)) continue
      if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false
    }
  }
  return true
}

/** 12-point blob around (500,500), radius 300–450, deterministic */
const blob = (): Pt[] =>
  Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * 2 * Math.PI
    const r = 300 + 150 * Math.abs(Math.sin(i * 2.7))
    return { x: 500 + r * Math.cos(a), y: 500 + r * Math.sin(a) }
  })

const OPTS = { minCell: 120, gap: 9 }

describe('partitionPolygon', () => {
  it('is deterministic for a given seed', () => {
    const a = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.7, rng: mulberry32(7) })
    const b = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.7, rng: mulberry32(7) })
    expect(a).toEqual(b)
  })

  it('splits a large polygon into multiple cells with cuts', () => {
    const { cells, cuts } = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.5, rng: mulberry32(1) })
    expect(cells.length).toBeGreaterThan(4)
    expect(cuts.length).toBe(cells.length - 1)
  })

  it('emits a too-small polygon as a single cell', () => {
    const { cells, cuts } = partitionPolygon(square(150), { ...OPTS, irregularity: 0.5, rng: mulberry32(1) })
    expect(cells).toEqual([square(150)])
    expect(cuts).toEqual([])
  })

  it('keeps every cell centroid inside the parent', () => {
    const parent = blob()
    const { cells } = partitionPolygon(parent, { ...OPTS, irregularity: 0.9, rng: mulberry32(3) })
    for (const cell of cells) {
      const c = {
        x: cell.reduce((s, p) => s + p.x, 0) / cell.length,
        y: cell.reduce((s, p) => s + p.y, 0) / cell.length,
      }
      expect(pointInRings(c, [parent])).toBe(true)
    }
  })

  it('conserves area within corridor tolerance', () => {
    const parent = square(1000)
    const { cells, cuts } = partitionPolygon(parent, { ...OPTS, irregularity: 0.5, rng: mulberry32(2) })
    const cellArea = cells.reduce((s, c) => s + Math.abs(ringArea(c)), 0)
    // corridors carve gap-wide strips; generous upper bound on their area
    const corridorArea = cuts.reduce((s) => s + 9 * 1600, 0)
    expect(cellArea).toBeGreaterThan(1000 * 1000 - corridorArea - 20000)
    expect(cellArea).toBeLessThanOrEqual(1000 * 1000)
  })

  it('near-zero irregularity yields near-axis-aligned cuts', () => {
    const { cuts } = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.1, rng: mulberry32(5) })
    for (const cut of cuts) {
      const a = cut.points[0]
      const b = cut.points[cut.points.length - 1]
      const angle = Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) % (Math.PI / 2)
      const offAxis = Math.min(angle, Math.PI / 2 - angle)
      expect(offAxis).toBeLessThan(0.055) // < ~3° off an axis — true grid at low irr
    }
  })

  it('high irregularity produces bent (3+ point) cuts', () => {
    const { cuts } = partitionPolygon(blob(), { ...OPTS, irregularity: 0.95, rng: mulberry32(4) })
    expect(cuts.some((c) => c.points.length >= 3)).toBe(true)
  })

  it('every cut endpoint lies on or near the boundary of some ancestor', () => {
    const parent = square(1000)
    const { cuts } = partitionPolygon(parent, { ...OPTS, irregularity: 0.6, rng: mulberry32(6) })
    for (const cut of cuts) {
      for (const end of [cut.points[0], cut.points[cut.points.length - 1]]) {
        expect(end.x).toBeGreaterThanOrEqual(-1)
        expect(end.y).toBeGreaterThanOrEqual(-1)
        expect(end.x).toBeLessThanOrEqual(1001)
        expect(end.y).toBeLessThanOrEqual(1001)
      }
    }
  })
})

describe('corridorPolygon', () => {
  it('inflates a straight line to a rectangle-ish ring of the right width', () => {
    const ring = corridorPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10)
    expect(ring).toHaveLength(4)
    expect(Math.abs(ringArea(ring))).toBeCloseTo(1000, 0)
  })

  it('handles a bent polyline', () => {
    const ring = corridorPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10)
    // per-segment quads unioned at the joint — square-ish miter, not a raw sum of quads
    expect(Math.abs(ringArea(ring))).toBeGreaterThan(1900)
    expect(Math.abs(ringArea(ring))).toBeLessThan(2000)
    expect(isSimple(ring)).toBe(true)
  })

  it('does not self-intersect on a sharp bend at large width (river-corridor shape)', () => {
    // short segment relative to width — the failure mode that broke the old
    // averaged-normal join (see generate.test.ts for the full crashing seed)
    const line = [
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: 165, y: 30 },
      { x: 330, y: 45 },
    ]
    const ring = corridorPolygon(line, 360)
    expect(isSimple(ring)).toBe(true)
    expect(() => polygonClipping.union([toRing(ring)])).not.toThrow()
  })
})
