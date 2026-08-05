import { generateName } from '../names/names'
import { getPack } from '../names/packs'
import { hashSeed, mulberry32 } from '../rng'
import { sampleTerrain } from '../terrain'
import { GENERATOR_VERSION, type Block, type District, type SectorModel, type SectorParams } from '../types'
import { fillBuildings } from './buildings'
import { placePiers } from './piers'
import { placePois } from './pois'
import { layoutRoads } from './roads'
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
      const area = b.rect.w * b.rect.h
      sx += (b.rect.x + b.rect.w / 2) * area
      sy += (b.rect.y + b.rect.h / 2) * area
      sArea += area
    }
    return [{ ...d, labelAt: { x: sx / sArea, y: sy / sArea } }]
  })
}

export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const terrain = sampleTerrain(params, sizeM)
  const { roads, districtRects, blocksByDistrict } = layoutRoads(params, terrain, sizeM)
  const districts = assignZones(districtRects, params, terrain)

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

  const { blocks, buildings } = fillBuildings(namedDistricts, alignedBlocks, params, terrain)
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
