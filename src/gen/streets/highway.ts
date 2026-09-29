import { polylineLength, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { distToPolyline } from '../terrain/rivers'
import type { Road, SectorParams, Terrain } from '../types'
import { buildRoadField, type BasisField, type RoadField } from './field'
import { MAJOR, RoadIndex, measureCorridorWidth, traceStreamline, type TraceOpts } from './trace'

export const HIGHWAY_WIDTH = 32

const AXIS_JITTER = Math.PI / 9 // vertical ± 20°
const ENTRY_ATTEMPTS = 3
const ENTRY_LO = 0.3
const ENTRY_SPAN = 0.4
// a stop point this close to riverSlice.course counts as the river (vs.
// sea/lake, which just ends the attempt) — wider than riverSlice.width
// itself since the actual carve varies past that single scalar average
const RIVER_BAND_FACTOR = 1.5
const MAX_BRIDGES_PER_ENTRY = 4

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
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
    const d = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    if (d < best) { best = d; tangent = normalize({ x: abx, y: aby }) }
  }
  return tangent
}

/**
 * Trace one highway entry from the top edge downward. `crossWater` stays
 * off for the whole trace (R6: highway must not ride the field's own
 * river-following behavior); when the trace stops dry at the river's edge,
 * bridge straight across (course normal, oriented forward) to the first dry
 * point measured the way riverCrossingSeeds does, then resume from there.
 * A stop at water that ISN'T the river (sea/lake), a side-edge exit, or a
 * corridor too wide to bridge all just end the attempt where it stands —
 * the caller compares attempts by length, so a shorter dead end simply
 * loses to a better entry x.
 */
function traceEntry(
  field: RoadField, terrain: Terrain, sizeM: number, entryX: number,
  opts: TraceOpts, rng: ReturnType<typeof mulberry32>, irregularityAt: (p: Pt) => number,
): Pt[] | null {
  const index = new RoadIndex(200) // R6: nothing to snap to yet
  let points: Pt[] | null = null
  let at: Pt = { x: entryX, y: 1 } // 1 m inside the window (traceStreamline rejects an out-of-window seed)
  let dir: Pt = { x: 0, y: 1 }

  for (let bridge = 0; bridge < MAX_BRIDGES_PER_ENTRY; bridge++) {
    const seg = traceStreamline(
      field, 'major', { at, dir, axis: 'major', crossWater: false }, terrain, sizeM, index, opts, rng, irregularityAt,
    )
    if (!seg) return points
    points = points ? points.concat(seg.slice(1)) : seg

    const last = points[points.length - 1]
    if (last.y >= sizeM - 1e-6) return points // reached the far edge
    const onSide = last.x > 1e-6 && last.x < sizeM - 1e-6
    if (!onSide) return points // exited a side edge, not the river

    const river = terrain.riverSlice
    if (!river || distToPolyline(last, river.course) > river.width * RIVER_BAND_FACTOR) return points // sea/lake — done

    const prev = points.length > 1 ? points[points.length - 2] : last
    const heading = normalize({ x: last.x - prev.x, y: last.y - prev.y })
    const tangent = nearestTangent(river.course, last)
    let normal = { x: -tangent.y, y: tangent.x }
    if (normal.x * heading.x + normal.y * heading.y < 0) normal = { x: -normal.x, y: -normal.y }

    const width = measureCorridorWidth(terrain, last, normal)
    if (width === null) return points // too wide to bridge — this entry is done

    const farBank = { x: last.x + normal.x * width, y: last.y + normal.y * width }
    points.push(farBank)
    at = farBank
    dir = normal
  }
  return points
}

export function traceHighway(
  params: SectorParams, terrain: Terrain, sizeM: number,
): { road: Road; field: RoadField } {
  const rng = mulberry32(hashSeed(params.seed, 'highway'))
  const axis = Math.PI / 2 + (rng.next() * 2 - 1) * AXIS_JITTER
  const field = buildRoadField(params, terrain, sizeM, [spineBasis(axis)])
  const irregularityAt = effectiveIrregularity(params)
  const opts: TraceOpts = { ...MAJOR, maxSteps: 2000, maxTurn: MAJOR.step / 300 }

  let best: Pt[] | null = null
  for (let attempt = 0; attempt < ENTRY_ATTEMPTS; attempt++) {
    const entryX = sizeM * (ENTRY_LO + ENTRY_SPAN * rng.next())
    const candidate = traceEntry(field, terrain, sizeM, entryX, opts, rng, irregularityAt)
    if (candidate && (!best || polylineLength(candidate) > polylineLength(best))) best = candidate
  }

  const road: Road = { id: 'H1', class: 'highway', width: HIGHWAY_WIDTH, name: null, points: best ?? [] }
  return { road, field }
}
