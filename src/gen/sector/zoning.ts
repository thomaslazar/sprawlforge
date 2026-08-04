import type { Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { District, SectorParams, TerrainKind, ZoneType } from '../types'
import { resolveTerrainKind } from './geography'

const COASTAL_KINDS: readonly TerrainKind[] = ['coastal', 'bay', 'estuary', 'island']
// interim gate; Task 8 replaces this with real shore detection
function coastal(params: SectorParams): boolean {
  return COASTAL_KINDS.includes(resolveTerrainKind(params))
}

export function zoneWeights(params: SectorParams): Record<ZoneType, number> {
  const c = params.corpDominance
  return {
    corp: 0.5 + 3 * c,
    residential: 3 - 1.5 * c,
    slum: 2.5 - 2 * c,
    industrial: 1.5,
    entertainment: 1,
    docks: coastal(params) ? 1.5 : 0,
  }
}

export function assignZones(districtRects: Rect[], params: SectorParams): District[] {
  const rng = mulberry32(hashSeed(params.seed, 'zones'))
  const weights = Object.entries(zoneWeights(params)) as Array<[ZoneType, number]>
  const sorted = [...districtRects].sort((a, b) => a.y - b.y || a.x - b.x)
  return sorted.map((bounds, i) => ({
    id: `D${String(i + 1).padStart(2, '0')}`,
    zone: rng.weighted(weights),
    name: '',
    bounds,
  }))
}
