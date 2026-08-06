import { pointInRings, type Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, Terrain } from '../types'

const SAMPLE = 10
const MAX_SPAN: Record<'highway' | 'arterial', number> = { highway: 900, arterial: 450 }
const LANDING = 15
const MIN_STREET_PIECE = 40
// minimum angle (radians) between a sea bridge and the local shoreline
// tangent — below this the crossing reads as "running along the coast"
// rather than crossing it, so it gets truncated instead of bridged.
const MIN_SHORE_ANGLE = Math.PI / 4 // 45°

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

/** split every road matching `include` at every water interval it crosses */
function splitAllWater(roads: Road[], terrain: Terrain, include: (r: Road) => boolean): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (!include(road)) {
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

export function clipRoadsToLand(roads: Road[], terrain: Terrain): Road[] {
  return splitAllWater(roads, terrain, (r) => r.class === 'street')
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
function landingFor(
  a: Pt, b: Pt, t0: number, t1: number, len: number, terrain: Terrain,
): { p: Pt; q: Pt; axisP: Pt; axisQ: Pt } {
  const mid = at(a, b, (t0 + t1) / 2)
  let p = at(a, b, t0)
  let q = at(a, b, t1)
  const river = terrain.riverSlice
  // perpendicular reorientation only makes sense for a genuine two-bank
  // crossing (dry sample on both raw sides); a water interval that reaches
  // all the way to the road's own endpoint (t0<=0 or t1>=1) means the road
  // just ends inside the water — there's no "far bank" to swing toward, so
  // fall through to the straight branch, which correctly reports it unlandable
  if (river && isRiverCrossing(mid, terrain) && t0 > 0 && t1 < 1) {
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
  // on-axis bank points: host stubs must end HERE (on the road's own line),
  // never at a rotated deck endpoint — snapping stubs to a perpendicular
  // deck visibly bent whole arterials (the "drifting" bridge bug)
  const axisP = at(a, b, Math.max(0, t0 - LANDING / len))
  const axisQ = at(a, b, Math.min(1, t1 + LANDING / len))
  return { p, q, axisP, axisQ }
}

/**
 * A crossing is bridgeable only if both landings clear the water AND — for a
 * non-river (sea/lake) crossing — the bridge runs roughly perpendicular to
 * the local shoreline (>= MIN_SHORE_ANGLE off the shore tangent). A crossing
 * that would run nearly parallel to the coast (a road skimming a water
 * finger) isn't a real crossing and doesn't get a bridge. River crossings
 * are exempt: landingFor already re-orients them perpendicular to flow.
 */
function crossingBridgeable(a: Pt, b: Pt, t0: number, t1: number, len: number, terrain: Terrain): boolean {
  const { p, q } = landingFor(a, b, t0, t1, len, terrain)
  if (inWater(terrain, p) || inWater(terrain, q)) return false
  const mid = at(a, b, (t0 + t1) / 2)
  if (isRiverCrossing(mid, terrain)) return true
  const tangent = nearestShorelineTangent(mid, terrain)
  // no reliable tangent (cusp, degenerate ring): conservative — don't bridge
  if (!tangent) return false
  return lineAngle({ x: q.x - p.x, y: q.y - p.y }, tangent) >= MIN_SHORE_ANGLE
}

/**
 * A crossing that can't be bridged (landing still in water, or — for a sea
 * crossing — running too near-parallel to the shoreline) truncates the host
 * at the waterline for that crossing instead. Same splitRoad mechanism
 * truncateOverSpanRoads uses for over-span crossings. Run this after
 * truncateOverSpanRoads and before planBridges so the crossings planBridges
 * sees are only ever the landable, properly-angled ones.
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
    const unbridgeable: Array<[number, number]> = []
    for (const [t0, t1] of waterIntervals(terrain, a, b)) {
      const span = (t1 - t0) * len
      if (span > maxSpan) continue // already excised by truncateOverSpanRoads
      if (!crossingBridgeable(a, b, t0, t1, len, terrain)) unbridgeable.push([t0, t1])
    }
    if (unbridgeable.length === 0) {
      out.push(road)
      continue
    }
    const pieces = splitRoad(
      a, b, terrain,
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
 * Split the host road at every crossing it still spans (after
 * truncateOverSpanRoads + truncateUnlandableRoads, everything remaining on a
 * highway/arterial is a crossing planBridges will bridge) so the road itself
 * stops at the banks — only the bridge deck spans the water. Cuts land
 * exactly on the bridge's own landing points (landingFor's p/q), not the
 * raw waterline: a river crossing's landing is perpendicular-shifted off the
 * road's straight line, so cutting at the raw waterline would leave a gap
 * between the host stub and the bridge deck instead of a clean join.
 */
export function splitHostAtBridges(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) {
      out.push(road)
      continue
    }
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const intervals = waterIntervals(terrain, a, b)
    if (intervals.length === 0) {
      out.push(road)
      continue
    }
    let cursor = a
    const pieces: Array<[Pt, Pt]> = []
    for (const [t0, t1] of intervals) {
      const { axisP, axisQ } = landingFor(a, b, t0, t1, len, terrain)
      pieces.push([cursor, axisP])
      cursor = axisQ
    }
    pieces.push([cursor, b])
    pieces.forEach(([x, y], i) => out.push({ ...road, id: `${road.id}-${i + 1}`, points: [x, y] }))
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
      // a crossing that isn't bridgeable isn't bridged — the host road gets
      // truncated at the waterline instead (truncateUnlandableRoads)
      if (!crossingBridgeable(a, b, t0, t1, len, terrain)) continue
      const { p, q, axisP, axisQ } = landingFor(a, b, t0, t1, len, terrain)
      n += 1
      // when the deck is rotated perpendicular to the river, its endpoints
      // sit off the host road's line — short approach-ramp segments connect
      // the on-axis stub ends to the deck so the road dog-legs onto the
      // bridge instead of the whole arterial leaning to meet it
      const ramped = Math.hypot(p.x - axisP.x, p.y - axisP.y) > 1 ||
        Math.hypot(q.x - axisQ.x, q.y - axisQ.y) > 1
      bridges.push({
        id: `BR${String(n).padStart(2, '0')}`,
        class: road.class,
        points: ramped ? [axisP, p, q, axisQ] : [p, q],
        width: road.width,
        name: null,
        bridge: true,
      })
    }
  }
  return bridges
}
