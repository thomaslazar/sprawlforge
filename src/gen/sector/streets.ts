import { pointInRings, polylineLength, simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { placeLandmarks, ringRoad } from '../landmarks/place'
import { buildRoadField, radialBasis, type RoadField } from '../streets/field'
import { traceHighway } from '../streets/highway'
import {
  MAJOR, MINOR, RoadIndex, endKey, poissonSeeds, pruneDangling, riverCrossingSeeds, seedsAlong, traceLayer, trimStubs, type Seed,
} from '../streets/trace'
import type { Arcology, Megablock, Road, SectorParams, Terrain } from '../types'
import { dryStreetPieces, inWater, isLakeShore, truncateUnlandableRoads } from './bridges'
import { distToPolyline } from '../terrain/rivers'
import { effectiveIrregularity } from './zoning'

export interface TracedRoads {
  /** undefined when every window edge is sea */
  highway: Road | undefined
  arterials: Road[]
  /** arcology K roads (closed rings, open half rings); also present in `arterials` */
  ringRoads: Road[]
  arcologies: Arcology[]
  megablocks: Megablock[]
  /** one queue-grown street set (S prefix), all class 'street' */
  streets: Road[]
}

const SIMPLIFY_M = 1
const simplify = (r: Road): Road => ({ ...r, points: simplifyPolyline(r.points, SIMPLIFY_M) })
// streets are skipped by truncateUnlandableRoads' own contract; only arterials can be cut
const finalize = (roads: Road[], terrain: Terrain, index: RoadIndex, maxStub = 40) =>
  truncateUnlandableRoads(trimStubs(roads, index, maxStub).map(simplify), terrain)
/** a ~1 km ring gets only 2 seeds at the 400 m arterial spacing, and some die on neighbours: 200 m keeps >= 4 spokes */
const RING_SEED_M = 200
/** a spoke that leaves its ring and snaps back onto it (both ends within 6 m, shorter than half a lap) is a hairpin: drop it; zero-length ones too */
// rings[i] pairs 1:1 with arcologies[i] (both built by arcologies.map(ringRoad)); null = no K road (boulevard / embedded)
const dropHairpins = (roads: Road[], rings: (Road | null)[], arcologies: Arcology[]) => roads.filter((r) => r.points.length > 0 && !rings.some((k, i) =>
  k && (distToPolyline(r.points[0], k.points) <= 6 && distToPolyline(r.points[r.points.length - 1], k.points) <= 6
    && polylineLength(r.points) < Math.PI * (arcologies[i].radius + 60))))
/** a street stub may end at a river/sea shore (never a lake) and only if >= 150 m long, so it reads as a street to the water */
export const streetWaterAnchor = (terrain: Terrain, sizeM: number) => (p: Pt, stub: number) => stub >= 150 && !isLakeShore(terrain, p, sizeM)
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
  const baseField = buildRoadField(params, terrain, sizeM)
  const irregularityAt = effectiveIrregularity(params)
  const traced = traceHighway(params, terrain, sizeM).road
  const highway = traced.points.length > 0 ? traced : undefined

  const { arcologies, megablocks } = placeLandmarks(params, terrain, sizeM, traced.points.length > 0 ? traced : undefined, baseField)
  // arterials and streets bend toward each arcology, outside its ring road
  const field = arcologies.length
    ? buildRoadField(params, terrain, sizeM, arcologies.filter((a) => a.access === 'ring' || a.access === 'half').map((a) => radialBasis(a.center, a.radius + 60, 800)))
    : baseField
  const ringsOrNull = arcologies.map(ringRoad)
  const ringRoads = ringsOrNull.filter((r): r is Road => r !== null)
  // spokes are seeded first (nothing later can kill them), each heading straight out from its arcology;
  // a half ring is open, so its two ends are seeded too (seedsAlong skips them)
  const spokeSeeds = arcologies.flatMap((a, i) => {
    const ring = ringsOrNull[i]
    if (!ring) {
      // boulevard: one seed beside the plaza, heading tangentially; embedded: nothing
      if (a.access !== 'boulevard') return []
      const t = a.angle + (a.side ?? 0), r = a.radius + 60
      return crossing(field, [{ at: { x: a.center.x + r * Math.cos(t), y: a.center.y + r * Math.sin(t) }, dir: { x: -Math.sin(t), y: Math.cos(t) } }])
    }
    const ends = a.access === 'half' ? [{ at: ring.points[0] }, { at: ring.points.at(-1)! }] : []
    return [...ends, ...seedsAlong(ring.points, RING_SEED_M, false)].map((x) => {
      const dx = x.at.x - a.center.x, dy = x.at.y - a.center.y, len = Math.hypot(dx, dy) || 1
      // major axis: the radial basis is the field's major there; sampled ON the ring (d ~ R) its weight is 0 and `crossing` would pick the grid's axis
      return { ...x, dir: { x: dx / len, y: dy / len }, axis: 'major' as const }
    })
  })
  // ponytail: a square ring's inner corners lie outside its octagonal plaza, so the whole ring (shrunk 5 %, so spokes can start on it) is the obstacle there
  const plazas = arcologies.map((a, i) => (a.ringShape === 'square' && a.access === 'ring'
    ? ringsOrNull[i]!.points.map((p) => ({ x: a.center.x + 0.95 * (p.x - a.center.x), y: a.center.y + 0.95 * (p.y - a.center.y) })) : a.plaza))
  const cores = megablocks.map((k) => k.core)

  let index = new RoadIndex(200)
  if (highway) index.add(highway.id, highway.points, 'highway')
  ringRoads.forEach((r) => index.add(r.id, r.points, r.class))

  const arterialRng = mulberry32(hashSeed(params.seed, 'arterials'))
  const MAJOR_OPTS = { ...MAJOR, obstacles: plazas }
  const arterialsRaw = traceLayer(
    field, 'major',
    [
      ...spokeSeeds,
      ...(highway ? crossing(field, seedsAlong(highway.points, 400, false)) : []),
      ...riverCrossingSeeds(terrain, arterialRng),
      ...poissonSeeds(sizeM, 400, arterialRng, (p: Pt) => !inWater(terrain, p) && !pointInRings(p, plazas)),
    ],
    terrain, sizeM, index, MAJOR_OPTS, arterialRng, irregularityAt, 'A', 'arterial',
  )
  // cross arterials on the minor axis, seeded from the major-axis ones — without
  // this pass a flat inland grid gets only parallel arterials that never meet
  // (they stop on rule 4 instead of snapping onto a crossing road)
  const crossRaw = traceLayer(
    field, 'minor', finalize(arterialsRaw, terrain, index, ARTERIAL_STUB_M).flatMap((a) => crossing(field, seedsAlong(a.points, 400, true))),
    terrain, sizeM, index, MAJOR_OPTS, mulberry32(hashSeed(params.seed, 'arterials-2')), irregularityAt, 'B', 'arterial',
  )
  // truncate before seeding so S/L seeds come from the final arterials
  let arterials = [...ringRoads, ...dropHairpins(finalize([...arterialsRaw, ...crossRaw], terrain, index, ARTERIAL_STUB_M), ringsOrNull, arcologies)]
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
    field, 'minor', queue, terrain, sizeM, index, { ...MINOR, obstacles: [...plazas, ...cores] }, mulberry32(hashSeed(params.seed, 'streets')), irregularityAt, 'S', 'street', decayEnds,
    (r) => crossing(field, seedsAlong(r.points, 100, true)),
  )
  const streets = dryStreetPieces(finalize(raw, terrain, index), terrain)
  // streets may keep genuine decay cul-de-sacs; every other dangling end is pruned (the highway never anchors a street)
  const all = indexOf([...arterials, ...streets])
  const pruned = pruneDangling(streets, all, terrain, sizeM, { accept: (c) => c !== 'highway', interiorOnly: true, minLength: 60, keep: new Set(decayEnds.map(endKey)),
    waterAnchor: streetWaterAnchor(terrain, sizeM),
  })
  return {
    highway: highway && simplify(highway),
    arterials,
    ringRoads,
    arcologies,
    megablocks,
    streets: pruned,
  }
}
