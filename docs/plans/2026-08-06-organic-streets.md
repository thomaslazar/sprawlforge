# Organic Street Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the BSP street fabric with twisted-bisection partitioning at district and block level, driven by a per-district `irregularity` value, exposed as `planned`/`mixed`/`sprawl` tags.

**Architecture:** A new `src/gen/partition/` module implements twisted bisection over arbitrary polygons (validated standalone via a toy harness before wiring). `roads.ts` partitions the land domain into district polygons and each district into block polygons; `bridges.ts` is generalized from 2-point segments to polylines; `buildings.ts` fills polygonal blocks with a rotated BSP lot grid clipped to the block. Blocks/districts become polygons; `GENERATOR_VERSION` → 4.

**Tech Stack:** TypeScript, vitest, polygon-clipping (already installed), Playwright (uicheck), vite.

**Spec:** `docs/specs/2026-08-06-organic-streets-design.md`

## Global Constraints

- Metric only — all lengths in meters, areas in m².
- Determinism: same seed → byte-identical model. All randomness through `mulberry32(hashSeed(seed, stage))`. Never `Math.random()`.
- No new dependencies. Polygon booleans via already-installed `polygon-clipping`.
- Conventional Commits, imperative lowercase subject, no `Co-Authored-By:`/"Generated with" lines.
- Tests: run the task's own test file(s) during the task (`npx vitest run <file>`); the full `npm test` gate runs in Task 8 and again in Task 10.
- **HARD GATE after Task 3:** sector wiring (Tasks 4+) must not start until the toy harness screenshots have been reviewed and approved by the user.
- Never mention the reference generator or its author in code/comments/docs (credit lives in README only).
- `docs/ROADMAP.md` records anything deliberately deferred.

---

### Task 1: Geometry helpers (polylines, rotation, centroid)

**Files:**
- Modify: `src/gen/geometry.ts`
- Modify: `src/gen/sector/pois.ts` (refactor `footprintCentroid` → shared `ringCentroid`)
- Test: `src/gen/geometry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `src/gen/geometry.ts`):
  - `polylineLength(pts: Pt[]): number`
  - `pointAtT(pts: Pt[], t: number): Pt` — arc-length parameterized, t ∈ [0,1]
  - `slicePolyline(pts: Pt[], t0: number, t1: number): Pt[]` — sub-polyline keeping interior vertices
  - `rotatePt(p: Pt, theta: number, c: Pt): Pt` — rotate `p` by `theta` radians around `c`
  - `bboxOf(pts: Pt[]): Rect`
  - `ringCentroid(pts: Pt[]): Pt` — shoelace centroid, vertex-mean fallback for degenerate rings

- [ ] **Step 1: Write the failing tests** — append to `src/gen/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  bboxOf, pointAtT, polylineLength, ringCentroid, rotatePt, slicePolyline,
} from './geometry'

describe('polyline helpers', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]

  it('polylineLength sums segments', () => {
    expect(polylineLength(line)).toBe(200)
  })

  it('pointAtT walks by arc length across vertices', () => {
    expect(pointAtT(line, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAtT(line, 0.25)).toEqual({ x: 50, y: 0 })
    expect(pointAtT(line, 0.75)).toEqual({ x: 100, y: 50 })
    expect(pointAtT(line, 1)).toEqual({ x: 100, y: 100 })
  })

  it('slicePolyline keeps interior vertices', () => {
    expect(slicePolyline(line, 0.25, 0.75)).toEqual([
      { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
    ])
  })

  it('slicePolyline within one segment has just two points', () => {
    expect(slicePolyline(line, 0.1, 0.2)).toEqual([{ x: 20, y: 0 }, { x: 40, y: 0 }])
  })

  it('rotatePt rotates around a center', () => {
    const p = rotatePt({ x: 10, y: 0 }, Math.PI / 2, { x: 0, y: 0 })
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(10)
  })

  it('bboxOf bounds the points', () => {
    expect(bboxOf(line)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('ringCentroid finds the centroid of a square', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    const c = ringCentroid(sq)
    expect(c.x).toBeCloseTo(5)
    expect(c.y).toBeCloseTo(5)
  })

  it('ringCentroid stays inside a concave L-shape', () => {
    const L = [
      { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 },
      { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 },
    ]
    const c = ringCentroid(L)
    // vertex mean would be (13.3, 13.3) — outside the L; shoelace stays inside
    expect(c.x).toBeLessThan(10.01)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/gen/geometry.test.ts`
Expected: FAIL — new exports don't exist.

- [ ] **Step 3: Implement** — append to `src/gen/geometry.ts`:

```ts
export function polylineLength(pts: Pt[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/** point at fraction t (by arc length) along a polyline */
export function pointAtT(pts: Pt[], t: number): Pt {
  const total = polylineLength(pts)
  let target = Math.max(0, Math.min(1, t)) * total
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (target <= seg || i === pts.length - 1) {
      const f = seg === 0 ? 0 : target / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f }
    }
    target -= seg
  }
  return pts[pts.length - 1]
}

/** sub-polyline between arc-length fractions t0 < t1, interior vertices kept */
export function slicePolyline(pts: Pt[], t0: number, t1: number): Pt[] {
  const total = polylineLength(pts)
  const out: Pt[] = [pointAtT(pts, t0)]
  let acc = 0
  for (let i = 1; i < pts.length - 1; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const t = acc / total
    if (t > t0 && t < t1) out.push(pts[i])
  }
  out.push(pointAtT(pts, t1))
  return out
}

export function rotatePt(p: Pt, theta: number, c: Pt): Pt {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

export function bboxOf(pts: Pt[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** shoelace centroid — always inside a simple polygon; vertex mean for degenerate rings */
export function ringCentroid(pts: Pt[]): Pt {
  let area = 0, cx = 0, cy = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const cross = a.x * b.y - b.x * a.y
    area += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  if (Math.abs(area) < 1e-9) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}
```

- [ ] **Step 4: Refactor pois.ts** — delete its private `footprintCentroid` (lines 14–34) and the doc comment above it; `import { ringCentroid } from '../geometry'` and use `at: ringCentroid(building.footprint)` in `placePois`. Keep the existing explanatory comment about why the centroid (not the rect center / vertex mean) is used, moving its text onto `ringCentroid` in geometry.ts.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/gen/geometry.test.ts src/gen/sector/pois.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/gen/geometry.ts src/gen/geometry.test.ts src/gen/sector/pois.ts
git commit -m "feat: add polyline and centroid geometry helpers"
```

---

### Task 2: Twisted-bisection partition module

**Files:**
- Create: `src/gen/partition/twisted.ts`
- Test: `src/gen/partition/twisted.test.ts`

**Interfaces:**
- Consumes: `ringArea`, `pointInRings`, `ringCentroid`, `Pt` from `../geometry`; `Rng` from `../rng`; `polygon-clipping`.
- Produces:
  - `interface PartitionOpts { minCell: number; gap: number; irregularity: number; rng: Rng }`
  - `interface PolyCut { points: Pt[]; width: number }`
  - `partitionPolygon(poly: Pt[], opts: PartitionOpts): { cells: Pt[][]; cuts: PolyCut[] }`
  - `corridorPolygon(line: Pt[], width: number): Pt[]` — polyline inflated to a closed ring (also used by roads.ts later for the river corridor and highway strip)

**Algorithm** (the heart of the feature — implement exactly this shape, constants tunable):

1. If `|ringArea(poly)| < 2 * minCell²` or depth ≥ 26 → emit as cell.
2. Split axis: angle of the farthest vertex pair ("diameter"). At low irregularity snap toward the nearest multiple of 90° so cuts read as a grid; add a wobble of up to ±(π/7)·irregularity.
3. Cut position: fraction `0.5 + (rng−0.5)·2·(0.05 + 0.3·irregularity)` along the axis extent.
4. Chord: intersect the perpendicular iso-line with the polygon edges, pair sorted crossings, take the longest inside chord → endpoints A, B and the boundary edges they lie on.
5. Twist: intersect the two inward boundary normals at A and B; pull the chord midpoint toward that intersection by `0.8·irregularity` (this is what makes cuts meet the boundary near-perpendicular). If the intersection is invalid or lands outside the polygon, keep the straight chord.
6. Split: inflate the (endpoint-extended) cut to a `gap`-wide corridor, `polygonClipping.difference(poly, corridor)` → child rings. Reject degenerate splits (fewer than 2 real pieces, or one piece > 94% of parent) and retry up to 3 times with fresh rng draws; on exhaustion emit the parent as a cell.
7. Recurse into every child ring; record the cut polyline.

- [ ] **Step 1: Write the failing tests** — `src/gen/partition/twisted.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pointInRings, ringArea, type Pt } from '../geometry'
import { mulberry32 } from '../rng'
import { corridorPolygon, partitionPolygon } from './twisted'

const square = (s: number): Pt[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
]

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
    const corridorArea = cuts.reduce((s, c) => s + 9 * 1600, 0)
    expect(cellArea).toBeGreaterThan(1000 * 1000 - corridorArea - 20000)
    expect(cellArea).toBeLessThanOrEqual(1000 * 1000)
  })

  it('near-zero irregularity yields near-axis-aligned cuts', () => {
    const { cuts } = partitionPolygon(square(1000), { ...OPTS, irregularity: 0.02, rng: mulberry32(5) })
    for (const cut of cuts) {
      const a = cut.points[0]
      const b = cut.points[cut.points.length - 1]
      const angle = Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) % (Math.PI / 2)
      const offAxis = Math.min(angle, Math.PI / 2 - angle)
      expect(offAxis).toBeLessThan(0.15) // < ~9° off an axis
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
    expect(ring).toHaveLength(6)
    expect(Math.abs(ringArea(ring))).toBeGreaterThan(1800)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/gen/partition/twisted.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement** — `src/gen/partition/twisted.ts`:

```ts
import polygonClipping from 'polygon-clipping'
import { pointInRings, ringArea, type Pt } from '../geometry'
import type { Rng } from '../rng'

export interface PartitionOpts {
  /** stop recursing when |area| < 2 * minCell², meters */
  minCell: number
  /** cut corridor width (the future road's width), meters */
  gap: number
  /** 0..1 — 0 ≈ regular grid, 1 = fully organic */
  irregularity: number
  rng: Rng
}

export interface PolyCut {
  /** cut centerline, boundary to boundary (2 points straight, 3 when bent) */
  points: Pt[]
  width: number
}

const MAX_DEPTH = 26
const ATTEMPTS = 3
// one piece grabbing more than this share of the parent = sliver cut, retry
const DEGENERATE_SHARE = 0.94

const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])
const fromRing = (ring: [number, number][]): Pt[] => {
  const pts = ring.map(([x, y]) => ({ x, y }))
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (pts.length > 1 && first.x === last.x && first.y === last.y) pts.pop()
  return pts
}

// ponytail: O(n²) farthest-pair; rings stay small enough — swap for rotating
// calipers if domain rings ever make this measurable
function diameterAngle(pts: Pt[]): number {
  let best = -1
  let bx = 1
  let by = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x
      const dy = pts[j].y - pts[i].y
      const d = dx * dx + dy * dy
      if (d > best) { best = d; bx = dx; by = dy }
    }
  }
  return Math.atan2(by, bx)
}

/** grid look at low irregularity: snap the split axis toward the nearest 90° */
function splitAxis(pts: Pt[], irr: number, rng: Rng): number {
  const theta = diameterAngle(pts)
  const snapped = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2)
  const blend = Math.min(1, irr * 2)
  const wobble = (rng.next() - 0.5) * 2 * irr * (Math.PI / 7)
  return snapped + (theta - snapped) * blend + wobble
}

interface Hit { pt: Pt; s: number; edge: number }

/**
 * Longest inside chord of the iso-line { q · u(theta) = c } across the
 * polygon, where c sits at `frac` of the polygon's extent along u.
 * Returns endpoints plus the edge index each lies on (for normals).
 */
function chordThrough(pts: Pt[], theta: number, frac: number): [Hit, Hit] | null {
  const ux = Math.cos(theta)
  const uy = Math.sin(theta)
  let min = Infinity
  let max = -Infinity
  for (const p of pts) {
    const t = p.x * ux + p.y * uy
    if (t < min) min = t
    if (t > max) max = t
  }
  const c = min + (max - min) * frac
  const hits: Hit[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const ta = a.x * ux + a.y * uy - c
    const tb = b.x * ux + b.y * uy - c
    if (ta > 0 === tb > 0) continue
    const t = ta / (ta - tb)
    const pt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    hits.push({ pt, s: pt.x * -uy + pt.y * ux, edge: i })
  }
  if (hits.length < 2) return null
  hits.sort((h1, h2) => h1.s - h2.s)
  let bestLen = 0
  let best: [Hit, Hit] | null = null
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const len = hits[i + 1].s - hits[i].s
    if (len > bestLen) { bestLen = len; best = [hits[i], hits[i + 1]] }
  }
  return best
}

/** unit normal of edge i, flipped to point toward `inwardHint` */
function edgeNormal(pts: Pt[], i: number, at: Pt, inwardHint: Pt): Pt {
  const a = pts[i]
  const b = pts[(i + 1) % pts.length]
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  let nx = -(b.y - a.y) / len
  let ny = (b.x - a.x) / len
  if (nx * (inwardHint.x - at.x) + ny * (inwardHint.y - at.y) < 0) { nx = -nx; ny = -ny }
  return { x: nx, y: ny }
}

/**
 * The twist: pull the chord midpoint toward the intersection of the two
 * inward boundary normals, so the cut meets the boundary near-perpendicular
 * at both ends. Straight chord when the intersection is invalid.
 */
function bendPoint(poly: Pt[], A: Hit, B: Hit, irr: number): Pt | null {
  const mid = { x: (A.pt.x + B.pt.x) / 2, y: (A.pt.y + B.pt.y) / 2 }
  const nA = edgeNormal(poly, A.edge, A.pt, B.pt)
  const nB = edgeNormal(poly, B.edge, B.pt, A.pt)
  const det = nA.x * -nB.y - nA.y * -nB.x
  if (Math.abs(det) < 1e-9) return null
  const rx = B.pt.x - A.pt.x
  const ry = B.pt.y - A.pt.y
  const t = (rx * -nB.y - ry * -nB.x) / det
  const s = (nA.x * ry - nA.y * rx) / det
  const chord = Math.hypot(rx, ry)
  if (t <= 0 || s <= 0 || t >= chord || s >= chord) return null
  const target = { x: A.pt.x + nA.x * t, y: A.pt.y + nA.y * t }
  const k = 0.8 * irr
  const M = { x: mid.x + (target.x - mid.x) * k, y: mid.y + (target.y - mid.y) * k }
  return pointInRings(M, [poly]) ? M : null
}

/** polyline inflated to a closed ring; averaged-normal joins (bends are gentle) */
export function corridorPolygon(line: Pt[], width: number): Pt[] {
  const h = width / 2
  const left: Pt[] = []
  const right: Pt[] = []
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)]
    const next = line[Math.min(line.length - 1, i + 1)]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    left.push({ x: line[i].x - (dy / len) * h, y: line[i].y + (dx / len) * h })
    right.push({ x: line[i].x + (dy / len) * h, y: line[i].y - (dx / len) * h })
  }
  return [...left, ...right.reverse()]
}

/** push both endpoints outward along their segment so the corridor overshoots the boundary */
function extendEnds(line: Pt[], by: number): Pt[] {
  const [a, b] = [line[0], line[1]]
  const la = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const p = line[line.length - 1]
  const q = line[line.length - 2]
  const lp = Math.hypot(p.x - q.x, p.y - q.y) || 1
  return [
    { x: a.x - ((b.x - a.x) / la) * by, y: a.y - ((b.y - a.y) / la) * by },
    ...line.slice(1, -1),
    { x: p.x + ((p.x - q.x) / lp) * by, y: p.y + ((p.y - q.y) / lp) * by },
  ]
}

function planCut(poly: Pt[], opts: PartitionOpts): Pt[] | null {
  const theta = splitAxis(poly, opts.irregularity, opts.rng)
  const frac = 0.5 + (opts.rng.next() - 0.5) * 2 * (0.05 + 0.3 * opts.irregularity)
  const chord = chordThrough(poly, theta, frac)
  if (!chord) return null
  const [A, B] = chord
  if (Math.hypot(B.pt.x - A.pt.x, B.pt.y - A.pt.y) < opts.gap * 2) return null
  const M = opts.irregularity > 0.05 ? bendPoint(poly, A, B, opts.irregularity) : null
  return M ? [A.pt, M, B.pt] : [A.pt, B.pt]
}

export function partitionPolygon(poly: Pt[], opts: PartitionOpts): { cells: Pt[][]; cuts: PolyCut[] } {
  const cells: Pt[][] = []
  const cuts: PolyCut[] = []
  const minArea = 2 * opts.minCell * opts.minCell

  const recurse = (ring: Pt[], depth: number): void => {
    const area = Math.abs(ringArea(ring))
    if (area < minArea || depth >= MAX_DEPTH) {
      cells.push(ring)
      return
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const cut = planCut(ring, opts)
      if (!cut) continue
      const corridor = corridorPolygon(extendEnds(cut, opts.gap * 2), opts.gap)
      const pieces = polygonClipping.difference([toRing(ring)], [toRing(corridor)])
      const rings = pieces
        .map((p) => fromRing(p[0]))
        .filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > area * 0.001)
      if (rings.length < 2) continue
      if (rings.some((r) => Math.abs(ringArea(r)) > area * DEGENERATE_SHARE)) continue
      cuts.push({ points: cut, width: opts.gap })
      for (const r of rings) recurse(r, depth + 1)
      return
    }
    cells.push(ring) // unsplittable after retries — keep whole
  }

  recurse(poly, 0)
  return { cells, cuts }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/gen/partition/twisted.test.ts`
Expected: PASS. If the area-conservation or axis-alignment bounds fail by small margins, tune the test tolerances only after confirming visually (Task 3) that the output is right — do not loosen determinism/containment tests.

- [ ] **Step 5: Commit**

```bash
git add src/gen/partition/
git commit -m "feat: add twisted-bisection polygon partitioner"
```

---

### Task 3: Toy harness (standalone prototype) — ends in HARD GATE

**Files:**
- Create: `tools/partition-toy/index.html`
- Create: `tools/partition-toy/main.ts`
- Create: `tools/partition-toy/shot.mjs`
- Create: `tools/partition-toy/run.sh` (mirror `tools/uicheck/run.sh` but `vite dev`)

**Interfaces:**
- Consumes: `partitionPolygon` from `src/gen/partition/twisted`, `mulberry32` from `src/gen/rng`, `sampleTerrain` from `src/gen/terrain`.
- Produces: a dev-only page at `/tools/partition-toy/` (vite dev serves any html under root; `npm run build` only bundles the root `index.html`, so nothing ships) and `tools/partition-toy/shots/toy.png`.

- [ ] **Step 1: Write the page** — `tools/partition-toy/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>partition toy</title>
    <style>
      body { background: #111; color: #ddd; font-family: system-ui, sans-serif; margin: 16px; }
      .grid { display: grid; grid-template-columns: repeat(4, 320px); gap: 8px; }
      figure { margin: 0; }
      figcaption { font-size: 12px; opacity: 0.7; }
      svg { background: #1a1a2a; width: 320px; height: 320px; }
      label { margin-right: 16px; }
    </style>
  </head>
  <body>
    <div>
      <label>seed <input id="seed" type="number" value="42" /></label>
      <label>minCell <input id="mincell" type="number" value="120" /></label>
    </div>
    <div id="out" class="grid"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the renderer** — `tools/partition-toy/main.ts`:

```ts
import { partitionPolygon } from '../../src/gen/partition/twisted'
import { hashSeed, mulberry32 } from '../../src/gen/rng'
import { sampleTerrain } from '../../src/gen/terrain'
import type { Pt } from '../../src/gen/geometry'

const IRREGULARITY = [0.1, 0.4, 0.7, 0.95]

const square = (): Pt[] => [
  { x: 50, y: 50 }, { x: 950, y: 50 }, { x: 950, y: 950 }, { x: 50, y: 950 },
]
const wide = (): Pt[] => [
  { x: 50, y: 300 }, { x: 950, y: 300 }, { x: 950, y: 700 }, { x: 50, y: 700 },
]
const blob = (): Pt[] =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 2 * Math.PI
    const r = 280 + 170 * Math.abs(Math.sin(i * 2.3))
    return { x: 500 + r * Math.cos(a), y: 500 + r * Math.sin(a) }
  })
// real coastal land ring from the terrain generator, scaled into the 1000-box
function landRing(seed: number): Pt[] {
  const t = sampleTerrain(
    { seed, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
      landform: 'coastal', river: false, lakes: false, islands: false,
      piers: false, irregularity: 0.5, pack: 'generic', theme: 'neon' },
    4000,
  )
  const ring = t.land[0][0].map(([x, y]) => ({ x: x / 4, y: y / 4 }))
  return ring
}

const SHAPES: Array<{ name: string; make: (seed: number) => Pt[] }> = [
  { name: 'square', make: () => square() },
  { name: 'wide', make: () => wide() },
  { name: 'blob', make: () => blob() },
  { name: 'coast', make: landRing },
]

const HUES = [200, 260, 320, 20, 80, 140]

function draw(): void {
  const seed = Number((document.getElementById('seed') as HTMLInputElement).value) >>> 0
  const minCell = Number((document.getElementById('mincell') as HTMLInputElement).value)
  const out = document.getElementById('out')!
  out.innerHTML = ''
  for (const shape of SHAPES) {
    for (const irr of IRREGULARITY) {
      const poly = shape.make(seed)
      const rng = mulberry32(hashSeed(seed, shape.name, irr))
      const { cells, cuts } = partitionPolygon(poly, { minCell, gap: 9, irregularity: irr, rng })
      const cellsSvg = cells
        .map((c, i) =>
          `<polygon points="${c.map((p) => `${p.x},${p.y}`).join(' ')}" fill="hsl(${HUES[i % 6]} 40% 30%)" stroke="#0af" stroke-width="1.5"/>`)
        .join('')
      const cutsSvg = cuts
        .map((c) => `<polyline points="${c.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#fff" stroke-width="3" opacity="0.5"/>`)
        .join('')
      out.insertAdjacentHTML(
        'beforeend',
        `<figure><svg viewBox="0 0 1000 1000">${cellsSvg}${cutsSvg}</svg>
         <figcaption>${shape.name} irr=${irr} cells=${cells.length}</figcaption></figure>`,
      )
    }
  }
}

document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('mincell')!.addEventListener('change', draw)
draw()
```

Note: `irregularity: 0.5` in the params literal requires Task 5's `SectorParams` change — until then, `sampleTerrain`'s params type has no such field. This task runs BEFORE Task 5, so pass the object with `as SectorParams` omitted — build the literal without `irregularity` and add it during Task 5's sweep. Simplest: type the literal `as Parameters<typeof sampleTerrain>[0]` and let Task 5's fixture sweep catch this file too.

- [ ] **Step 3: Screenshot script** — `tools/partition-toy/shot.mjs`:

```js
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = new URL('./shots', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1420, height: 1500 } })
await page.goto(`${BASE}/tools/partition-toy/`)
await page.waitForSelector('svg')
const figures = await page.locator('figure').count()
if (figures !== 16) {
  console.error(`FAIL: expected 16 figures, got ${figures}`)
  process.exitCode = 1
}
await page.screenshot({ path: `${OUT}/toy.png`, fullPage: true })
await browser.close()
console.log(process.exitCode ? 'toy shot FAILED' : `toy shot written to ${OUT}/toy.png`)
```

- [ ] **Step 4: Runner** — `tools/partition-toy/run.sh` (chmod +x):

```bash
#!/bin/bash
# Dev-serve the repo and screenshot the partition toy.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
PORT=${PORT:-5173}
cd "$REPO"
./node_modules/.bin/vite dev --host 127.0.0.1 --port "$PORT" --strictPort >"$SCRIPT_DIR/app.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
curl --retry-connrefused --retry 30 --retry-delay 1 -sf "http://127.0.0.1:$PORT/" >/dev/null \
  || { echo "dev server never came up:"; tail -20 "$SCRIPT_DIR/app.log"; exit 2; }
BASE_URL="http://127.0.0.1:$PORT" node "$SCRIPT_DIR/shot.mjs"
```

Also add `tools/partition-toy/shots/` and `tools/partition-toy/app.log` to `.gitignore` (same pattern as uicheck if uicheck's shots are ignored — check `.gitignore` first and mirror it).

- [ ] **Step 5: Run it**

Run: `tools/partition-toy/run.sh`
Expected: exit 0, `tools/partition-toy/shots/toy.png` written showing a 4×4 grid: near-grid cells at irr=0.1 through crooked organic cells at irr=0.95, on all four shapes, no missing panels, no cells poking outside their shape.

- [ ] **Step 6: LOOK at the screenshot.** The gate criteria, judged by eye:
  - irr=0.1 on square/wide reads as a sane rectangular grid (BSP-equivalent).
  - irr=0.95 reads as organic — bent cuts, varied cell shapes, cuts meeting boundaries near-perpendicular.
  - The coast shape's curved boundary character propagates into nearby cells.
  - No degenerate output: slivers, overlapping cells, cells escaping the parent, panels with a single giant cell.

- [ ] **Step 7: Commit**

```bash
git add tools/partition-toy/ .gitignore
git commit -m "feat: add standalone partition toy harness"
```

- [ ] **Step 8: HARD GATE — STOP.** Report the screenshot to the user for review. Do not start Task 4 until the user approves the toy output. If tuning is requested, adjust constants in `twisted.ts` (wobble, snap blend, bend strength `0.8`, frac range), re-run tests + `run.sh`, re-present.

---

### Task 4: Generalize the road/water pipeline to polylines

**Files:**
- Modify: `src/gen/sector/bridges.ts`
- Test: `src/gen/sector/bridges.test.ts`

**Interfaces:**
- Consumes: `polylineLength`, `pointAtT`, `slicePolyline` from `../geometry` (Task 1).
- Produces: same exported function names and types as today (`clipRoadsToLand`, `truncateOverSpanRoads`, `truncateUnlandableRoads`, `splitHostAtBridges`, `planBridges`, `inWater`) — but correct for roads whose `points` has > 2 vertices. Bridge decks remain straight 2-point segments (a deck is a straight span between its landings).

**Approach:** every function currently starts with `const [a, b] = [road.points[0], road.points[road.points.length - 1]]` and then works in `t ∈ [0,1]` over the straight segment via `at(a, b, t)`. Replace that parameterization with arc length over the whole polyline:
- `at(a, b, t)` → `pointAtT(road.points, t)`
- `len = Math.hypot(...)` → `len = polylineLength(road.points)`
- piece extraction `[at(a,b,cursor), at(a,b,t0)]` → `slicePolyline(road.points, cursor, t0)`
- `waterIntervals(terrain, a, b)` → `waterIntervals(terrain, pts: Pt[])` (sampling step unchanged at 10 m)
- `splitRoad(a, b, ...)` → `splitRoad(pts: Pt[], ...)` returning `Pt[][]` (sub-polylines) instead of `Array<[Pt, Pt]>`
- `landingFor` returns `{ p, q }` via `pointAtT` and ALSO the adjusted t values `{ tp, tq }` so `splitHostAtBridges` can slice at exactly the landing parameters.
- `crossingBridgeable`'s direction check uses `q − p` exactly as today.
- Bridge deck: `points: [p, q]` — straight, unchanged.

A 2-point polyline reproduces today's behavior exactly (`pointAtT` degenerates to linear interpolation), so **existing tests must pass unmodified**.

- [ ] **Step 1: Write the new failing tests** — append to `src/gen/sector/bridges.test.ts` (adapt the terrain fixture style already used in that file — read it first; it will have a helper for fake terrain):

```ts
// polyline roads: an L-shaped street crossing a water strip must be clipped
// on the actual polyline path, keeping the corner vertex in the dry piece
it('clips a polyline street to land keeping interior vertices', () => {
  // terrain fixture: water strip covering x in [400, 600] over all y —
  // reuse/extend this file's existing fake-terrain helper
  const road: Road = {
    id: 'S001', class: 'street', width: 9, name: null,
    points: [{ x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 500 }, { x: 900, y: 500 }],
  }
  const out = clipRoadsToLand([road], stripTerrain(400, 600))
  // piece 1 must contain the corner (300,100)->(300,500) intact
  const first = out[0]
  expect(first.points.some((p) => p.x === 300 && p.y === 100)).toBe(true)
  expect(first.points.some((p) => p.x === 300 && p.y === 500)).toBe(true)
  // no kept point may be inside the strip
  for (const r of out) for (const p of r.points) {
    expect(p.x < 405 || p.x > 595).toBe(true)
  }
})

// a bent arterial crossing bridgeable water still gets a straight deck
it('bridges a polyline arterial with a straight 2-point deck', () => {
  const road: Road = {
    id: 'A01', class: 'arterial', width: 18, name: null,
    points: [{ x: 0, y: 100 }, { x: 350, y: 120 }, { x: 900, y: 100 }],
  }
  const bridges = planBridges([road], stripTerrain(400, 600))
  expect(bridges).toHaveLength(1)
  expect(bridges[0].points).toHaveLength(2)
  expect(bridges[0].bridge).toBe(true)
})
```

(`stripTerrain(x0, x1)` = fake Terrain whose single water polygon is the vertical strip `x0..x1` spanning the window, land = the two side slabs, no riverSlice. If the existing test file already has an equivalent helper, use it; otherwise add this one near the top of the test file.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/gen/sector/bridges.test.ts`
Expected: new tests FAIL (corner vertex lost / wrong sampling path); old tests pass.

- [ ] **Step 3: Rewrite bridges.ts internals** per the Approach block above. Signature sketch of the changed internals:

```ts
function waterIntervals(terrain: Terrain, pts: Pt[]): Array<[number, number]>
function splitRoad(
  pts: Pt[], terrain: Terrain,
  drop: (spanLen: number, t0: number, t1: number) => boolean,
  minPiece: number,
): Pt[][] | null
function landingFor(pts: Pt[], t0: number, t1: number, len: number):
  { p: Pt; q: Pt; tp: number; tq: number }
function crossingBridgeable(pts: Pt[], t0: number, t1: number, len: number, terrain: Terrain): boolean
```

`splitHostAtBridges` keeps a `tCursor` (starts 0) and pushes `slicePolyline(pts, tCursor, tp)` per interval, then `slicePolyline(pts, tCursor, 1)` at the end. `joinArterialsAcrossHighway` is NOT in this file — leave roads.ts alone in this task.

- [ ] **Step 4: Run the full sector test file set**

Run: `npx vitest run src/gen/sector/`
Expected: PASS — including all pre-existing bridge tests unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/bridges.ts src/gen/sector/bridges.test.ts
git commit -m "refactor: generalize road water pipeline to polylines"
```

---

### Task 5: Params + District model + zoning irregularity

**Files:**
- Modify: `src/gen/types.ts` (SectorParams + District)
- Modify: `src/gen/sector/zoning.ts`
- Modify: `src/gen/sector/generate.ts` (minimal adapter, full rewire comes in Task 8)
- Modify: `src/app/tags.ts` (`DEFAULT_PARAMS` only)
- Modify: every test fixture constructing a `SectorParams` or `District` literal (grep-driven)
- Test: `src/gen/sector/zoning.test.ts`

**Interfaces:**
- Consumes: `bboxOf` from `../geometry` (Task 1).
- Produces:
  - `SectorParams` gains `/** 0..1 — street-fabric organicness bias (planned ↔ sprawl) */ irregularity: number`
  - `District` gains `poly: Pt[]` (authoritative shape; `bounds` stays as its bbox) and `irregularity: number` (0.05..0.95)
  - `assignZones(districtPolys: Pt[][], params: SectorParams, terrain: Terrain): District[]` — input changes from `Rect[]` to `Pt[][]`
  - `ZONE_IRREGULARITY: Record<ZoneType, number>` exported from zoning.ts

- [ ] **Step 1: Write the failing tests** — update `src/gen/sector/zoning.test.ts`: convert existing rect fixtures with a local `const rectPoly = (r: Rect): Pt[] => [{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}]` helper, then add:

```ts
it('assigns a deterministic irregularity in [0.05, 0.95] biased by zone', () => {
  const polys = Array.from({ length: 30 }, (_, i) =>
    rectPoly({ x: (i % 6) * 700, y: Math.floor(i / 6) * 700, w: 650, h: 650 }))
  const a = assignZones(polys, params, dryTerrain)
  const b = assignZones(polys, params, dryTerrain)
  expect(a).toEqual(b)
  for (const d of a) {
    expect(d.irregularity).toBeGreaterThanOrEqual(0.05)
    expect(d.irregularity).toBeLessThanOrEqual(0.95)
  }
  // zone bias visible in aggregate: mean slum irregularity > mean corp
  const mean = (zone: string) => {
    const ds = a.filter((d) => d.zone === zone)
    return ds.reduce((s, d) => s + d.irregularity, 0) / (ds.length || 1)
  }
  if (a.some((d) => d.zone === 'slum') && a.some((d) => d.zone === 'corp'))
    expect(mean('slum')).toBeGreaterThan(mean('corp'))
})

it('shifts irregularity with the params bias', () => {
  const polys = [rectPoly({ x: 0, y: 0, w: 800, h: 800 })]
  const low = assignZones(polys, { ...params, irregularity: 0 }, dryTerrain)[0]
  const high = assignZones(polys, { ...params, irregularity: 1 }, dryTerrain)[0]
  expect(high.irregularity).toBeGreaterThan(low.irregularity)
})

it('keeps bounds as the bbox of poly', () => {
  const poly = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 60, y: 120 }]
  const [d] = assignZones([poly], params, dryTerrain)
  expect(d.poly).toEqual(poly)
  expect(d.bounds).toEqual({ x: 10, y: 20, w: 100, h: 100 })
})
```

(`params`/`dryTerrain` are this test file's existing fixtures — extend `params` with `irregularity: 0.5`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/gen/sector/zoning.test.ts`
Expected: FAIL — types/signature.

- [ ] **Step 3: Implement.**

`types.ts`: add to `SectorParams` (after `poiDensity`):
```ts
  /** 0..1 — street-fabric organicness bias (planned ↔ sprawl) */
  irregularity: number
```
add to `District` (after `bounds`):
```ts
  /** district shape; bounds is its bbox */
  poly: Pt[]
  /** 0.05..0.95 — this district's street-fabric organicness */
  irregularity: number
```

`zoning.ts` — replace `assignZones` and `isShore`'s rect sampling:

```ts
/** per-zone irregularity base — overlapping means any zone can land anywhere */
export const ZONE_IRREGULARITY: Record<ZoneType, number> = {
  corp: 0.15, industrial: 0.25, residential: 0.35,
  entertainment: 0.45, docks: 0.55, slum: 0.75,
}

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))

function isShore(poly: Pt[], terrain: Terrain): boolean {
  // sample the polygon's own vertices plus each edge midpoint
  const points: Pt[] = [...poly]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  }
  // ...body identical to today's loop over `points` (in-water OR < SHORE_DIST)
}

export function assignZones(districtPolys: Pt[][], params: SectorParams, terrain: Terrain): District[] {
  const rng = mulberry32(hashSeed(params.seed, 'zones'))
  const withBounds = districtPolys.map((poly) => ({ poly, bounds: bboxOf(poly) }))
  const sorted = withBounds.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
  return sorted.map(({ poly, bounds }, i) => {
    const shore = isShore(poly, terrain)
    const weights = Object.entries(zoneWeights(params, shore)) as Array<[ZoneType, number]>
    const zone = rng.weighted(weights)
    // overlapping zone bases + jitter + global tag bias; floor > 0 — no
    // district is a perfect grid (spec §4.3)
    const irregularity = clamp(
      0.05, 0.95,
      ZONE_IRREGULARITY[zone] + (rng.next() - 0.5) * 0.4 + (params.irregularity - 0.5) * 0.6,
    )
    return {
      id: `D${String(i + 1).padStart(2, '0')}`,
      zone, name: '', bounds, poly, shore, irregularity,
      labelAt: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    }
  })
}
```

`generate.ts` adapter (temporary until Task 8): convert rects at the call site:
```ts
const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]
const districts = assignZones(districtRects.map(rectPoly), params, terrain)
```
The `rectKey` block-alignment lookup keeps working — key it on `d.bounds` exactly as today.

`tags.ts`: `DEFAULT_PARAMS` gains `irregularity: 0.5`.

- [ ] **Step 4: Fixture sweep.** `npx tsc -b --noEmit` (or `npm run build`) and fix every compile error: add `irregularity: 0.5` to each `SectorParams` literal in tests and `tools/partition-toy/main.ts`; add `poly`/`irregularity` to any `District` literal in tests (svg.test.ts constructs districts — set `poly: rectPoly(bounds)`, `irregularity: 0.5`).

- [ ] **Step 5: Run everything touched**

Run: `npx vitest run src/gen src/render src/app`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A src tools/partition-toy/main.ts
git commit -m "feat: add irregularity param and polygonal district model"
```

---

### Task 6: Polygonal block building fill

**Files:**
- Modify: `src/gen/types.ts` (Block, Building)
- Modify: `src/gen/sector/buildings.ts`
- Modify: `src/gen/sector/generate.ts` (`deriveDistricts` + call-site adapter)
- Test: `src/gen/sector/buildings.test.ts`

**Interfaces:**
- Consumes: `rotatePt`, `bboxOf`, `ringCentroid`, `ringArea` (Task 1); `bspSplit` (kept — building lots inside a block stay a rotated rectangular grid; spec amended accordingly).
- Produces:
  - `Block` becomes `{ id: string; districtId: string; poly: Pt[]; footprint: Pt[] }` (`rect` dropped; `footprint` = poly clipped to land, as before)
  - `Building` becomes `{ id: string; blockId: string; districtId: string; footprint: Pt[] }` (`rect` dropped)
  - `fillBuildings(districts: District[], blocksByDistrict: Pt[][][], params: SectorParams, terrain: Terrain): { blocks: Block[]; buildings: Building[] }` — blocks are polygons now
  - `deriveDistricts` computes labelAt from footprint centroids weighted by `|ringArea(footprint)|`

**Approach:** per block polygon: clip to land (largest ring, existing `clipToLand`) → block footprint. Building lots: rotate the block polygon by −θ (θ = angle of its longest edge) around its centroid, take the bbox, inset by SIDEWALK, `bspSplit` into cells, rotate each cell's corners back by +θ, intersect with the block **footprint** (covers both block edge and waterline in one clip), keep rings ≥ MIN_BUILDING_AREA. Buildings thereby inherit the block's local orientation and hug crooked street edges exactly.

- [ ] **Step 1: Write the failing tests** — rewrite `src/gen/sector/buildings.test.ts` fixtures to pass polygon blocks; add:

```ts
it('fills a rotated block with buildings aligned to its longest edge', () => {
  // a 400×200 block rotated 30°
  const theta = Math.PI / 6
  const c = { x: 500, y: 500 }
  const poly = [
    { x: 300, y: 400 }, { x: 700, y: 400 }, { x: 700, y: 600 }, { x: 300, y: 600 },
  ].map((p) => rotatePt(p, theta, c))
  const { blocks, buildings } = fillBuildings([district], [[poly]], params, dryTerrain)
  expect(blocks).toHaveLength(1)
  expect(buildings.length).toBeGreaterThan(2)
  // every building footprint stays inside the block (vertices within 1 m slack)
  for (const b of buildings) for (const p of b.footprint) {
    expect(pointInRings(p, [poly]) ||
      poly.some((q, i) => distToSegment(p, q, poly[(i + 1) % poly.length]) < 1)).toBe(true)
  }
})

it('drops blocks fully drowned by water', () => {
  const poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
  const { blocks } = fillBuildings([district], [[poly]], params, allWaterTerrain)
  expect(blocks).toHaveLength(0)
})
```

(`district`/`params`/`dryTerrain`/`allWaterTerrain` — reuse or build this file's fixtures; `distToSegment` — small local helper or reuse `distToPolyline` from `../terrain/rivers`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/gen/sector/buildings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — `buildings.ts` core change inside the per-block loop (types per Interfaces; `ZONE_BUILD`, `SIDEWALK`, thresholds, `footprintOf`-style land clip all stay):

```ts
const longestEdgeAngle = (poly: Pt[]): number => {
  let best = 0
  let angle = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    if (d > best) { best = d; angle = Math.atan2(b.y - a.y, b.x - a.x) }
  }
  return angle
}
```

per block `poly: Pt[]`:
```ts
const blockFp = clipRingToLand(poly, terrain)          // adapt clipToLand to take Pt[] ring
if (!blockFp || blockFp.area < MIN_BLOCK_AREA) return
blocks.push({ id: blockId, districtId: district.id, poly, footprint: blockFp.pts })

const theta = longestEdgeAngle(poly)
const c = ringCentroid(poly)
const local = poly.map((p) => rotatePt(p, -theta, c))
const lot = insetRect(bboxOf(local), SIDEWALK)
if (!lot) return
const { cells } = bspSplit(lot, { minCell: profile.minCell, gap: 3, jitter: 0.25, rng })
let n = 0
for (const cell of cells) {
  if (!rng.chance(fill)) continue
  const ring = rectCorners(cell).map((p) => rotatePt(p, theta, c))
  const clipped = clipRingToRing(ring, blockFp.pts)    // polygonClipping.intersection, largest ring
  if (!clipped || clipped.area < MIN_BUILDING_AREA) continue
  n += 1
  buildings.push({ id: ..., blockId, districtId: district.id, footprint: clipped.pts })
}
```

The `farFromWater` fast path only skipped the land clip for interior rects; with block-footprint clipping now always needed for buildings, keep a fast path where it still applies: if the block needed no land clip (`blockFp.pts` equals `poly`) and the cell ring is fully inside `poly` (`pointInRings` all 4 corners... insufficient for concave) — simplest correct version: always clip buildings against `blockFp.pts`; keep the water fast path only at block level. If generation feels slow later, uicheck/roadmap it.

`generate.ts`: `deriveDistricts` block weighting switches to footprints:
```ts
const area = Math.abs(ringArea(b.footprint))
const c = ringCentroid(b.footprint)
sx += c.x * area; sy += c.y * area; sArea += area
```
and the call site converts rect blocks for now: `alignedBlocks.map((rs) => rs.map(rectPoly))` (reuse Task 5's `rectPoly`).

- [ ] **Step 4: Compile sweep** — `npm run build`; fix fallout (svg.test constructing Block/Building literals: replace `rect` with `poly`; svg.ts itself doesn't read block/building rect — footprints only — so no renderer change here).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/gen src/render`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat: fill polygonal blocks with orientation-inheriting buildings"
```

---

### Task 7: Sector partitioning — districts and streets from twisted bisection

**Files:**
- Modify: `src/gen/sector/roads.ts`
- Test: `src/gen/sector/roads.test.ts`

**Interfaces:**
- Consumes: `partitionPolygon`, `corridorPolygon` (Task 2); polyline pipeline (Task 4); `District.irregularity` (Task 5).
- Produces (new exports; old `layoutRoads` stays untouched until Task 8 deletes it):
  - `districtDomains(terrain: Terrain): Pt[][]` — partition domain rings
  - `partitionDistricts(params: SectorParams, terrain: Terrain): { roads: Road[]; districtPolys: Pt[][] }` — highways + arterials (polylines) + district polygons
  - `layoutStreets(districts: District[], params: SectorParams): { streets: Road[]; blocksByDistrict: Pt[][][] }` — indexed 1:1 with the (sorted) `districts` array
  - `finalizeRoads(roads: Road[], terrain: Terrain): Road[]` — overpass join + clip/truncate/bridge chain (extracted from today's layoutRoads tail)

**Domain rule (spec §4.1):** outer rings of `union(land, riverCorridor)` — lakes fill in (roads cross them and the Task-4 pipeline clips/bridges), sea stays out, river banks reconnect so arterial cuts cross the river and become bridge candidates. Rings under `MIN_DISTRICT_AREA = 250_000` m² (tiny islets) get no districts (ROADMAP already defers islet settlement).

- [ ] **Step 1: Write the failing tests** — append to `src/gen/sector/roads.test.ts`:

```ts
describe('districtDomains', () => {
  it('returns land outer rings, filling lake holes', () => {
    // fake terrain: 4000² land with a lake hole ring
    const domains = districtDomains(lakeTerrain)
    expect(domains).toHaveLength(1)
    expect(domains[0].length).toBeGreaterThanOrEqual(4)
  })

  it('reconnects river banks into one domain', () => {
    // fake terrain: land split by a vertical river strip, riverSlice present
    const domains = districtDomains(riverTerrain)
    expect(domains).toHaveLength(1)
  })

  it('drops islet rings below the minimum district area', () => {
    const domains = districtDomains(isletTerrain) // mainland + 300 m² islet
    expect(domains).toHaveLength(1)
  })
})

describe('partitionDistricts', () => {
  it('is deterministic and covers the domain with districts', () => {
    const a = partitionDistricts(params, dryTerrain)
    const b = partitionDistricts(params, dryTerrain)
    expect(a).toEqual(b)
    expect(a.districtPolys.length).toBeGreaterThan(3)
    expect(a.roads.some((r) => r.class === 'arterial')).toBe(true)
  })

  it('adds a highway for size >= 3', () => {
    const { roads } = partitionDistricts({ ...params, size: 4 }, dryTerrain)
    expect(roads.some((r) => r.class === 'highway')).toBe(true)
  })
})

describe('layoutStreets', () => {
  it('partitions each district by its own irregularity, 1:1 indexed', () => {
    const { districtPolys } = partitionDistricts(params, dryTerrain)
    const districts = assignZones(districtPolys, params, dryTerrain)
    const { streets, blocksByDistrict } = layoutStreets(districts, params)
    expect(blocksByDistrict).toHaveLength(districts.length)
    expect(streets.length).toBeGreaterThan(0)
    // every block's first vertex lies inside (or on) its district poly bbox
    districts.forEach((d, i) => {
      for (const block of blocksByDistrict[i]) {
        const bb = bboxOf(block)
        expect(bb.x).toBeGreaterThanOrEqual(d.bounds.x - 1)
        expect(bb.x + bb.w).toBeLessThanOrEqual(d.bounds.x + d.bounds.w + 1)
      }
    })
  })
})
```

(`dryTerrain` = all-land fake over 4000²; `lakeTerrain`/`riverTerrain`/`isletTerrain` = small hand-built Terrain literals in the test file. `params` includes `irregularity: 0.5`, `size: 4`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/gen/sector/roads.test.ts`
Expected: new describes FAIL.

- [ ] **Step 3: Implement** in `roads.ts`:

```ts
const MIN_DISTRICT_AREA = 250_000 // m² — islets below this get no district

export function districtDomains(terrain: Terrain): Pt[][] {
  // outer rings only: lakes fill in (roads cross them; pipeline clips/bridges),
  // sea stays out; the river corridor reconnects the banks so arterial cuts
  // cross it and become bridge candidates
  const land: MultiPolygon = terrain.land.map((poly) => [poly[0]])
  if (land.length === 0) return []
  const river = terrain.riverSlice
  const domain = river
    ? polygonClipping.union(land, [[toRing(corridorPolygon(river.course, river.width * 2))]])
    : polygonClipping.union(land)
  return domain
    .map((p) => fromRing(p[0]))
    .filter((r) => Math.abs(ringArea(r)) >= MIN_DISTRICT_AREA)
    .sort((a, b) => bboxOf(a).y - bboxOf(b).y || bboxOf(a).x - bboxOf(b).x)
}
```

(`toRing`/`fromRing` — same 4-line helpers as the partition module; local copies are fine, or export them from `partition/twisted.ts`.)

```ts
export function partitionDistricts(params: SectorParams, terrain: Terrain):
  { roads: Road[]; districtPolys: Pt[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []
  let domains = districtDomains(terrain)

  // highway: straight vertical corridor, planned infrastructure (spec §4.1)
  if (params.size >= 3 && domains.length > 0) {
    const maxX = Math.max(...domains.flat().map((p) => p.x))
    const hx = maxX * (1 / 3 + rng.next() / 3)
    const next: Pt[][] = []
    let n = 0
    for (const domain of domains) {
      const bb = bboxOf(domain)
      if (hx > bb.x + 200 && hx < bb.x + bb.w - 200) {
        n += 1
        roads.push({
          id: `H${n}`, class: 'highway', width: HIGHWAY_W, name: null,
          points: [{ x: hx, y: bb.y }, { x: hx, y: bb.y + bb.h }],
        })
        const corridor = corridorPolygon(
          [{ x: hx, y: bb.y - HIGHWAY_W }, { x: hx, y: bb.y + bb.h + HIGHWAY_W }], HIGHWAY_W)
        const pieces = polygonClipping.difference([toRing(domain)], [toRing(corridor)])
        next.push(...pieces.map((p) => fromRing(p[0])).filter((r) => Math.abs(ringArea(r)) >= MIN_DISTRICT_AREA))
      } else {
        next.push(domain)
      }
    }
    domains = next
  }

  // arterials bend gently — planned infrastructure keeps a low ceiling (spec §4.2)
  const arterialIrr = 0.1 + 0.25 * params.irregularity
  const districtPolys: Pt[][] = []
  let a = 0
  for (const domain of domains) {
    const { cells, cuts } = partitionPolygon(domain, {
      minCell: 500, gap: ARTERIAL_W, irregularity: arterialIrr, rng,
    })
    for (const cut of cuts) {
      a += 1
      roads.push({ id: `A${String(a).padStart(2, '0')}`, class: 'arterial',
        points: cut.points, width: ARTERIAL_W, name: null })
    }
    districtPolys.push(...cells)
  }
  return { roads, districtPolys }
}

export function layoutStreets(districts: District[], params: SectorParams):
  { streets: Road[]; blocksByDistrict: Pt[][][] } {
  const rng = mulberry32(hashSeed(params.seed, 'streets'))
  const streetCell = 160 - params.density * 70
  const streets: Road[] = []
  const blocksByDistrict: Pt[][][] = []
  let s = 0
  for (const district of districts) {
    const { cells, cuts } = partitionPolygon(district.poly, {
      minCell: streetCell, gap: STREET_W, irregularity: district.irregularity, rng,
    })
    for (const cut of cuts) {
      s += 1
      streets.push({ id: `S${String(s).padStart(3, '0')}`, class: 'street',
        points: cut.points, width: STREET_W, name: null })
    }
    blocksByDistrict.push(cells)
  }
  return { streets, blocksByDistrict }
}

export function finalizeRoads(roads: Road[], terrain: Terrain): Road[] {
  const overpassed = joinArterialsAcrossHighway(roads)
  const grounded = clipRoadsToLand(overpassed, terrain)
  const spanTruncated = truncateOverSpanRoads(grounded, terrain)
  const truncated = truncateUnlandableRoads(spanTruncated, terrain)
  const bridges = planBridges(truncated, terrain)
  const hostSplit = splitHostAtBridges(truncated, terrain)
  return [...hostSplit, ...bridges]
}
```

`joinArterialsAcrossHighway`: relax `endInfo` for polylines — drop the horizontality check (cuts are no longer axis-aligned), test the FIRST and LAST point of `r.points` against the highway edge x, and return the matched endpoint plus which end it was. The `OVERPASS_PERP_TOL` facing check stays. Old `layoutRoads` keeps compiling (it calls `finalizeRoads` for its tail — refactor its body to do so).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/gen/sector/roads.test.ts`
Expected: PASS (old layoutRoads tests too — its behavior is unchanged this task).

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/roads.ts src/gen/sector/roads.test.ts
git commit -m "feat: partition districts and streets via twisted bisection"
```

---

### Task 8: Rewire the generator — polygons end to end, GENERATOR_VERSION 4

**Files:**
- Modify: `src/gen/sector/generate.ts`
- Modify: `src/gen/sector/roads.ts` (delete old `layoutRoads`, `landSlabs`, `splitByHighway`, `cutToRoad`)
- Modify: `src/gen/types.ts` (`GENERATOR_VERSION = 4`)
- Modify: `src/render/svg.ts` (district polygon)
- Modify: `src/gen/sector/piers.ts` (perimeter samples from poly)
- Test: `src/gen/sector/generate.test.ts`, `src/render/svg.test.ts`, `src/gen/sector/piers.test.ts`, full suite

**Interfaces:**
- Consumes: everything from Tasks 4–7.
- Produces: `generateSector(params)` on the new pipeline; `SectorModel` shape unchanged apart from the Task 5/6 type changes.

- [ ] **Step 1: Rewire `generateSector`:**

```ts
export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const terrain = sampleTerrain(params, sizeM)
  const { roads: skeleton, districtPolys } = partitionDistricts(params, terrain)
  const districts = assignZones(districtPolys, params, terrain)
  const { streets, blocksByDistrict } = layoutStreets(districts, params)
  const roads = finalizeRoads([...skeleton, ...streets], terrain)

  const nameRng = mulberry32(hashSeed(params.seed, 'names'))
  const namedDistricts = districts.map((d) => ({
    ...d,
    name: generateName(nameRng.pick(pack.districtPatterns), pack.tables, nameRng),
  }))
  const namedRoads = roads.map((r) =>
    r.class === 'street'
      ? r
      : { ...r, name: generateName(nameRng.pick(pack.streetPatterns), pack.tables, nameRng) },
  )

  const { blocks, buildings } = fillBuildings(namedDistricts, blocksByDistrict, params, terrain)
  const finalDistricts = deriveDistricts(namedDistricts, blocks)
  const pois = placePois(finalDistricts, buildings, pack, params)
  const piers = placePiers(finalDistricts, terrain, params)

  return { meta: { ... GENERATOR_VERSION 4 ... }, terrain, roads: namedRoads, districts: finalDistricts, blocks, buildings, pois, piers }
}
```

The `rectKey` alignment map and `rectPoly` adapters die — `blocksByDistrict` is index-aligned with `districts` by construction (`assignZones` sorts polys, `layoutStreets` consumes the sorted array).

Delete `layoutRoads`, `landSlabs`, `splitByHighway`, `cutToRoad` from roads.ts (now unreferenced; `finalizeRoads` and `joinArterialsAcrossHighway` stay). Delete their now-dead tests.

- [ ] **Step 2: svg.ts district polygons** — replace the district rect loop (`const r = d.bounds` block):

```ts
for (const d of model.districts) {
  const pts = d.poly.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
  out.push(`<polygon data-id="${d.id}" points="${pts}" fill="${theme.districtFill[d.zone]}"/>`)
}
```
(keep the surrounding `land-clip` group and its comment, updating the comment: district polys include filled lakes and the river corridor, so the land clip still earns its keep.)

- [ ] **Step 3: piers.ts perimeter samples** — replace `edgeSamples(district.bounds, EDGE_STEP)` with samples along `district.poly`:

```ts
/** every ~30 m sample along a polygon's perimeter */
function perimeterSamples(poly: Pt[], step: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.floor(len / step))
    for (let k = 0; k < steps; k++)
      pts.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps })
  }
  return pts
}
```

- [ ] **Step 4: `GENERATOR_VERSION = 4`** in types.ts.

- [ ] **Step 5: Full test run and fixture repair**

Run: `npm test` (and `npm run test:all` if it exists as the fuller gate)
Expected: failures ONLY in tests pinning old-model specifics (counts, snapshot-ish assertions, district-rect assumptions). Repair each by updating the expectation to the new deterministic output — but investigate any failure that smells like a real bug (empty maps, zero roads, drowned everything) before touching the expectation. Smoke tests (`terrain/smoke.test.ts`) must stay green untouched.

Sanity thresholds that must hold for `seed 42, size 4, coastal, density 0.5`: ≥ 4 districts, ≥ 40 blocks, ≥ 150 buildings, ≥ 1 arterial, generation < 2 s. If generation is dramatically slow, the likely culprit is per-building `polygonClipping.intersection` — flag it in the task report rather than optimizing blind.

- [ ] **Step 6: Visual spot-check** — run `tools/uicheck/run.sh`. Some existing uicheck assertions may fail (bridge presence on specific seeds is geometry-dependent now). Fix pinned seeds in the TERRAIN_SWEEP if a documented assumption broke (the file already documents seed 12 for bay,river); LOOK at all screenshots in `tools/uicheck/shots/` — organic fabric visible, no roads over open water, bridges intact, buildings hugging crooked streets.

- [ ] **Step 7: Commit**

```bash
git add -A src tools/uicheck
git commit -m "feat!: generate sector fabric with twisted bisection end to end"
```

(`feat!` — every existing seed re-renders differently: GENERATOR_VERSION 4.)

---

### Task 9: Street-style tags (planned / mixed / sprawl)

**Files:**
- Modify: `src/app/tags.ts`
- Modify: `src/app/strings.ts`
- Test: `src/app/tags.test.ts`

**Interfaces:**
- Consumes: `SectorParams.irregularity` (Task 5).
- Produces: tag group `streets: ['planned', 'mixed', 'sprawl']` with effects `irregularity: 0.15 / 0.5 / 0.85`. KnobPanel renders new groups automatically from `TAG_GROUPS` — no component change.

Spec note: the spec called for two tags with "neither = mixed default", but `materializeTags` intentionally rolls an explicit tag for every unstaged group (bare URL = fully materialized surprise-me). An explicit `mixed` member keeps that invariant — this is the amended design (spec §6 updated in the planning commit).

- [ ] **Step 1: Write the failing tests** — append to `src/app/tags.test.ts` (follow the existing test style in that file):

```ts
it('streets tags set irregularity', () => {
  expect(resolveTags(['planned']).irregularity).toBe(0.15)
  expect(resolveTags(['mixed']).irregularity).toBe(0.5)
  expect(resolveTags(['sprawl']).irregularity).toBe(0.85)
  expect(resolveTags([]).irregularity).toBe(0.5)
})

it('streets tags are mutually exclusive, last wins', () => {
  expect(normalizeTags(['planned', 'sprawl'])).toEqual(['sprawl'])
})

it('materializeTags rolls a streets tag when none staged', () => {
  const out = materializeTags(42, ['coastal'])
  expect(out.filter((t) => ['planned', 'mixed', 'sprawl'].includes(t))).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/tags.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — `tags.ts`:
  - `TAG_GROUPS` gains `streets: ['planned', 'mixed', 'sprawl']` (after `activity`).
  - `TAG_EFFECTS` gains `planned: { irregularity: 0.15 }, mixed: { irregularity: 0.5 }, sprawl: { irregularity: 0.85 }`.
  - `strings.ts`: `tagGroups.streets: 'Streets'`; `tags.planned: 'Planned'`, `tags.mixed: 'Mixed'`, `tags.sprawl: 'Sprawl'`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/tags.ts src/app/strings.ts src/app/tags.test.ts
git commit -m "feat: add planned/mixed/sprawl street-style tags"
```

---

### Task 10: uicheck extension, ROADMAP, final gate

**Files:**
- Modify: `tools/uicheck/check.mjs`
- Modify: `docs/ROADMAP.md`
- Test: `tools/uicheck/run.sh` + full `npm test`

- [ ] **Step 1: Extend check.mjs** — after the terrain sweep, add:

```js
// street-style tags: planned vs sprawl must both render dense fabric and differ
await page.goto(`${BASE}/?seed=42&tags=coastal,planned`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-planned.png` })
const svgPlanned = await page.locator('svg').innerHTML()
if ((await page.locator('svg polygon[data-id^="BLD"]').count()) < 50)
  fail('planned: too few buildings')
if (!(await page.getByRole('button', { name: 'Planned', pressed: true }).isVisible()))
  fail('planned chip not pressed from URL tags')

await page.goto(`${BASE}/?seed=42&tags=coastal,sprawl`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-sprawl.png` })
if ((await page.locator('svg polygon[data-id^="BLD"]').count()) < 50)
  fail('sprawl: too few buildings')
if ((await page.locator('svg').innerHTML()) === svgPlanned)
  fail('planned and sprawl render identically')

// water-heavy organic fabric: crooked streets + bridges coexist
await page.goto(`${BASE}/?seed=42&tags=coastal,river,sprawl`)
await page.waitForSelector('svg')
await page.screenshot({ path: `${OUT}/streets-sprawl-river.png` })
```

(The bare-URL materialization block later in the file already proves group materialization generically; the streets group inherits that coverage.)

- [ ] **Step 2: Run** `tools/uicheck/run.sh`. Exit 0 AND review every screenshot in `tools/uicheck/shots/` by eye — planned reads gridded-with-variety, sprawl reads tangled, waterfronts hug the shore, bridges present on river seeds, no black holes or escaped geometry.

- [ ] **Step 3: ROADMAP** — in `docs/ROADMAP.md`: mark build-order item 2 phase 3 ✅; replace the phase-3 options block with a pointer to the spec; add to Deferred: “Curved highways — the highway strip stays straight; a gently bent highway corridor is a cheap follow-up on the corridor mechanism”, and “Street-fabric performance — per-building polygon clipping; profile before optimizing”.

- [ ] **Step 4: Full gate**

Run: `npm test && npm run build && tools/uicheck/run.sh`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tools/uicheck/check.mjs docs/ROADMAP.md
git commit -m "test: cover street-style tags in uicheck and update roadmap"
```

---

## Execution notes

- Task order is strict: 1 → 2 → 3 → **GATE** → 4 → 5 → 6 → 7 → 8 → 9 → 10.
- Task 8 is the flag-day task — everything compiles per-task before it, but the map only *looks* different from Task 8 on.
- Constants explicitly designated tunable (wobble ±π/7, snap blend `irr*2`, bend strength 0.8, frac spread 0.05+0.3·irr, `ZONE_IRREGULARITY`, arterial ceiling 0.1+0.25·irr): tune on toy + uicheck screenshots, never by loosening determinism/containment tests.
- After Task 10, do NOT open a PR automatically — report to the user (repo rule: user decides on PRs).
