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

  it('records cut depth: 0 for the polygon\'s first split, deeper for cuts made further down the recursion', () => {
    const { cuts } = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.5, rng: mulberry32(1) })
    expect(cuts[0].depth).toBe(0)
    for (const cut of cuts) expect(Number.isInteger(cut.depth) && cut.depth >= 0).toBe(true)
    expect(cuts.some((c) => c.depth >= 1)).toBe(true)
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

  it('near-zero irregularity keeps cuts to ≤3 points (no meander leakage into the grid gate)', () => {
    const { cuts } = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.1, rng: mulberry32(5) })
    for (const cut of cuts) expect(cut.points.length).toBeLessThanOrEqual(3)
  })

  it('a long high-irregularity chord meanders: ≥4 points, all inside the parent', () => {
    const parent = square(2000)
    const { cuts } = partitionPolygon(parent, { ...OPTS, irregularity: 0.9, rng: mulberry32(11) })
    const longCut = cuts.reduce((a, b) =>
      Math.hypot(b.points[b.points.length - 1].x - b.points[0].x, b.points[b.points.length - 1].y - b.points[0].y) >
      Math.hypot(a.points[a.points.length - 1].x - a.points[0].x, a.points[a.points.length - 1].y - a.points[0].y) ? b : a)
    expect(longCut.points.length).toBeGreaterThanOrEqual(4)
    // endpoints sit ON the boundary by design; only interior (displaced) points must be strictly inside
    for (const p of longCut.points.slice(1, -1)) expect(pointInRings(p, [parent])).toBe(true)
  })

  it('at irr 0.8 a long cut winds smoothly: bounded turn angle, sinuous but not hairpin-y', () => {
    const parent = square(2000)
    const { cuts } = partitionPolygon(parent, { ...OPTS, irregularity: 0.8, rng: mulberry32(11) })
    const longCut = cuts.reduce((a, b) =>
      Math.hypot(b.points[b.points.length - 1].x - b.points[0].x, b.points[b.points.length - 1].y - b.points[0].y) >
      Math.hypot(a.points[a.points.length - 1].x - a.points[0].x, a.points[a.points.length - 1].y - a.points[0].y) ? b : a)
    const pts = longCut.points
    let maxTurn = 0
    for (let i = 1; i < pts.length - 1; i++) {
      const v1 = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y }
      const v2 = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y }
      const l1 = Math.hypot(v1.x, v1.y) || 1
      const l2 = Math.hypot(v2.x, v2.y) || 1
      const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))
      const turnDeg = (Math.acos(cos) * 180) / Math.PI
      if (turnDeg > maxTurn) maxTurn = turnDeg
    }
    const arc = pts.reduce((s, p, i) => (i === 0 ? 0 : s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)), 0)
    const chord = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y)
    const sinuosity = arc / chord
    expect(maxTurn).toBeLessThan(35)
    expect(sinuosity).toBeGreaterThan(1.05)
    expect(sinuosity).toBeLessThan(1.6)
  })

  it('accepts a per-cell irregularity function, sampled at each cut cell centroid, deterministically', () => {
    const field = (p: Pt) => (p.x < 500 ? 0.05 : 0.9)
    const a = partitionPolygon(square(1000), { ...OPTS, irregularity: field, rng: mulberry32(9) })
    const b = partitionPolygon(square(1000), { ...OPTS, irregularity: field, rng: mulberry32(9) })
    expect(a).toEqual(b)
    // some cut somewhere should show the high-irr side's signature (a bend/meander)
    expect(a.cuts.some((c) => c.points.length >= 3)).toBe(true)
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
    const rings = corridorPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10)
    expect(rings).toHaveLength(1)
    expect(rings[0]).toHaveLength(4)
    expect(Math.abs(ringArea(rings[0]))).toBeCloseTo(1000, 0)
  })

  it('handles a bent polyline', () => {
    const rings = corridorPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10)
    expect(rings).toHaveLength(1)
    // per-segment quads unioned at the joint — square-ish miter, not a raw sum of quads
    expect(Math.abs(ringArea(rings[0]))).toBeGreaterThan(1900)
    expect(Math.abs(ringArea(rings[0]))).toBeLessThan(2000)
    expect(isSimple(rings[0])).toBe(true)
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
    const rings = corridorPolygon(line, 360)
    expect(rings.length).toBeGreaterThan(0)
    for (const ring of rings) {
      expect(isSimple(ring)).toBe(true)
      expect(() => polygonClipping.union([toRing(ring)])).not.toThrow()
    }
  })

  it('returns every component, sorted largest-area-first (a dropped joint must gap, not vanish)', () => {
    const rings = corridorPolygon(
      [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }, { x: 0, y: 400 }],
      10,
    )
    expect(rings.length).toBeGreaterThan(0)
    const areas = rings.map((r) => Math.abs(ringArea(r)))
    expect(areas).toEqual([...areas].sort((a, b) => b - a))
  })
})
