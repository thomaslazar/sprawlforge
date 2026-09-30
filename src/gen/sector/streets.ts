import { simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { buildRoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import {
  MAJOR, MINOR, RoadIndex, poissonSeeds, riverCrossingSeeds, seedsAlong, traceLayer,
} from '../streets/trace'
import type { Road, SectorParams, Terrain } from '../types'
import { inWater, truncateUnlandableRoads } from './bridges'
import { effectiveIrregularity } from './zoning'

export interface TracedRoads {
  /** undefined when every window edge is sea */
  highway: Road | undefined
  arterials: Road[]
  /** both minor passes (S and L prefixes), all class 'street' */
  streets: { pass1: Road[]; pass2: Road[] }
}

const SIMPLIFY_M = 1
const simplify = (r: Road): Road => ({ ...r, points: simplifyPolyline(r.points, SIMPLIFY_M) })
// streets are skipped by truncateUnlandableRoads' own contract; only arterials can be cut
const finalize = (roads: Road[], terrain: Terrain) => truncateUnlandableRoads(roads.map(simplify), terrain)

/** field → highway → arterials → two street passes, in spec §4 order; every polyline simplified */
export function traceRoads(params: SectorParams, terrain: Terrain, sizeM: number): TracedRoads {
  const field = buildRoadField(params, terrain, sizeM)
  const irregularityAt = effectiveIrregularity(params)
  const traced = traceHighway(params, terrain, sizeM).road
  const highway = traced.points.length > 0 ? traced : undefined

  const index = new RoadIndex(200)
  if (highway) index.add(highway.id, highway.points, 'highway')

  const arterialRng = mulberry32(hashSeed(params.seed, 'arterials'))
  const arterialsRaw = traceLayer(
    field, 'major',
    [
      ...(highway ? seedsAlong(highway.points, 400, false) : []),
      ...riverCrossingSeeds(terrain, arterialRng),
      ...poissonSeeds(sizeM, 400, arterialRng, (p: Pt) => !inWater(terrain, p)),
    ],
    terrain, sizeM, index, MAJOR, arterialRng, irregularityAt, 'A', 'arterial',
  )
  // cross arterials on the minor axis, seeded from the major-axis ones — without
  // this pass a flat inland grid gets only parallel arterials that never meet
  // (they stop on rule 4 instead of snapping onto a crossing road)
  const crossRaw = traceLayer(
    field, 'minor', finalize(arterialsRaw, terrain).flatMap((a) => seedsAlong(a.points, 400, true)),
    terrain, sizeM, index, MAJOR, mulberry32(hashSeed(params.seed, 'arterials-2')), irregularityAt, 'B', 'arterial',
  )
  // truncate before seeding so S/L seeds come from the final arterials
  const arterials = finalize([...arterialsRaw, ...crossRaw], terrain)
  const pass1Raw = traceLayer(
    field, 'minor', arterials.flatMap((a) => seedsAlong(a.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street',
  )
  const pass1 = finalize(pass1Raw, terrain)
  const pass2Raw = traceLayer(
    field, 'major', pass1.flatMap((s) => seedsAlong(s.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets-2')), irregularityAt, 'L', 'street',
  )
  return {
    highway: highway && simplify(highway),
    arterials,
    streets: { pass1, pass2: finalize(pass2Raw, terrain) },
  }
}
