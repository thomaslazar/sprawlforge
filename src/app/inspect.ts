import { bboxOf, pointInRings, type Pt } from '../gen/geometry'
import type { Block, Building, District, Lot, SectorModel } from '../gen/types'

export interface Pick { building?: Building; lot?: Lot; block?: Block; district?: District }

const hit = (poly: Pt[], p: Pt) => {
  const b = bboxOf(poly)
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h && pointInRings(p, [poly])
}

/** what is at map point p (metres): building > lot > block, with its district; null off every block */
export function describeAt(model: SectorModel, p: Pt): Pick | null {
  // ponytail: linear scans (a few thousand polys per click); index if it ever lags
  const building = model.buildings.find((b) => hit(b.footprint, p))
  const lot = building ? model.lots.find((l) => l.id === building.lotId) : model.lots.find((l) => hit(l.poly, p))
  const block = model.blocks.find((b) => b.id === (building?.blockId ?? lot?.blockId)) ?? model.blocks.find((b) => hit(b.footprint, p))
  if (!building && !lot && !block) return null
  const dId = building?.districtId ?? block?.districtId
  const district = model.districts.find((d) => d.id === dId) ?? model.districts.find((d) => hit(d.poly, p))
  return { building, lot, block, district }
}
