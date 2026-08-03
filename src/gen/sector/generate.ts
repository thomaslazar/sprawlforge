import { generateName } from '../names/names'
import { getPack } from '../names/packs'
import { hashSeed, mulberry32 } from '../rng'
import { GENERATOR_VERSION, type SectorModel, type SectorParams } from '../types'
import { fillBuildings } from './buildings'
import { genGeography } from './geography'
import { placePois } from './pois'
import { layoutRoads } from './roads'
import { assignZones } from './zoning'

export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const water = genGeography(params, sizeM)
  const { roads, districtRects, blocksByDistrict } = layoutRoads(params, water, sizeM)
  const districts = assignZones(districtRects, params)

  // re-align blocksByDistrict to the sorted district order
  const rectKey = (r: { x: number; y: number }) => `${r.x}:${r.y}`
  const blockIndex = new Map(districtRects.map((r, i) => [rectKey(r), i]))
  const alignedBlocks = districts.map((d) => blocksByDistrict[blockIndex.get(rectKey(d.bounds))!])

  const nameRng = mulberry32(hashSeed(params.seed, 'names'))
  const namedDistricts = districts.map((d) => ({
    ...d,
    name: generateName(nameRng.pick(pack.districtPatterns), pack.tables, nameRng),
  }))
  const namedRoads = roads.map((r) =>
    r.class === 'street'
      ? r
      : { ...r, name: generateName(nameRng.pick(pack.streetPatterns), pack.tables, nameRng) },
  )

  const { blocks, buildings } = fillBuildings(namedDistricts, alignedBlocks, params)
  const pois = placePois(namedDistricts, buildings, pack, params)

  return {
    meta: { seed: params.seed, generatorVersion: GENERATOR_VERSION, params, sizeM },
    water,
    roads: namedRoads,
    districts: namedDistricts,
    blocks,
    buildings,
    pois,
  }
}
