import { pointInRings, type Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, Terrain } from '../types'

const SAMPLE = 10
const MAX_SPAN: Record<'highway' | 'arterial', number> = { highway: 900, arterial: 450 }
const LANDING = 15
const MIN_STREET_PIECE = 40
// A landing within this distance of another road counts as touching it (matches the
// T-junction tolerance the connectivity model uses — see roads.test.ts).
const NETWORK_REACH_TOL = 30
// ponytail: fixed cap, not a real nearest-road search bounded by block geometry — a
// landing further than this from anything stays isolated. Revisit if that ever fires
// on a real seed (observed worst case so far: ~100 m).
const NETWORK_REACH_MAX = 300

export const inWater = (terrain: Terrain, p: Pt): boolean =>
  terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))

const at = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * Walk a 2-point segment, returning [t0,t1] water intervals (0..1). Interval
 * bounds always land on a *dry* sample (the last dry step before wet, and
 * the first dry step after) so land pieces built from these bounds never
 * carry a wet endpoint — sampling resolution rounds intervals slightly wide
 * into the water, never short into it.
 */
function waterIntervals(terrain: Terrain, a: Pt, b: Pt): Array<[number, number]> {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(2, Math.ceil(len / SAMPLE))
  const spans: Array<[number, number]> = []
  let start = -1
  let lastDry = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const wet = inWater(terrain, at(a, b, t))
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
 * Split a's-to-b's water spans that pass `drop` into land-only pieces (each
 * kept piece length >= minPiece); spans `drop` rejects are left alone (still
 * embedded in the returned piece's line) — that's how a bridgeable crossing
 * survives while a too-long one gets excised. Returns null if nothing needed
 * dropping, so callers can tell "unchanged" from "one piece, still whole".
 */
function splitRoad(
  a: Pt,
  b: Pt,
  terrain: Terrain,
  drop: (spanLen: number, t0: number, t1: number) => boolean,
  minPiece: number,
): Array<[Pt, Pt]> | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const dropSpans = waterIntervals(terrain, a, b).filter(([t0, t1]) => drop((t1 - t0) * len, t0, t1))
  if (dropSpans.length === 0) return null
  const pieces: Array<[Pt, Pt]> = []
  let cursor = 0
  for (const [t0, t1] of [...dropSpans, [1, 1] as [number, number]]) {
    if ((t0 - cursor) * len >= minPiece) pieces.push([at(a, b, cursor), at(a, b, t0)])
    cursor = t1
  }
  return pieces
}

export function clipRoadsToLand(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class !== 'street') {
      out.push(road)
      continue
    }
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const pieces = splitRoad(a, b, terrain, () => true, MIN_STREET_PIECE)
    if (!pieces) {
      out.push(road)
      continue
    }
    pieces.forEach((points, i) => out.push({ ...road, id: `${road.id}-${i + 1}`, points }))
  }
  return out
}

/**
 * Highways/arterials keep their line through water (a bridge floats over a
 * crossing within MAX_SPAN) — but a crossing *longer* than MAX_SPAN has no
 * bridge and must not render as a road over open water: truncate the host
 * at the water's edge, same mechanism as `clipRoadsToLand`, but only for the
 * over-span intervals (a shorter, bridgeable crossing on the same road is
 * left untouched).
 */
export function truncateOverSpanRoads(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) {
      out.push(road)
      continue
    }
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const maxSpan = MAX_SPAN[road.class as 'highway' | 'arterial']
    const pieces = splitRoad(a, b, terrain, (span) => span > maxSpan, MIN_STREET_PIECE)
    if (!pieces) {
      out.push(road)
      continue
    }
    pieces.forEach((points, i) => out.push({ ...road, id: `${road.id}-${i + 1}`, points }))
  }
  return out
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
 * A landing computed from water geometry alone (especially the perpendicular
 * re-orientation, which deliberately points across the river rather than
 * along the host road) can end up well clear of the street/arterial grid it
 * should meet on that bank. If the nearest other road is further than the
 * ordinary T-junction tolerance but still within reach, pull the landing
 * onto it — this only ever moves the bridge's own new endpoint, never
 * another road's geometry.
 */
function reachNetwork(p: Pt, roads: Road[], skip: Road): Pt {
  let best: { pt: Pt; d: number } | null = null
  for (const other of roads) {
    if (other === skip) continue
    const { pt, d } = nearestOnSegment(p, other.points[0], other.points[other.points.length - 1])
    if (!best || d < best.d) best = { pt, d }
  }
  return best && best.d > NETWORK_REACH_TOL && best.d <= NETWORK_REACH_MAX ? best.pt : p
}

/**
 * Compute a crossing's landing points: perpendicular-to-flow across a river,
 * or straight along the road direction otherwise — then pulled onto the
 * nearby road network if one is in reach. Shared by planBridges (to build
 * the bridge) and truncateUnlandableRoads (to check the crossing is even
 * bridgeable before committing to it).
 */
function landingFor(
  a: Pt,
  b: Pt,
  t0: number,
  t1: number,
  len: number,
  terrain: Terrain,
  roads: Road[],
  road: Road,
): { p: Pt; q: Pt } {
  const mid = at(a, b, (t0 + t1) / 2)
  let p = at(a, b, t0)
  let q = at(a, b, t1)
  const river = terrain.riverSlice
  if (river && distToPolyline(mid, river.course) < 2 * river.width) {
    // re-orient perpendicular to local flow
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < river.course.length - 1; i++) {
      const d = distToPolyline(mid, [river.course[i], river.course[i + 1]])
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    const fa = river.course[bestI]
    const fb = river.course[bestI + 1]
    const fl = Math.hypot(fb.x - fa.x, fb.y - fa.y) || 1
    const normal = { x: -(fb.y - fa.y) / fl, y: (fb.x - fa.x) / fl }
    const extend = (dirSign: number): Pt => {
      let pt = { ...mid }
      for (let s = 0; s < 80; s++) {
        const next = { x: pt.x + normal.x * 25 * dirSign, y: pt.y + normal.y * 25 * dirSign }
        pt = next
        if (!inWater(terrain, pt)) break
      }
      // clear the waterline with the same landing margin as the straight case
      return { x: pt.x + normal.x * dirSign * LANDING, y: pt.y + normal.y * dirSign * LANDING }
    }
    p = extend(-1)
    q = extend(1)
  } else {
    // push landings onto land along the road direction
    p = at(a, b, Math.max(0, t0 - LANDING / len))
    q = at(a, b, Math.min(1, t1 + LANDING / len))
  }
  p = reachNetwork(p, roads, road)
  q = reachNetwork(q, roads, road)
  return { p, q }
}

/**
 * A crossing whose landing computation still leaves an endpoint in water
 * (map edge / land-bbox edge near a diagonal coastline, or the river
 * extension loop capping out without reaching land) cannot be bridged.
 * Truncate the host at the waterline for that crossing instead — same
 * splitRoad mechanism truncateOverSpanRoads uses for over-span crossings.
 * Run this after truncateOverSpanRoads and before planBridges so the
 * crossings planBridges sees are only ever the landable ones.
 */
export function truncateUnlandableRoads(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) {
      out.push(road)
      continue
    }
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const maxSpan = MAX_SPAN[road.class as 'highway' | 'arterial']
    const unlandable: Array<[number, number]> = []
    for (const [t0, t1] of waterIntervals(terrain, a, b)) {
      const span = (t1 - t0) * len
      if (span > maxSpan) continue // already excised by truncateOverSpanRoads
      const { p, q } = landingFor(a, b, t0, t1, len, terrain, roads, road)
      if (inWater(terrain, p) || inWater(terrain, q)) unlandable.push([t0, t1])
    }
    if (unlandable.length === 0) {
      out.push(road)
      continue
    }
    const pieces = splitRoad(
      a, b, terrain,
      (_span, t0, t1) => unlandable.some(([u0, u1]) => u0 === t0 && u1 === t1),
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

export function planBridges(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return []
  const bridges: Road[] = []
  let n = 0
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) continue
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    for (const [t0, t1] of waterIntervals(terrain, a, b)) {
      const span = (t1 - t0) * len
      if (span > MAX_SPAN[road.class as 'highway' | 'arterial']) continue
      const { p, q } = landingFor(a, b, t0, t1, len, terrain, roads, road)
      // a crossing that can't land on both banks isn't bridged — the host
      // road gets truncated at the waterline instead (truncateUnlandableRoads)
      if (inWater(terrain, p) || inWater(terrain, q)) continue
      n += 1
      bridges.push({
        id: `BR${String(n).padStart(2, '0')}`,
        class: road.class,
        points: [p, q],
        width: road.width,
        name: null,
        bridge: true,
      })
    }
  }
  return bridges
}
