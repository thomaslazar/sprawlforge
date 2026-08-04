import { hashSeed, mulberry32 } from '../rng'
import { TERRAIN_KINDS, type SectorParams, type Terrain, type TerrainKind } from '../types'
import { contourWater } from './contour'
import { sectorWindow } from './field'
import { makeTerrainField } from './rivers'

export function resolveTerrainKind(params: SectorParams): TerrainKind {
  if (params.terrain !== 'auto') return params.terrain
  return mulberry32(hashSeed(params.seed, 'terrain-kind')).pick(TERRAIN_KINDS)
}

const GRID_N = 128
const RIVER_MARGIN = 500

export function sampleTerrain(params: SectorParams, sizeM: number): Terrain {
  const metroSeed = hashSeed(params.seed, 'metro-ctx')
  const kind = resolveTerrainKind(params)
  const field = makeTerrainField(metroSeed, kind, sizeM)
  const win = sectorWindow(sizeM, kind, metroSeed)
  const { water, land } = contourWater(field.height, win, GRID_N)

  let river: Terrain['river'] = null
  if (field.river) {
    const local = field.river.course
      .map((p) => ({ x: p.x - win.x, y: p.y - win.y }))
      .filter(
        (p) =>
          p.x > -RIVER_MARGIN && p.x < sizeM + RIVER_MARGIN &&
          p.y > -RIVER_MARGIN && p.y < sizeM + RIVER_MARGIN,
      )
    if (local.length >= 2)
      river = { course: local, width: (field.river.widthStart + field.river.widthEnd) / 2 }
  }

  return { kind, metroSeed, water, land, river }
}
