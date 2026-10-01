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
  /** both minor passes (S and L prefixes), all class 'street' */
  streets: { pass1: Road[]; pass2: Road[] }
}

const SIMPLIFY_M = 1
const simplify = (r: Road): Road => ({ ...r, points: simplifyPolyline(r.points, SIMPLIFY_M) })
// streets are skipped by truncateUnlandableRoads' own contract; only arterials can be cut
const finalize = (roads: Road[], terrain: Terrain, index: RoadIndex, maxStub = 40) =>
  truncateUnlandableRoads(trimStubs(roads, index, maxStub).map(simplify), terrain)
const ARTERIAL_STUB_M = 0.3 * MAJOR.separation

/** field → highway → arterials → two street passes, in spec §4 order; every polyline simplified */
/** field axis closest to the seed's (highway-normal) direction: a highway seed must cross it, not run along it */
function crossingAxis(field: RoadField, s: Seed): 'major' | 'minor' {
  const m = field.sample(s.at).major
  return Math.abs(m.x * s.dir!.x + m.y * s.dir!.y) >= Math.SQRT1_2 ? 'major' : 'minor'
}

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
      ...(highway ? seedsAlong(highway.points, 400, false).map((s) => ({ ...s, axis: crossingAxis(field, s) })) : []),
      ...riverCrossingSeeds(terrain, arterialRng),
      ...poissonSeeds(sizeM, 400, arterialRng, (p: Pt) => !inWater(terrain, p)),
    ],
    terrain, sizeM, index, MAJOR, arterialRng, irregularityAt, 'A', 'arterial',
  )
  // cross arterials on the minor axis, seeded from the major-axis ones — without
  // this pass a flat inland grid gets only parallel arterials that never meet
  // (they stop on rule 4 instead of snapping onto a crossing road)
  const crossRaw = traceLayer(
    field, 'minor', finalize(arterialsRaw, terrain, index, ARTERIAL_STUB_M).flatMap((a) => seedsAlong(a.points, 400, true)),
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
  const pass1Raw = traceLayer(
    field, 'minor', arterials.flatMap((a) => seedsAlong(a.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street', decayEnds,
  )
  const pass1 = finalize(pass1Raw, terrain, index)
  const pass2Raw = traceLayer(
    field, 'major', pass1.flatMap((s) => seedsAlong(s.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets-2')), irregularityAt, 'L', 'street', decayEnds,
  )
  const pass2 = finalize(pass2Raw, terrain, index)
  // streets may keep genuine decay cul-de-sacs; every other dangling end is pruned
  const all = indexOf([...arterials, ...pass1, ...pass2])
  const prune = { accept: () => true, minLength: 60, keep: new Set(decayEnds.map(endKey)) }
  const pass1Pruned = pruneDangling(pass1, all, terrain, sizeM, prune)
  const pass2Pruned = pruneDangling(pass2, all, terrain, sizeM, prune)
  return {
    highway: highway && simplify(highway),
    arterials,
    streets: { pass1: pass1Pruned, pass2: pass2Pruned },
  }
}
