import polygonClipping from 'polygon-clipping'
import { bboxOf, pointInRings, ringArea, type Pt } from '../geometry'
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

// below this irregularity the axis is pure grid (blend === 0); ramps to
// full diameter-angle by ~irr 0.775
const GRID_BLEND_START = 0.15
const GRID_BLEND_RATE = 1.6

/** signed angular difference a-b, wrapped to (-π/2, π/2] (axis lines have period π) */
function axisDiff(a: number, b: number): number {
  let d = (a - b) % Math.PI
  if (d > Math.PI / 2) d -= Math.PI
  else if (d < -Math.PI / 2) d += Math.PI
  return d
}

/**
 * Grid look at low irregularity: below GRID_BLEND_START the split axis is
 * exactly the cell's bbox axis (cut across the longer side) — true
 * BSP-equivalent, no diagonal leakage. Blends toward the diameter angle as
 * irregularity rises so high-irr cuts stay organic.
 */
function splitAxis(pts: Pt[], irr: number, rng: Rng): number {
  const theta = diameterAngle(pts)
  const box = bboxOf(pts)
  const gridAxis = box.w >= box.h ? 0 : Math.PI / 2
  const blend = Math.max(0, Math.min(1, (irr - GRID_BLEND_START) * GRID_BLEND_RATE))
  const wobble = (rng.next() - 0.5) * 2 * irr * irr * (Math.PI / 7)
  return gridAxis + axisDiff(theta, gridAxis) * blend + wobble
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
