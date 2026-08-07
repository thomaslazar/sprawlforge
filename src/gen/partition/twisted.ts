import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { bboxOf, pointAtT, pointInRings, polylineLength, ringArea, ringCentroid, type Pt } from '../geometry'
import type { Rng } from '../rng'

export interface PartitionOpts {
  /** stop recursing when |area| < 2 * minCell², meters */
  minCell: number
  /** cut corridor width (the future road's width), meters */
  gap: number
  /**
   * 0..1 — 0 ≈ regular grid, 1 = fully organic. A function is sampled at
   * the current cell's centroid for each cut, so different regions of one
   * domain partition differently (see irregularityField).
   */
  irregularity: number | ((p: Pt) => number)
  rng: Rng
}

function resolveIrregularity(irr: PartitionOpts['irregularity'], poly: Pt[]): number {
  return typeof irr === 'function' ? irr(ringCentroid(poly)) : irr
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

export const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])
export const fromRing = (ring: [number, number][]): Pt[] => {
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

// polygon-clipping can throw "Unable to complete output ring" on a union of
// many quads even when every quad is individually simple — a documented
// robustness limit of the library on near-degenerate float configurations
// (coincident/near-parallel edges at a joint), not a self-intersection in
// our input. contour.ts hits the same limit on marching-squares output and
// works around it by nudging coordinates by a tiny fixed epsilon and
// retrying. Folding the union in one quad at a time (rather than one big
// N-ary union) also localizes any failure to a single joint instead of
// risking the whole corridor.
const CORRIDOR_EPSILONS = [1e-6, -1e-6, 3e-6]

function safeUnion(acc: MultiPolygon, next: [number, number][][]): MultiPolygon {
  try {
    return polygonClipping.union(acc, next)
  } catch {
    for (const eps of CORRIDOR_EPSILONS) {
      try {
        return polygonClipping.union(acc, [next[0].map(([x, y]) => [x + eps, y + eps] as [number, number])])
      } catch {
        continue
      }
    }
    // ponytail: give up merging this one quad rather than retry harder —
    // acc keeps every ring found so far (corridorPolygon returns all of
    // them, not just the largest), so the real worst case is a gap at this
    // one joint (the corridor splits into two components here), not a lost
    // component. Upgrade to a finer epsilon ladder or a segment-local
    // fallback offset if a gapped corridor ever shows up in practice.
    return acc
  }
}

/**
 * polyline inflated to a closed ring: each segment becomes its own rectangle
 * quad, unioned together. A single averaged-normal offset (the previous
 * approach) can self-intersect when consecutive segments turn sharply
 * relative to the width — e.g. a river course at 6x width with a tight
 * meander — which then poisons every downstream polygon-clipping call that
 * touches the resulting ring. Per-segment quads are always simple
 * (non-self-intersecting) rectangles regardless of bend angle, and
 * polygon-clipping's union handles merging overlapping quads at the joints
 * robustly, so the result is guaranteed simple.
 *
 * Returns every simple ring the union produced (largest first), not just
 * the largest: a dropped quad (see safeUnion) can split the corridor into
 * more than one component, and callers must feed all of them into their
 * boolean op or silently lose a whole far-side piece (e.g. the river's far
 * bank) instead of just gapping at one joint.
 */
const MIN_FRAGMENT_AREA = 1e-3 // numerical noise floor, not a policy minimum

export function corridorPolygon(line: Pt[], width: number): Pt[][] {
  const h = width / 2
  const quads: [number, number][][][] = []
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * h
    const ny = (dx / len) * h
    quads.push([toRing([
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ])])
  }
  if (quads.length === 0) return []
  let merged: MultiPolygon = [quads[0]]
  for (let i = 1; i < quads.length; i++) merged = safeUnion(merged, quads[i])
  return merged
    .map((poly) => fromRing(poly[0]))
    .filter((ring) => Math.abs(ringArea(ring)) > MIN_FRAGMENT_AREA)
    .sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))
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

// below this, meander is a no-op — keeps the grid gate (irr 0.1 ⇒ ≤3-point,
// near-axis cuts) intact, and sits above the sector's arterial-irregularity
// ceiling (0.1 + 0.25*irr, spec §4.2's "planned infrastructure keeps a low
// ceiling" — arterials stay gently-bent, not organic, until that ceiling is
// revisited) so this phase's cut-shape change doesn't ripple into sector
// road layout; streets (uncapped per-district irregularity) meander freely
const MEANDER_MIN_IRR = 0.4
const MEANDER_SEG_MIN = 150
const MEANDER_SEG_MAX = 250
// amp = irr * segLen * K; tuned so amp stays well under segLen (amp ≈
// segLen would fold the curve back on itself) while still reading as a
// continuous wander once low-passed and Chaikin-smoothed — see the "at irr
// 0.8 a long cut winds smoothly" test for the target sinuosity/turn-angle band
const MEANDER_AMP_K = 1.1
const MEANDER_RETRIES = 2 // + the initial full-amplitude attempt
const CHAIKIN_ROUNDS = 2

/**
 * Chaikin corner-cutting: replace each edge (a,b) with the two points at
 * 1/4 and 3/4 along it. Pure and deterministic (no rng); pins both original
 * endpoints exactly so boundary contact and near-perpendicular entry survive
 * unchanged. A straight polyline stays straight — every inserted point is
 * still collinear with its neighbors, only the point count grows.
 */
function chaikin(pts: Pt[], rounds: number): Pt[] {
  let cur = pts
  for (let r = 0; r < rounds; r++) {
    if (cur.length < 3) break
    const out: Pt[] = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i]
      const b = cur[i + 1]
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

// Chaikin ~4x's the point count per pair of rounds; corridorPolygon turns
// every point into its own quad + union, so the smoothed curve's shape is
// worth far more than most of its points. Drop points whose turn is below
// this threshold before building the corridor — visually identical curve,
// a fraction of the quads.
const DECIMATE_ANGLE_RAD = (0.5 * Math.PI) / 180

/** keeps a point only if it bends the line by more than DECIMATE_ANGLE_RAD from its kept neighbors; endpoints always kept */
function decimateCollinear(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]
    const b = pts[i]
    const c = pts[i + 1]
    const v1x = b.x - a.x, v1y = b.y - a.y
    const v2x = c.x - b.x, v2y = c.y - b.y
    const l1 = Math.hypot(v1x, v1y) || 1
    const l2 = Math.hypot(v2x, v2y) || 1
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)))
    if (Math.acos(cos) > DECIMATE_ANGLE_RAD) out.push(b)
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * Subdivides a cut polyline into ~150-250m segments and displaces interior
 * points perpendicular to the local direction (midpoint-displacement),
 * amplitude ∝ irregularity × segment length. Endpoints are untouched (they
 * already meet the boundary near-perpendicular). Displacement fractions are
 * drawn once so retries (halving amplitude on containment violation) stay
 * deterministic without extra rng draws; falls back to the straight polyline
 * if even the smallest amplitude still escapes the parent. The displaced
 * polyline is then run through Chaikin smoothing so the result reads as a
 * continuously curving road rather than a zigzag of straight kinks.
 */
function meanderLine(poly: Pt[], line: Pt[], irr: number, rng: Rng): Pt[] {
  if (irr <= MEANDER_MIN_IRR) return line
  const total = polylineLength(line)
  const segLen = MEANDER_SEG_MIN + rng.next() * (MEANDER_SEG_MAX - MEANDER_SEG_MIN)
  const segments = Math.round(total / segLen)
  if (segments < 2) return line
  const rawDraws = Array.from({ length: segments - 1 }, () => (rng.next() - 0.5) * 2)
  // low-pass the raw draws so neighboring offsets don't flip sign abruptly —
  // turns high-frequency zigzag into a gentle wander (a real meander is one
  // slow wave, not noise); pure smoothing, no extra rng draws, same length
  const draws = rawDraws.map((d, i) => {
    const prev = i > 0 ? rawDraws[i - 1] : d
    const next = i < rawDraws.length - 1 ? rawDraws[i + 1] : d
    return (prev + 2 * d + next) / 4
  })
  const EPS = 1e-3
  for (let attempt = 0; attempt <= MEANDER_RETRIES; attempt++) {
    const scale = 1 / 2 ** attempt
    const amp = irr * segLen * MEANDER_AMP_K * scale
    const pts: Pt[] = [line[0]]
    let ok = true
    for (let i = 1; i < segments; i++) {
      const t = i / segments
      const base = pointAtT(line, t)
      const p0 = pointAtT(line, Math.max(0, t - EPS))
      const p1 = pointAtT(line, Math.min(1, t + EPS))
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const dlen = Math.hypot(dx, dy) || 1
      const nx = -dy / dlen
      const ny = dx / dlen
      const disp = draws[i - 1] * amp
      const pt = { x: base.x + nx * disp, y: base.y + ny * disp }
      if (!pointInRings(pt, [poly])) ok = false
      pts.push(pt)
    }
    pts.push(line[line.length - 1])
    if (ok) return decimateCollinear(chaikin(pts, CHAIKIN_ROUNDS))
  }
  return decimateCollinear(chaikin(line, CHAIKIN_ROUNDS))
}

function planCut(poly: Pt[], opts: PartitionOpts): Pt[] | null {
  const irr = resolveIrregularity(opts.irregularity, poly)
  const theta = splitAxis(poly, irr, opts.rng)
  const frac = 0.5 + (opts.rng.next() - 0.5) * 2 * (0.05 + 0.3 * irr)
  const chord = chordThrough(poly, theta, frac)
  if (!chord) return null
  const [A, B] = chord
  if (Math.hypot(B.pt.x - A.pt.x, B.pt.y - A.pt.y) < opts.gap * 2) return null
  const M = irr > 0.05 ? bendPoint(poly, A, B, irr) : null
  const base = M ? [A.pt, M, B.pt] : [A.pt, B.pt]
  return meanderLine(poly, base, irr, opts.rng)
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
      const corridorRings = corridorPolygon(extendEnds(cut, opts.gap * 2), opts.gap)
      const pieces = polygonClipping.difference([toRing(ring)], corridorRings.map((r) => [toRing(r)]))
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
