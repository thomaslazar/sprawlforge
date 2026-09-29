import { polylineLength, type Pt } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { inWater } from '../sector/bridges'
import { distToPolyline } from '../terrain/rivers'
import type { Road, SectorParams, Terrain } from '../types'
import { buildRoadField, type BasisField, type RoadField } from './field'
import { MAJOR, RoadIndex, measureCorridorWidth, traceStreamline, type TraceOpts } from './trace'

export const HIGHWAY_WIDTH = 32

const AXIS_JITTER = Math.PI / 9 // ± 20°
const ENTRY_ATTEMPTS = 3
const ENTRY_LO = 0.3
const ENTRY_SPAN = 0.4
const SPAN_TOL = 1 // "reaching the opposite edge within 1 m" counts as spanning (R11)
// a stop point this close to riverSlice.course counts as the river (vs.
// sea/lake, which just ends the trace) — wider than riverSlice.width itself
// since the actual carve varies past that single scalar average
const RIVER_BAND_FACTOR = 1.5
const BRIDGE_MAX_TURN_FROM_HEADING = Math.PI / 4 // R12: bridge chord ≤ 45° off the recent approach heading

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
const clampToWindow = (p: Pt, sizeM: number): Pt => ({ x: clamp(0, sizeM, p.x), y: clamp(0, sizeM, p.y) })

const normalize = (v: Pt): Pt => {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}

export function spineBasis(angle: number, weight = 2): BasisField {
  return { name: 'spine', angle: () => angle, weight: () => weight }
}

/** unit tangent of the polyline segment nearest to p */
function nearestTangent(line: Pt[], p: Pt): Pt {
  let best = Infinity
  let tangent: Pt = { x: 0, y: 1 }
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby || 1
    const t = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)
    const d = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    if (d < best) { best = d; tangent = normalize({ x: abx, y: aby }) }
  }
  return tangent
}

/** clamp the angle of `to` to at most maxRad from `from` (both unit vectors) */
function clampAngleTo(from: Pt, to: Pt, maxRad: number): Pt {
  const a0 = Math.atan2(from.y, from.x)
  const a1 = Math.atan2(to.y, to.x)
  const diff = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
  const a = a0 + clamp(-maxRad, maxRad, diff)
  return { x: Math.cos(a), y: Math.sin(a) }
}

interface EdgeSpec {
  name: 'top' | 'left' | 'bottom' | 'right'
  /** the field's spine axis for this edge, before the ± jitter — perpendicular to the edge */
  axisBase: number
  seedAt(pos: number, sizeM: number): Pt
  /** unit direction pointing inward from this edge */
  dir: Pt
  /** the coordinate that advances as the trace moves inward, away from this edge */
  travelCoord: 'x' | 'y'
  oppositeValue(sizeM: number): number
  /** the other coordinate — used to detect a side-edge exit before reaching the opposite edge */
  perpCoord: 'x' | 'y'
}

// R11: search order top, left, bottom, right — the first edge whose trace
// spans to its opposite edge wins outright.
const EDGES: EdgeSpec[] = [
  {
    name: 'top', axisBase: Math.PI / 2, seedAt: (pos) => ({ x: pos, y: 1 }), dir: { x: 0, y: 1 },
    travelCoord: 'y', oppositeValue: (sizeM) => sizeM, perpCoord: 'x',
  },
  {
    name: 'left', axisBase: 0, seedAt: (pos) => ({ x: 1, y: pos }), dir: { x: 1, y: 0 },
    travelCoord: 'x', oppositeValue: (sizeM) => sizeM, perpCoord: 'y',
  },
  {
    name: 'bottom', axisBase: Math.PI / 2, seedAt: (pos, sizeM) => ({ x: pos, y: sizeM - 1 }), dir: { x: 0, y: -1 },
    travelCoord: 'y', oppositeValue: () => 0, perpCoord: 'x',
  },
  {
    name: 'right', axisBase: 0, seedAt: (pos, sizeM) => ({ x: sizeM - 1, y: pos }), dir: { x: -1, y: 0 },
    travelCoord: 'x', oppositeValue: () => 0, perpCoord: 'y',
  },
]

/**
 * Trace one highway from `seedAt` on `edge`, inward. `crossWater` stays off
 * for the whole trace (R6: the highway must not ride the field's own
 * river-following behavior); when the trace stops dry at the river's edge,
 * bridge straight across — the course normal, oriented toward the recent
 * approach heading and clamped to at most 45° off it (R12) — to the first
 * dry point measured the way riverCrossingSeeds does, then resume from there
 * with dir = the bridge direction (so the splice OUT of the bridge stays
 * turn-continuous with the resumed trace; the splice INTO the bridge is a
 * one-off engineered transition, not subject to the tracer's own curvature
 * limit). Exactly one bridge per trace (R12) — a second river stop just
 * ends the trace where it stands. A stop at water that ISN'T the river
 * (sea/lake), a side-edge exit, or a corridor too wide to bridge (>450 m)
 * all just end the trace where it stands — the caller compares candidates
 * by length and by whether they spanned, so a shorter dead end simply loses
 * to a better entry.
 */
function traceFromEdge(
  field: RoadField, edge: EdgeSpec, seedAt: Pt, terrain: Terrain, sizeM: number,
  opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number,
): Pt[] | null {
  const index = new RoadIndex(200) // R6: nothing to snap to yet
  let points: Pt[] | null = null
  let at = seedAt
  let dir = edge.dir
  let bridged = false

  for (;;) {
    const seg = traceStreamline(
      field, 'major', { at, dir, axis: 'major', crossWater: false }, terrain, sizeM, index, opts, rng, irregularityAt,
    )
    if (!seg) return points
    points = points ? points.concat(seg.slice(1)) : seg

    const last = points[points.length - 1]
    if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) return points // reached the far edge
    const onSide = last[edge.perpCoord] > 1e-6 && last[edge.perpCoord] < sizeM - 1e-6
    if (!onSide || bridged) return points // exited a side edge, or already used our one bridge (R12)

    const river = terrain.riverSlice
    if (!river || distToPolyline(last, river.course) > river.width * RIVER_BAND_FACTOR) return points // sea/lake — done

    const prev = points.length > 1 ? points[points.length - 2] : last
    const heading = normalize({ x: last.x - prev.x, y: last.y - prev.y })
    const tangent = nearestTangent(river.course, last)
    let normal = { x: -tangent.y, y: tangent.x }
    if (normal.x * heading.x + normal.y * heading.y < 0) normal = { x: -normal.x, y: -normal.y }
    normal = clampAngleTo(heading, normal, BRIDGE_MAX_TURN_FROM_HEADING) // R12

    const width = measureCorridorWidth(terrain, last, normal)
    if (width === null) return points // too wide to bridge — this trace is done

    // R1: a far-bank point computed from an in-window `last` plus a bounded
    // offset can still land fractionally outside — clamp before pushing.
    const farBank = clampToWindow({ x: last.x + normal.x * width, y: last.y + normal.y * width }, sizeM)
    points.push(farBank)
    at = farBank
    dir = normal
    bridged = true
  }
}

export function traceHighway(
  params: SectorParams, terrain: Terrain, sizeM: number,
): { road: Road; field: RoadField } {
  const rng = mulberry32(hashSeed(params.seed, 'highway'))
  const irregularityAt = effectiveIrregularity(params)
  const opts: TraceOpts = { ...MAJOR, maxSteps: 2000, maxTurn: MAJOR.step / 300 }

  let best: Pt[] | null = null
  let bestField: RoadField | null = null

  edgeLoop: for (const edge of EDGES) {
    const axis = edge.axisBase + (rng.next() * 2 - 1) * AXIS_JITTER
    const field = buildRoadField(params, terrain, sizeM, [spineBasis(axis)])

    for (let attempt = 0; attempt < ENTRY_ATTEMPTS; attempt++) {
      const pos = sizeM * (ENTRY_LO + ENTRY_SPAN * rng.next())
      const seedAt = edge.seedAt(pos, sizeM)
      if (inWater(terrain, seedAt)) continue // R11: skip a wet entry point

      const candidate = traceFromEdge(field, edge, seedAt, terrain, sizeM, opts, rng, irregularityAt)
      if (!candidate) continue
      if (!best || polylineLength(candidate) > polylineLength(best)) { best = candidate; bestField = field }

      const last = candidate[candidate.length - 1]
      if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) {
        best = candidate
        bestField = field
        break edgeLoop // R11: the first edge with a spanning trace wins
      }
    }
  }

  const road: Road = { id: 'H1', class: 'highway', width: HIGHWAY_WIDTH, name: null, points: best ?? [] }
  return { road, field: bestField ?? buildRoadField(params, terrain, sizeM, [spineBasis(Math.PI / 2)]) }
}
