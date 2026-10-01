import { simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { buildRoadField, type RoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import {
  MAJOR, MINOR, RoadIndex, endKey, poissonSeeds, pruneDangling, riverCrossingSeeds, seedsAlong, traceLayer, trimStubs, type Seed,
} from '../streets/trace'
import type { Road, SectorParams, Terrain } from '../types'
import { inWater, truncateUnlandableRoads } from './bridges'
import { effectiveIrregularity } from './zoning'

export interface TracedRoads {
  /** undefined when every window edge is sea */
  highway: Road | undefined
  arterials: Road[]
  /** one queue-grown street set (S prefix), all class 'street' */
  streets: Road[]
}

const SIMPLIFY_M = 1
const simplify = (r: Road): Road => ({ ...r, points: simplifyPolyline(r.points, SIMPLIFY_M) })
// streets are skipped by truncateUnlandableRoads' own contract; only arterials can be cut
const finalize = (roads: Road[], terrain: Terrain, index: RoadIndex, maxStub = 40) =>
  truncateUnlandableRoads(trimStubs(roads, index, maxStub).map(simplify), terrain)
const ARTERIAL_STUB_M = 0.3 * MAJOR.separation

/** field → highway → arterials → queue-grown streets, in spec §4 order; every polyline simplified */
/** field axis closest to the seed's (highway-normal) direction: a highway seed must cross it, not run along it */
function crossingAxis(field: RoadField, s: Seed): 'major' | 'minor' {
  const m = field.sample(s.at).major
  return Math.abs(m.x * s.dir!.x + m.y * s.dir!.y) >= Math.SQRT1_2 ? 'major' : 'minor'
}

/** every seed forked off a parent road takes the axis that crosses it */
const crossing = (field: RoadField, seeds: Seed[]): Seed[] => seeds.map((x) => ({ ...x, axis: crossingAxis(field, x) }))

export function traceRoads(params: SectorParams, terrain: Terrain, sizeM: number): TracedRoads {
  const field = buildRoadField(params, terrain, sizeM)
  const irregularityAt = effectiveIrregularity(params)
  const traced = traceHighway(params, terrain, sizeM).road
  const highway = traced.points.length > 0 ? traced : undefined

  let index = new RoadIndex(200)
  if (highway) index.add(highway.id, highway.points, 'highway')

  const arterialRng = mulberry32(hashSeed(params.seed, 'arterials'))
  const arterialsRaw = traceLayer(
    field, 'major',
    [
      ...(highway ? crossing(field, seedsAlong(highway.points, 400, false)) : []),
      ...riverCrossingSeeds(terrain, arterialRng),
      ...poissonSeeds(sizeM, 400, arterialRng, (p: Pt) => !inWater(terrain, p)),
    ],
    terrain, sizeM, index, MAJOR, arterialRng, irregularityAt, 'A', 'arterial',
  )
  // cross arterials on the minor axis, seeded from the major-axis ones — without
  // this pass a flat inland grid gets only parallel arterials that never meet
  // (they stop on rule 4 instead of snapping onto a crossing road)
  const crossRaw = traceLayer(
    field, 'minor', finalize(arterialsRaw, terrain, index, ARTERIAL_STUB_M).flatMap((a) => crossing(field, seedsAlong(a.points, 400, true))),
    terrain, sizeM, index, MAJOR, mulberry32(hashSeed(params.seed, 'arterials-2')), irregularityAt, 'B', 'arterial',
  )
  // truncate before seeding so S/L seeds come from the final arterials
  let arterials = finalize([...arterialsRaw, ...crossRaw], terrain, index, ARTERIAL_STUB_M)
  const indexOf = (rs: Road[]) => {
    const idx = new RoadIndex(200)
    if (highway) idx.add(highway.id, highway.points, 'highway')
    rs.forEach((r) => idx.add(r.id, r.points, r.class))
    return idx
  }
  // prune, never invent: an arterial ends on an arterial / the highway / water / the edge, or the tail is cut
  arterials = pruneDangling(arterials, indexOf(arterials), terrain, sizeM, {
    accept: (c) => c === 'arterial' || c === 'highway', minLength: 300,
  })
  index = indexOf(arterials)
  const decayEnds: Pt[] = []
  // FIFO seed queue: arterial seeds first, then every kept street seeds its own
  // children (crossing it), so the fabric grows outward until nothing is left
  const queue = arterials.flatMap((a) => crossing(field, seedsAlong(a.points, 100, true)))
  const raw = traceLayer(
    field, 'minor', queue, terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street', decayEnds,
    (r) => crossing(field, seedsAlong(r.points, 100, true)),
  )
  const streets = finalize(raw, terrain, index)
  // streets may keep genuine decay cul-de-sacs; every other dangling end is pruned
  const all = indexOf([...arterials, ...streets])
  const pruned = pruneDangling(streets, all, terrain, sizeM, { accept: () => true, minLength: 60, keep: new Set(decayEnds.map(endKey)) })
  return {
    highway: highway && simplify(highway),
    arterials,
    streets: pruned,
  }
}
