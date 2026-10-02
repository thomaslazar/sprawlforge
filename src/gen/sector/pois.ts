import { pointInRings, ringCentroid } from '../geometry'
import type { FlavorPack } from '../names/names'
import { generateName } from '../names/names'
import { hashSeed, mulberry32 } from '../rng'
import type { Arcology, Building, District, Megablock, Poi, SectorParams } from '../types'

export function placePois(
  districts: District[],
  buildings: Building[],
  pack: FlavorPack,
  params: SectorParams,
  landmarks: { arcologies: Arcology[]; megablocks: Megablock[] } = { arcologies: [], megablocks: [] },
): Poi[] {
  const rng = mulberry32(hashSeed(params.seed, 'pois'))
  const pois: Poi[] = []
  let n = 0
  const id = () => `P${String(++n).padStart(2, '0')}`

  // landmarks first: one POI each at its centre, independent of the lottery
  for (const [type, list] of [['arcology', landmarks.arcologies], ['megablock', landmarks.megablocks]] as const) {
    for (const l of list) {
      const d = districts.find((x) => pointInRings(l.center, [x.poly]))
      pois.push({ id: id(), buildingId: '', districtId: d?.id ?? '', type, name: l.name, at: l.center })
    }
  }

  // poiDensity <= 0 disables the lottery — the per-district count formula
  // floors at 1, so it can't express "none" on its own; defensive guard, not
  // currently reachable via any tag (poi visibility is a display-only toggle)
  if (params.poiDensity <= 0) return pois
  const plazas = landmarks.arcologies.map((a) => a.plaza)

  for (const district of districts) {
    const candidates = buildings.filter((b) => b.districtId === district.id
      && !plazas.some((p) => pointInRings(ringCentroid(b.footprint), [p])))
    const types = pack.poiTypes.filter((t) => t.zones.includes(district.zone) && t.type !== 'arcology' && t.type !== 'megablock')
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
      pois.push({
        id: id(),
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
