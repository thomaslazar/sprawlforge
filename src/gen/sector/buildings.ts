import { bspSplit, insetRect, type Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { Block, Building, District, SectorParams, ZoneType } from '../types'

const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }> = {
  corp: { minCell: 60, fill: 0.7 },
  residential: { minCell: 30, fill: 0.85 },
  slum: { minCell: 18, fill: 0.95 },
  industrial: { minCell: 80, fill: 0.8 },
  entertainment: { minCell: 35, fill: 0.85 },
  docks: { minCell: 70, fill: 0.75 },
}

const SIDEWALK = 6

export function fillBuildings(
  districts: District[],
  blocksByDistrict: Rect[][],
  params: SectorParams,
): { blocks: Block[]; buildings: Building[] } {
  const rng = mulberry32(hashSeed(params.seed, 'buildings'))
  const blocks: Block[] = []
  const buildings: Building[] = []

  districts.forEach((district, di) => {
    const profile = ZONE_BUILD[district.zone]
    const fill = profile.fill * (0.6 + 0.4 * params.density)
    const dd = String(di + 1).padStart(2, '0')

    ;(blocksByDistrict[di] ?? []).forEach((blockRect, bi) => {
      const blockId = `B${dd}${String(bi + 1).padStart(2, '0')}`
      blocks.push({ id: blockId, districtId: district.id, rect: blockRect })

      const lot = insetRect(blockRect, SIDEWALK)
      if (!lot) return
      const { cells } = bspSplit(lot, { minCell: profile.minCell, gap: 3, jitter: 0.25, rng })
      let n = 0
      for (const cell of cells) {
        if (!rng.chance(fill)) continue
        n += 1
        buildings.push({
          id: `BLD${dd}${String(bi + 1).padStart(2, '0')}${String(n).padStart(2, '0')}`,
          blockId,
          districtId: district.id,
          rect: cell,
        })
      }
    })
  })

  return { blocks, buildings }
}
