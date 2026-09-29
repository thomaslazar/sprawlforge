import { pointAtT, polylineLength, ringsContainsFn, slicePolyline, type Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, Terrain } from '../types'

const SAMPLE = 10
const LANDING = 15
const MIN_STREET_PIECE = 40
// minimum angle (radians) between a sea bridge and the local shoreline
// tangent — below this the crossing reads as "running along the coast"
// rather than crossing it, so it gets truncated instead of bridged.
const MIN_SHORE_ANGLE = Math.PI / 4 // 45°

// terrain is immutable during a generation; index its water polygons once
const waterIndexCache = new WeakMap<Terrain, Array<(p: Pt) => boolean>>()

export const inWater = (terrain: Terrain, p: Pt): boolean => {
  let fns = waterIndexCache.get(terrain)
  if (!fns) {
    fns = terrain.water.map((poly) => ringsContainsFn(poly))
    waterIndexCache.set(terrain, fns)
  }
  return fns.some((f) => f(p))
}

/**
 * Walk a polyline (arc-length parameterized), returning [t0,t1] water
 * intervals (0..1). Interval bounds always land on a *dry* sample (the last
 * dry step before wet, and the first dry step after) so land pieces built
 * from these bounds never carry a wet endpoint — sampling resolution rounds
 * intervals slightly wide into the water, never short into it.
 */
export function waterIntervals(terrain: Terrain, pts: Pt[]): Array<[number, number]> {
  const len = polylineLength(pts)
  const steps = Math.max(2, Math.ceil(len / SAMPLE))
  const spans: Array<[number, number]> = []
  let start = -1
  let lastDry = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const wet = inWater(terrain, pointAtT(pts, t))
    if (wet) {
      if (start < 0) start = lastDry
    } else {
      if (start >= 0) {
        spans.push([start, t])
        start = -1
      }
      lastDry = t
    }
  }
  if (start >= 0) spans.push([start, 1])
  return spans
}

/**
 * Split a polyline's water spans that pass `drop` into land-only
 * sub-polylines (each kept piece length >= minPiece); spans `drop` rejects
 * are left alone (still embedded in the returned piece's line) — that's how
 * a bridgeable crossing survives while a too-long one gets excised. Returns
 * null if nothing needed dropping, so callers can tell "unchanged" from "one
 * piece, still whole".
 */
function splitRoad(
  pts: Pt[],
  terrain: Terrain,
  drop: (spanLen: number, t0: number, t1: number) => boolean,
  minPiece: number,
): Pt[][] | null {
  const len = polylineLength(pts)
  const dropSpans = waterIntervals(terrain, pts).filter(([t0, t1]) => drop((t1 - t0) * len, t0, t1))
  if (dropSpans.length === 0) return null
  const pieces: Pt[][] = []
  let cursor = 0
  for (const [t0, t1] of [...dropSpans, [1, 1] as [number, number]]) {
    if ((t0 - cursor) * len >= minPiece) pieces.push(slicePolyline(pts, cursor, t0))
    cursor = t1
  }
  return pieces
}


function nearestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; d: number } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  const pt = { x: a.x + t * abx, y: a.y + t * aby }
  return { pt, d: Math.hypot(p.x - pt.x, p.y - pt.y) }
}

/**
 * Local shoreline tangent near `mid`: the nearest water-ring edge's
 * direction, averaged with its ±2 neighbors on the same ring. A single
 * marching-squares segment is a noisy tangent estimate — the contour
 * stair-steps along axis-aligned grid cells, so one segment can point
 * almost perpendicular to the shoreline's actual direction even though the
 * shoreline itself runs diagonally. Averaging unit directions over the
 * nearest 5 segments smooths that stair-step out.
 */
function nearestShorelineTangent(mid: Pt, terrain: Terrain): Pt | null {
  let bestD = Infinity
  let bestRing: Array<[number, number]> | null = null
  let bestI = -1
  for (const poly of terrain.water) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = { x: ring[i][0], y: ring[i][1] }
        const b = { x: ring[(i + 1) % ring.length][0], y: ring[(i + 1) % ring.length][1] }
        const { d } = nearestOnSegment(mid, a, b)
        if (d < bestD) {
          bestD = d
          bestRing = ring
          bestI = i
        }
      }
    }
  }
  if (!bestRing || bestI < 0) return null
  const ring = bestRing
  const n = ring.length
  let sx = 0
  let sy = 0
  for (let k = -2; k <= 2; k++) {
    const i = ((bestI + k) % n + n) % n
    const a = { x: ring[i][0], y: ring[i][1] }
    const b = { x: ring[(i + 1) % n][0], y: ring[(i + 1) % n][1] }
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    sx += dx / len
    sy += dy / len
  }
  // at a sharp cusp the 5 unit tangents nearly cancel — the direction of a
  // near-zero sum is noise, so report "no reliable tangent" (caller treats
  // the crossing as not bridgeable, the conservative default). Threshold is
  // deliberately low: on a small ring the ±2 window wraps and opposite edges
  // structurally cancel down to ~1.0 while still leaving a valid dominant
  // direction — only true cancellation (≈0) is unreliable.
  if (Math.hypot(sx, sy) < 0.5) return null
  return { x: sx, y: sy }
}

/** angle between two undirected lines, in [0, PI/2] (0 = parallel, PI/2 = perpendicular) */
function lineAngle(u: Pt, v: Pt): number {
  let diff = Math.abs(Math.atan2(u.y, u.x) - Math.atan2(v.y, v.x)) % Math.PI
  if (diff > Math.PI / 2) diff = Math.PI - diff
  return diff
}

function isRiverCrossing(mid: Pt, terrain: Terrain): boolean {
  const river = terrain.riverSlice
  return !!river && distToPolyline(mid, river.course) < 2 * river.width
}

/**
 * Compute a crossing's landing points: perpendicular-to-flow across a river,
 * or straight along the road direction otherwise. Endpoints extend ONLY
 * along the host road's own axis (or the river-perpendicular normal for a
 * river crossing) — never bent sideways to reach some other road; a landing
 * that misses the network stays a dead end (or gets truncated, see
 * truncateUnlandableRoads/crossingBridgeable).
 */
/**
 * Bridge landings: the deck runs straight along the host road's own line,
 * pushed LANDING meters onto land at both banks. (A perpendicular-to-river
 * deck was tried and reverted twice: rotating the deck off the road's axis
 * either bends the host arterial to meet it or needs bank-parallel approach
 * ramps that read as brackets. An oblique straight crossing looks right and
 * keeps every road collinear.)
 */
function landingFor(
  pts: Pt[], t0: number, t1: number, len: number, _terrain: Terrain,
): { p: Pt; q: Pt; tp: number; tq: number } {
  const tp = Math.max(0, t0 - LANDING / len)
  const tq = Math.min(1, t1 + LANDING / len)
  return { p: pointAtT(pts, tp), q: pointAtT(pts, tq), tp, tq }
}

/**
 * A crossing is bridgeable only if both landings clear the water AND — for a
 * non-river (sea/lake) crossing — the bridge runs roughly perpendicular to
 * the local shoreline (>= MIN_SHORE_ANGLE off the shore tangent). A crossing
 * that would run nearly parallel to the coast (a road skimming a water
 * finger) isn't a real crossing and doesn't get a bridge. River crossings
 * are exempt: landingFor already re-orients them perpendicular to flow.
 */
function crossingBridgeable(pts: Pt[], t0: number, t1: number, len: number, terrain: Terrain): boolean {
  const { p, q } = landingFor(pts, t0, t1, len, terrain)
  if (inWater(terrain, p) || inWater(terrain, q)) return false
  const mid = pointAtT(pts, (t0 + t1) / 2)
  if (isRiverCrossing(mid, terrain)) return true
  const tangent = nearestShorelineTangent(mid, terrain)
  // no reliable tangent (cusp, degenerate ring): conservative — don't bridge
  if (!tangent) return false
  return lineAngle({ x: q.x - p.x, y: q.y - p.y }, tangent) >= MIN_SHORE_ANGLE
}

/**
 * A crossing that can't be bridged (landing still in water, or — for a sea
 * crossing — running too near-parallel to the shoreline) truncates the host
 * at the waterline for that crossing instead. Meant for sea/lake-touching
 * endpoints after snapping.
 */
export function truncateUnlandableRoads(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) {
      out.push(road)
      continue
    }
    const len = polylineLength(road.points)
    const unbridgeable: Array<[number, number]> = []
    for (const [t0, t1] of waterIntervals(terrain, road.points)) {
      if (!crossingBridgeable(road.points, t0, t1, len, terrain)) unbridgeable.push([t0, t1])
    }
    if (unbridgeable.length === 0) {
      out.push(road)
      continue
    }
    const pieces = splitRoad(
      road.points, terrain,
      (_span, t0, t1) => unbridgeable.some(([u0, u1]) => u0 === t0 && u1 === t1),
      MIN_STREET_PIECE,
    )
    if (!pieces) {
      out.push(road)
      continue
    }
    pieces.forEach((points, i) => out.push({ ...road, id: `${road.id}-${i + 1}`, points }))
  }
  return out
}

/**
 * Mark wet spans of traced roads as bridges. A road with no wet interval is
 * returned as-is. Otherwise it is split into dry pieces (ids `<id>-<n>`,
 * dropped if shorter than MIN_STREET_PIECE) and wet pieces (`<id>-b<n>`,
 * bridge: true, widened by LANDING metres of dry road each side, clamped to
 * the polyline, never dropped). segments/crossings are copied to every piece.
 */
export function markWetSpans(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    const len = polylineLength(road.points)
    const wet = waterIntervals(terrain, road.points)
    if (wet.length === 0 || len === 0) {
      out.push(road)
      continue
    }
    const pad = LANDING / len
    const merged: Array<[number, number]> = []
    for (const [t0, t1] of wet) {
      const a = Math.max(0, t0 - pad)
      const b = Math.min(1, t1 + pad)
      const last = merged[merged.length - 1]
      if (last && a <= last[1]) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    let dry = 0
    let br = 0
    let cursor = 0
    const dryPiece = (t0: number, t1: number) => {
      if ((t1 - t0) * len >= MIN_STREET_PIECE) {
        dry += 1
        out.push({ ...road, id: `${road.id}-${dry}`, points: slicePolyline(road.points, t0, t1) })
      }
    }
    for (const [a, b] of merged) {
      dryPiece(cursor, a)
      br += 1
      out.push({ ...road, id: `${road.id}-b${br}`, bridge: true, points: slicePolyline(road.points, a, b) })
      cursor = b
    }
    dryPiece(cursor, 1)
  }
  return out
}
