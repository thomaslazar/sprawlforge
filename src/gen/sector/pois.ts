import type { Pt } from '../geometry'
import { ringCentroid } from '../geometry'
import type { FlavorPack } from '../names/names'
import { generateName } from '../names/names'
import { hashSeed, mulberry32 } from '../rng'
import type { Building, District, Poi, SectorParams } from '../types'

export function placePois(
  districts: District[],
  buildings: Building[],
  pack: FlavorPack,
  params: SectorParams,
): Poi[] {
  // poiDensity <= 0 disables POIs entirely — the per-district count formula
  // floors at 1, so it can't express "none" on its own (no-pois tag)
  if (params.poiDensity <= 0) return []
  const rng = mulberry32(hashSeed(params.seed, 'pois'))
  const pois: Poi[] = []
  let n = 0

  for (const district of districts) {
    const candidates = buildings.filter((b) => b.districtId === district.id)
    const types = pack.poiTypes.filter((t) => t.zones.includes(district.zone))
    if (types.length === 0 || candidates.length === 0) continue
    const count = Math.min(
      candidates.length,
      Math.max(1, Math.round(candidates.length * 0.06 * params.poiDensity * 2)),
    )
    // draw without replacement
    const pool = [...candidates]
    for (let i = 0; i < count; i++) {
      const idx = rng.int(0, pool.length - 1)
      const building = pool.splice(idx, 1)[0]
      const typeDef = rng.pick(types)
      n += 1
      pois.push({
        id: `P${String(n).padStart(2, '0')}`,
        buildingId: building.id,
        districtId: district.id,
        type: typeDef.type,
        name: generateName(rng.pick(typeDef.namePatterns), pack.tables, rng),
        at: ringCentroid(building.footprint),
      })
    }
  }
  return pois
}
