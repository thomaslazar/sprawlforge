import { simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { buildRoadField, type RoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import {
  MAJOR, MINOR, RoadIndex, extendToJunction, poissonSeeds, riverCrossingSeeds, seedsAlong, traceLayer, trimStubs, type Seed,
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
const finalize = (roads: Road[], terrain: Terrain, index: RoadIndex) =>
  truncateUnlandableRoads(trimStubs(roads, index).map(simplify), terrain)

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
    field, 'minor', finalize(arterialsRaw, terrain, index).flatMap((a) => seedsAlong(a.points, 400, true)),
    terrain, sizeM, index, MAJOR, mulberry32(hashSeed(params.seed, 'arterials-2')), irregularityAt, 'B', 'arterial',
  )
  // truncate before seeding so S/L seeds come from the final arterials
  let arterials = finalize([...arterialsRaw, ...crossRaw], terrain, index)
  // an arterial must end on an arterial / the highway (not a street): extend before streets exist
  const artIndex = new RoadIndex(200)
  if (highway) artIndex.add(highway.id, highway.points, 'highway')
  arterials.forEach((r) => artIndex.add(r.id, r.points, r.class))
  arterials = extendToJunction(arterials, artIndex, terrain, sizeM, 600, 10, (c) => c === 'arterial' || c === 'highway', 300)
  index = new RoadIndex(200)
  if (highway) index.add(highway.id, highway.points, 'highway')
  arterials.forEach((r) => index.add(r.id, r.points, r.class))
  const pass1Raw = traceLayer(
    field, 'minor', arterials.flatMap((a) => seedsAlong(a.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street',
  )
  const pass1 = finalize(pass1Raw, terrain, index)
  const pass2Raw = traceLayer(
    field, 'major', pass1.flatMap((s) => seedsAlong(s.points, 100, true)),
    terrain, sizeM, index, MINOR, mulberry32(hashSeed(params.seed, 'streets-2')), irregularityAt, 'L', 'street',
  )
  let pass2 = finalize(pass2Raw, terrain, index)
  // the tracer only joins roads indexed at its own time: sweep dangling ends onto the final network
  const idx = new RoadIndex(200)
  const addAll = (rs: Road[]) => rs.forEach((r) => idx.add(r.id, r.points, r.class))
  if (highway) idx.add(highway.id, highway.points, 'highway')
  addAll(arterials); addAll(pass1); addAll(pass2)
  const pass1Ext = extendToJunction(pass1, idx, terrain, sizeM, 120)
  pass2 = extendToJunction(pass2, idx, terrain, sizeM, 120)
  return {
    highway: highway && simplify(highway),
    arterials,
    streets: { pass1: pass1Ext, pass2 },
  }
}
