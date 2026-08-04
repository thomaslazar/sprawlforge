import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { bspSplit, insetRect, pointInRings, ringArea, type Pt, type Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { Block, Building, District, SectorParams, Terrain, ZoneType } from '../types'

const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }> = {
  corp: { minCell: 60, fill: 0.7 },
  residential: { minCell: 30, fill: 0.85 },
  slum: { minCell: 18, fill: 0.95 },
  industrial: { minCell: 80, fill: 0.8 },
  entertainment: { minCell: 35, fill: 0.85 },
  docks: { minCell: 70, fill: 0.75 },
}

const SIDEWALK = 6
const SHORE_CLEAR = 200
const MIN_BLOCK_AREA = 500
const MIN_BUILDING_AREA = 40

const rectRing = (r: Rect): [number, number][] => [
  [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
]
const rectCorners = (r: Rect): Pt[] => rectRing(r).map(([x, y]) => ({ x, y }))

interface BBox { minX: number; minY: number; maxX: number; maxY: number }

function bboxOfRings(rings: Array<Array<[number, number]>>): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

/** distance (0 if overlapping) from an axis-aligned rect to a bbox */
function rectToBBoxDist(r: Rect, b: BBox): number {
  const dx = Math.max(b.minX - (r.x + r.w), r.x - b.maxX, 0)
  const dy = Math.max(b.minY - (r.y + r.h), r.y - b.maxY, 0)
  return Math.hypot(dx, dy)
}

/** largest-by-|area| outer ring of a rect clipped to land, or null if fully drowned */
function clipToLand(ring: [number, number][], land: MultiPolygon): { pts: Pt[]; area: number } | null {
  const result = polygonClipping.intersection([ring], land)
  let best: Pt[] | null = null
  let bestArea = 0
  for (const poly of result) {
    for (const r of poly) {
      const pts = r.map(([x, y]) => ({ x, y }))
      const area = Math.abs(ringArea(pts))
      if (area > bestArea) { bestArea = area; best = pts }
    }
  }
  return best ? { pts: best, area: bestArea } : null
}

export function fillBuildings(
  districts: District[],
  blocksByDistrict: Rect[][],
  params: SectorParams,
  terrain: Terrain,
): { blocks: Block[]; buildings: Building[] } {
  const rng = mulberry32(hashSeed(params.seed, 'buildings'))
  const blocks: Block[] = []
  const buildings: Building[] = []

  const landRings: Pt[][] = terrain.land.flatMap((poly) =>
    poly.map((ring) => ring.map(([x, y]) => ({ x, y }))),
  )
  const waterBBoxes: BBox[] = terrain.water.map((poly) => bboxOfRings(poly))

  // fast path only pays off away from the shore — clipping is exact but slow
  const footprintOf = (r: Rect): { pts: Pt[]; area: number } | null => {
    const corners = rectCorners(r)
    const farFromWater = waterBBoxes.every((b) => rectToBBoxDist(r, b) > SHORE_CLEAR)
    if (farFromWater && corners.every((p) => pointInRings(p, landRings))) {
      return { pts: corners, area: r.w * r.h }
    }
    return clipToLand(rectRing(r), terrain.land)
  }

  districts.forEach((district, di) => {
    const profile = ZONE_BUILD[district.zone]
    const shoreBonus = district.shore ? 1.15 : 1
    const fill = Math.min(1, profile.fill * (0.6 + 0.4 * params.density) * shoreBonus)
    const dd = district.id.slice(1)

    ;(blocksByDistrict[di] ?? []).forEach((blockRect, bi) => {
      const blockFp = footprintOf(blockRect)
      if (!blockFp || blockFp.area < MIN_BLOCK_AREA) return

      const blockId = `B${dd}${String(bi + 1).padStart(2, '0')}`
      blocks.push({ id: blockId, districtId: district.id, rect: blockRect, footprint: blockFp.pts })

      const lot = insetRect(blockRect, SIDEWALK)
      if (!lot) return
      const { cells } = bspSplit(lot, { minCell: profile.minCell, gap: 3, jitter: 0.25, rng })
      let n = 0
      for (const cell of cells) {
        if (!rng.chance(fill)) continue
        const bldFp = footprintOf(cell)
        if (!bldFp || bldFp.area < MIN_BUILDING_AREA) continue
        n += 1
        buildings.push({
          id: `BLD${dd}${String(bi + 1).padStart(2, '0')}${String(n).padStart(2, '0')}`,
          blockId,
          districtId: district.id,
          rect: cell,
          footprint: bldFp.pts,
        })
      }
    })
  })

  return { blocks, buildings }
}
