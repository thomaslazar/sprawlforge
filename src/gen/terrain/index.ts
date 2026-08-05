import { hashSeed, mulberry32 } from '../rng'
import type { Landform, SectorParams, Terrain } from '../types'
import { contourWater } from './contour'
import { sectorWindow } from './field'
import { makeTerrainField } from './rivers'

interface ResolvedTerrain {
  landform: Landform
  river: boolean
  lakes: boolean
}

// M4/composable-terrain: weighted toward wet landforms — an unweighted pick
// gave 'auto' a 1-in-4 shot at 'inland', which never shows off the
// water/river rendering the tool exists to demo. Explicit staging (any
// landform chosen, or any water toggle set) is always exact — the seeded
// rolls below only fire for a fully-auto request.
export function resolveTerrain(params: SectorParams): ResolvedTerrain {
  const rng = mulberry32(hashSeed(params.seed, 'terrain-kind'))
  if (params.landform !== 'auto') return { landform: params.landform, river: params.river, lakes: params.lakes }
  const landform = rng.weighted<Landform>([
    ['inland', 1.5], ['coastal', 2], ['bay', 1.5], ['island', 1],
  ])
  if (params.river || params.lakes) return { landform, river: params.river, lakes: params.lakes }
  return { landform, river: rng.chance(0.35), lakes: rng.chance(0.25) }
}

const GRID_N = 128
const RIVER_MARGIN = 500

export function sampleTerrain(params: SectorParams, sizeM: number): Terrain {
  const metroSeed = hashSeed(params.seed, 'metro-ctx')
  const { landform, river, lakes } = resolveTerrain(params)
  const water = { river, lakes }
  const field = makeTerrainField(metroSeed, landform, water, sizeM)
  const win = sectorWindow(sizeM, landform, metroSeed)
  const { water: waterPolys, land } = contourWater(field.height, win, GRID_N)

  let riverSlice: Terrain['riverSlice'] = null
  if (field.river) {
    const local = field.river.course
      .map((p) => ({ x: p.x - win.x, y: p.y - win.y }))
      .filter(
        (p) =>
          p.x > -RIVER_MARGIN && p.x < sizeM + RIVER_MARGIN &&
          p.y > -RIVER_MARGIN && p.y < sizeM + RIVER_MARGIN,
      )
    if (local.length >= 2)
      riverSlice = { course: local, width: (field.river.widthStart + field.river.widthEnd) / 2 }
  }

  return { landform, river, lakes, metroSeed, water: waterPolys, land, riverSlice }
}
