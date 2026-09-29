import { pointInRings, ringArea, ringCentroid, type Pt } from '../geometry'
import { generateName } from '../names/names'
import { getPack } from '../names/packs'
import { hashSeed, mulberry32 } from '../rng'
import {
  assignHighwayLevels, buildInterchanges, cutStreetsAtGround, highwayCrossings, noBuildStrips,
} from '../streets/highway'
import {
  buildPlanarGraph, clipFacesToLand, facesOf, mergeSlivers, pruneDanglers, windowRing,
} from '../streets/graph'
import { fillLots } from '../streets/lots'
import { sampleTerrain } from '../terrain'
import { GENERATOR_VERSION, type Block, type District, type Road, type SectorModel, type SectorParams, type Terrain } from '../types'
import { placePiers } from './piers'
import { placePois } from './pois'
import { markWetSpans, truncateUnlandableRoads } from './bridges'
import { traceRoads } from './streets'
import { assignZones } from './zoning'

/**
 * Districts whose blocks all drowned to waterline clipping have nothing to
 * anchor a label to — drop them (ids simply gap; they're identifiers, not
 * indices — nothing downstream indexes by array position). Survivors get
 * labelAt: the area-weighted centroid of their surviving blocks, so the
 * label sits over land even when the district's bounds rect is mostly sea.
 */
export function deriveDistricts(districts: District[], blocks: Block[]): District[] {
  return districts.flatMap((d) => {
    const dBlocks = blocks.filter((b) => b.districtId === d.id)
    if (dBlocks.length === 0) return []
    let sx = 0, sy = 0, sArea = 0
    for (const b of dBlocks) {
      const area = Math.abs(ringArea(b.footprint))
      const c = ringCentroid(b.footprint)
      sx += c.x * area
      sy += c.y * area
      sArea += area
    }
    return [{ ...d, labelAt: { x: sx / sArea, y: sy / sArea } }]
  })
}

type Face = { poly: Pt[]; footprint: Pt[] }

/** roads → cleaned faces clipped to land (dangling stubs pruned, slivers merged) */
function facesFor(roads: Road[], boundaries: Pt[][], terrain: Terrain): Face[] {
  const g = pruneDanglers(buildPlanarGraph(roads, boundaries))
  return clipFacesToLand(mergeSlivers(facesOf(g)), terrain).map((f) => ({ poly: open(f.poly), footprint: open(f.footprint) }))
}

/** polygon-clipping closes its rings; the model's rings are open (no repeated first point) */
function open(ring: Pt[]): Pt[] {
  const a = ring[0]
  const b = ring[ring.length - 1]
  return ring.length > 3 && a.x === b.x && a.y === b.y ? ring.slice(0, -1) : ring
}

const centroidDist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** block -> district by centroid containment, else nearest district centroid */
function toBlocks(faces: Face[], districts: District[]): Block[] {
  const centers = districts.map((d) => ringCentroid(d.poly))
  const perDistrict = new Map<string, number>()
  return faces.map((f) => {
    const c = ringCentroid(f.poly)
    let di = districts.findIndex((d) => pointInRings(c, [d.poly]))
    if (di < 0) {
      di = 0
      centers.forEach((dc, k) => { if (centroidDist(c, dc) < centroidDist(c, centers[di])) di = k })
    }
    const districtId = districts[di].id
    const n = (perDistrict.get(districtId) ?? 0) + 1
    perDistrict.set(districtId, n)
    return { id: `B${districtId.slice(1)}${String(n).padStart(2, '0')}`, districtId, poly: f.poly, footprint: f.footprint, flags: {} }
  })
}

export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const terrain = sampleTerrain(params, sizeM)
  const { highway, arterials, streets } = traceRoads(params, terrain, sizeM)
  const boundaries = [windowRing(sizeM), ...terrain.land.map((poly) => poly[0].map(([x, y]) => ({ x, y })))]

  const districtFaces = facesFor([...(highway ? [highway] : []), ...arterials], boundaries, terrain)
  const districts = assignZones(districtFaces.map((f) => f.poly), params, terrain)

  // highway levels decide where streets stop at the ground-level highway
  const levelRng = mulberry32(hashSeed(params.seed, 'highway-levels'))
  const segments = highway ? assignHighwayLevels(highway, districts, terrain, levelRng) : []
  const pass1 = highway ? cutStreetsAtGround(streets.pass1, highway, segments) : streets.pass1
  const pass2 = highway ? cutStreetsAtGround(streets.pass2, highway, segments) : streets.pass2
  const minor = [...pass1, ...pass2]
  const crossings = highway ? highwayCrossings(highway, [...arterials, ...minor], segments, levelRng) : []
  const { crossings: finalCrossings, ramps } = highway
    ? buildInterchanges(highway, crossings, arterials, segments, terrain, sizeM)
    : { crossings, ramps: [] as Road[] }
  const hw = highway ? [{ ...highway, segments, crossings: finalCrossings }] : []

  const blocks = toBlocks(facesFor([...hw, ...arterials, ...minor], boundaries, terrain), districts)

  const roads = markWetSpans([...hw, ...truncateUnlandableRoads(arterials, terrain), ...minor, ...ramps], terrain)

  const nameRng = mulberry32(hashSeed(params.seed, 'names'))
  const namedDistricts = districts.map((d) => ({
    ...d,
    name: generateName(nameRng.pick(pack.districtPatterns), pack.tables, nameRng),
  }))
  const namedRoads = roads.map((r) =>
    r.class === 'street' || r.class === 'ramp'
      ? r
      : { ...r, name: generateName(nameRng.pick(pack.streetPatterns), pack.tables, nameRng) },
  )

  const buildings = fillLots(namedDistricts, blocks, params, terrain, highway ? noBuildStrips(highway, segments) : [])
  const finalDistricts = deriveDistricts(namedDistricts, blocks)
  const pois = placePois(finalDistricts, buildings, pack, params)
  const piers = placePiers(finalDistricts, terrain, params)

  return {
    meta: {
      seed: params.seed,
      generatorVersion: GENERATOR_VERSION,
      params,
      sizeM,
      metroSeed: terrain.metroSeed,
    },
    terrain,
    roads: namedRoads,
    districts: finalDistricts,
    blocks,
    buildings,
    pois,
    piers,
  }
}
