import { bboxOf, onWindowEdge, pointAtT, pointInRings, polylineLength, ringsContainsFn, segmentCrossesPolyline, slicePolyline, type Pt } from '../geometry'
import { RING_ID_PREFIX } from '../landmarks/place'
import type { RoadIndex } from '../streets/trace'
import { PIN_SLACK, smoothBends } from '../streets/smooth'
import { distToPolyline, nearestOnPolyline } from '../terrain/rivers'
import type { Road, Terrain } from '../types'

const SAMPLE = 10
const LANDING = 15
const MIN_STREET_PIECE = 40
/** an arterial end piece shorter than this is a float crumb, not a landing */
const MIN_LANDING_PIECE = 1
// minimum angle (radians) between a sea bridge and the local shoreline
// tangent — below this the crossing reads as "running along the coast"
// rather than crossing it, so it gets truncated instead of bridged.
const MIN_SHORE_ANGLE = Math.PI / 4 // 45°

// terrain is immutable during a generation; index its water polygons once
const waterIndexCache = new WeakMap<Terrain, Array<(p: Pt) => boolean>>()

/** ponytail: land area on a 20 m sample grid, so +-1 % noise near a threshold */
export const landM2 = (terrain: Terrain, ring: Pt[]): number => {
  const b = bboxOf(ring)
  let land = 0
  for (let x = b.x; x < b.x + b.w; x += 20) for (let y = b.y; y < b.y + b.h; y += 20) {
    const s = { x: x + 10, y: y + 10 }
    if (pointInRings(s, [ring]) && !inWater(terrain, s)) land += 400
  }
  return land
}

export const inWater = (terrain: Terrain, p: Pt): boolean => {
  let fns = waterIndexCache.get(terrain)
  if (!fns) {
    fns = terrain.water.map((poly) => ringsContainsFn(poly))
    waterIndexCache.set(terrain, fns)
  }
  return fns.some((f) => f(p))
}

/** water at p or within r m of it (16-direction probe) */
export const nearWater = (terrain: Terrain, p: Pt, r: number): boolean => {
  if (inWater(terrain, p)) return true
  for (let a = 0; a < 16; a++) if (inWater(terrain, { x: p.x + r * Math.cos((a * Math.PI) / 8), y: p.y + r * Math.sin((a * Math.PI) / 8) })) return true
  return false
}

// water polygons as closed polylines, flagged `open` when one touches the window edge (sea, or the river where it leaves the window)
const shoreCache = new WeakMap<Terrain, Array<{ rings: Pt[][]; open: boolean }>>()
const RIVER_SLACK = 60 // the contoured river edge sits up to ~a grid cell (47 m at 6 km) off width/2

/**
 * A lake shore: the nearest water polygon is closed (touches no window edge) and p is not
 * within the river's band. Sea and river shores are the rest. ponytail: the river is told apart
 * by distance to its course, so a lake merged into the river's polygon counts as river.
 */
export function isLakeShore(terrain: Terrain, p: Pt, sizeM: number, weld = 6): boolean {
  const r = terrain.riverSlice
  if (r && distToPolyline(p, r.course) <= r.width / 2 + RIVER_SLACK + weld) return false
  let polys = shoreCache.get(terrain)
  if (!polys) {
    const edge = (q: [number, number]) => q[0] < 2 || q[1] < 2 || q[0] > sizeM - 2 || q[1] > sizeM - 2
    polys = terrain.water.map((poly) => ({
      rings: poly.map((ring) => [...ring, ring[0]].map(([x, y]) => ({ x, y }))),
      open: poly.some((ring) => ring.some(edge)),
    }))
    shoreCache.set(terrain, polys)
  }
  let best: { d: number; open: boolean } | null = null
  for (const poly of polys) for (const ring of poly.rings) {
    const d = nearestOnPolyline(p, ring).dist
    if (!best || d < best.d) best = { d, open: poly.open }
  }
  return !!best && !best.open
}

/** the dry runs of a street's points as separate pieces: wet points are cut, streets never bridge (ponytail: a thin stream crossed between two dry points is missed) */
export function dryStreetPieces(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  return roads.flatMap((r) => {
    const runs: Pt[][] = [[]]
    for (const q of r.points) {
      if (inWater(terrain, q)) { if (runs.at(-1)!.length) runs.push([]) } else runs.at(-1)!.push(q)
    }
    const keep = runs.filter((run) => run.length >= 2)
    if (keep.length === 1 && keep[0].length === r.points.length) return [r]
    return keep.map((points, i) => ({ ...r, id: keep.length > 1 ? `${r.id}-${i + 1}` : r.id, points }))
  })
}

/**
 * The dry runs of segment p-q, sampled every 10 m: a run ends at its last dry sample, so a cut stops up to
 * 10 m short of the shore. ponytail: 10 m sampling, a pond narrower than that is missed.
 */
export function dryRuns(terrain: Terrain, p: Pt, q: Pt, skip?: (pt: Pt) => boolean): Array<[Pt, Pt]> {
  const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 10))
  const at = (i: number) => ({ x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n })
  const out: Array<[Pt, Pt]> = []
  let start = -1
  for (let i = 0; i <= n + 1; i++) {
    const dry = i <= n && !inWater(terrain, at(i)) && !skip?.(at(i))
    if (dry && start < 0) start = i
    if (!dry && start >= 0) { if (i - 1 > start) out.push([at(start), at(i - 1)]); start = -1 }
  }
  return out
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
 * dropped if shorter than MIN_STREET_PIECE, except an arterial's end piece:
 * that is the short dry landing from the deck onto the far-bank road, kept so
 * no gap opens; a short dry gap between two decks is bridged over) and wet pieces (`<id>-b<n>`,
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
      // a dry gap too short to keep as a road piece is bridged over, never left as a hole
      if (last && (a - last[1]) * len < MIN_STREET_PIECE) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    let dry = 0
    let br = 0
    let cursor = 0
    // an arterial's end piece is its landing on the road past the bank (anchored): kept at any length
    const keepShort = road.class === 'arterial' || road.class === 'highway'
    const dryPiece = (t0: number, t1: number) => {
      const atEnd = t0 === 0 || t1 === 1
      if ((t1 - t0) * len >= (keepShort && atEnd ? MIN_LANDING_PIECE : MIN_STREET_PIECE)) {
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

const JOIN_MAX_SPAN = 550
const JOIN_MAX_TURN_COS = Math.cos(Math.PI / 4)
const JOIN_CLEARANCE = 0.3 * 400 // 0.3 * MAJOR.separation

interface StubEnd { road: Road; atStart: boolean; pt: Pt; dir: Pt }

/**
 * Join arterial stubs that face each other across the river into one road, so
 * markWetSpans later bridges the gap. An end qualifies when it is dry, off the
 * window edge and at the water; a pair when the span is <= JOIN_MAX_SPAN, a->b
 * crosses the river course, both heads point within 45 deg of it and no wet
 * sample of a->b lies near a highway or a third arterial. Greedy, shortest
 * span first; the result keeps A's id and fields, B is dropped (chains through
 * a road's far end are allowed).
 */
export function joinRiverStubs(roads: Road[], terrain: Terrain, sizeM: number, index: RoadIndex): Road[] {
  const river = terrain.riverSlice
  if (!river || terrain.water.length === 0) return roads
  const ends: StubEnd[] = []
  for (const road of roads) {
    const n = road.points.length
    if (road.class !== 'arterial' || road.id.startsWith(RING_ID_PREFIX) || n < 2) continue
    for (const atStart of [true, false]) {
      const pt = road.points[atStart ? 0 : n - 1], q = road.points[atStart ? 1 : n - 2]
      const len = Math.hypot(pt.x - q.x, pt.y - q.y)
      if (len === 0 || onWindowEdge(pt, sizeM, 1) || inWater(terrain, pt)) continue
      const dir = { x: (pt.x - q.x) / len, y: (pt.y - q.y) / len }
      if (nearWater(terrain, pt, 15) || inWater(terrain, { x: pt.x + dir.x * 15, y: pt.y + dir.y * 15 })) ends.push({ road, atStart, pt, dir })
    }
  }
  const pairs: Array<{ a: StubEnd; b: StubEnd; span: number }> = []
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const a = ends[i], b = ends[j]
    if (a.road === b.road) continue
    const dx = b.pt.x - a.pt.x, dy = b.pt.y - a.pt.y, span = Math.hypot(dx, dy)
    if (span === 0 || span > JOIN_MAX_SPAN) continue
    if ((a.dir.x * dx + a.dir.y * dy) / span < JOIN_MAX_TURN_COS || -(b.dir.x * dx + b.dir.y * dy) / span < JOIN_MAX_TURN_COS) continue
    if (!segmentCrossesPolyline(a.pt, b.pt, river.course)) continue
    pairs.push({ a, b, span })
  }
  pairs.sort((u, v) => u.span - v.span)

  const points = new Map(roads.map((r) => [r.id, r.points]))
  const root = new Map<string, string>() // consumed road id -> the road that absorbed it
  const members = new Map(roads.map((r) => [r.id, new Set([r.id])]))
  const find = (id: string): string => { while (root.has(id)) id = root.get(id)!; return id }
  const used = new Set<StubEnd>()
  for (const { a, b } of pairs) {
    if (used.has(a) || used.has(b)) continue
    const ra = find(a.road.id), rb = find(b.road.id)
    if (ra === rb) continue
    const ids = new Set([...members.get(ra)!, ...members.get(rb)!])
    let clear = true
    const n = Math.ceil(Math.hypot(b.pt.x - a.pt.x, b.pt.y - a.pt.y) / SAMPLE)
    for (let k = 1; k < n && clear; k++) {
      const q = { x: a.pt.x + ((b.pt.x - a.pt.x) * k) / n, y: a.pt.y + ((b.pt.y - a.pt.y) * k) / n }
      clear = !inWater(terrain, q) || !index.nearestMatching(q, JOIN_CLEARANCE, (h) => (h.cls === 'highway' || h.cls === 'arterial') && !ids.has(h.id))
    }
    if (!clear) continue
    used.add(a); used.add(b)
    const pa = points.get(ra)!, pb = points.get(rb)!
    const same = (p: Pt, q: Pt) => p.x === q.x && p.y === q.y
    points.set(ra, [...(same(pa.at(-1)!, a.pt) ? pa : pa.slice().reverse()), ...(same(pb[0], b.pt) ? pb : pb.slice().reverse())])
    points.delete(rb)
    root.set(rb, ra)
    for (const id of members.get(rb)!) members.get(ra)!.add(id)
  }
  // the deck join is a hard bend: smooth the merged road, keeping vertices that sit on another road's end
  return root.size === 0 ? roads : roads.filter((r) => !root.has(r.id)).map((r) => {
    if (points.get(r.id) === r.points) return r
    const mine = members.get(r.id)!
    const pinned = (v: Pt, t: number, arc: Pt[]) => {
      let moved = false
      index.forEachInRadius(v, t + 6, (h, at, _d, edge) => { if (!mine.has(h.id) && edge < 1 && distToPolyline(at, arc) > PIN_SLACK) moved = true })
      return moved
    }
    return { ...r, points: smoothBends(points.get(r.id)!, 60, pinned) }
  })
}
