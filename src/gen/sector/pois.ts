import type { Pt } from '../geometry'
import type { FlavorPack } from '../names/names'
import { generateName } from '../names/names'
import { hashSeed, mulberry32 } from '../rng'
import type { Building, District, Poi, SectorParams } from '../types'

// rect center can land in water for a shore-clipped footprint (the rect is
// the pre-clip bounding box); the footprint centroid always sits on the
// actual (clipped) shape, so anchor there instead. The plain vertex mean
// isn't that centroid — a shore clip can leave an L- or wedge-shaped
// (concave) footprint whose vertex-mean sits outside the shape entirely
// (e.g. in the water it was clipped away from). The shoelace-weighted
// polygon centroid always lands inside a simple polygon, concave or not.
function footprintCentroid(pts: Pt[]): Pt {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const cross = a.x * b.y - b.x * a.y
    area += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  // degenerate (zero-area) footprint — fall back to the vertex mean
  if (Math.abs(area) < 1e-9) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}

export function placePois(
  districts: District[],
  buildings: Building[],
  pack: FlavorPack,
  params: SectorParams,
): Poi[] {
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
        at: footprintCentroid(building.footprint),
      })
    }
  }
  return pois
}
