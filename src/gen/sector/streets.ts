import { simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { buildRoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import {
  MAJOR, MINOR, RoadIndex, poissonSeeds, riverCrossingSeeds, seedsAlong, traceLayer,
} from '../streets/trace'
import type { Road, SectorParams, Terrain } from '../types'
import { inWater } from './bridges'
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

/** field → highway → arterials → two street passes, in spec §4 order; every polyline simplified */
export function traceRoads(params: SectorParams, terrain: Terrain, sizeM: number): TracedRoads {
  const field = buildRoadField(params, terrain, sizeM)
  const irregularityAt = effectiveIrregularity(params)
  const traced = traceHighway(params, terrain, sizeM).road
  const highway = traced.points.length > 0 ? traced : undefined

  const index = new RoadIndex(200)
  if (highway) index.add(highway.id, highway.points, 'highway')

  const arterialRng = mulberry32(hashSeed(params.seed, 'arterials'))
  const arterials = traceLayer(
    field, 'major',
    [
      ...(highway ? seedsAlong(highway.points, 400, false) : []),
      ...riverCrossingSeeds(terrain, arterialRng),
      ...poissonSeeds(sizeM, 400, arterialRng, (p: Pt) => !inWater(terrain, p)),
    ],
    terrain, sizeM, index, MAJOR, arterialRng, irregularityAt, 'A', 'arterial',
  )
  const pass1 = traceLayer(
    field, 'minor', arterials.flatMap((a) => seedsAlong(a.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street',
  )
  const pass2 = traceLayer(
    field, 'major', pass1.flatMap((s) => seedsAlong(s.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets-2')), irregularityAt, 'L', 'street',
  )
  return {
    highway: highway && simplify(highway),
    arterials: arterials.map(simplify),
    streets: { pass1: pass1.map(simplify), pass2: pass2.map(simplify) },
  }
}
