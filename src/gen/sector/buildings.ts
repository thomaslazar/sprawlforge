import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import { bboxOf, bspSplit, insetRect, pointInRings, ringArea, ringCentroid, rotatePt, type Pt, type Rect } from '../geometry'
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

const rectCorners = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])

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

/** distance (0 if overlapping) from a rect to a bbox */
function rectToBBoxDist(r: Rect, b: BBox): number {
  const dx = Math.max(b.minX - (r.x + r.w), r.x - b.maxX, 0)
  const dy = Math.max(b.minY - (r.y + r.h), r.y - b.maxY, 0)
  return Math.hypot(dx, dy)
}

/** largest-by-|area| outer ring of a clip result, or null if empty */
function largestRing(result: MultiPolygon): { pts: Pt[]; area: number } | null {
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

// polygon-clipping can throw "Unable to complete output ring" on an input
// that is individually simple (non-self-intersecting) but numerically hard
// — e.g. an edge that crosses the clip ring at a near-tangential angle close
// to one of its vertices. contour.ts hits the same library limit on
// marching-squares output and works around it by nudging the input by a
// tiny fixed epsilon and retrying; block/building footprints here are leaf
// clips with no fallback geometry to fall back to, so on repeated failure
// we treat it as "no footprint" (block/building dropped) rather than
// crashing the whole sector over one coastal edge case.
const INTERSECT_EPSILONS = [1e-6, -1e-6, 3e-6]

function safeIntersection(ring: [number, number][], other: Polygon | MultiPolygon): MultiPolygon {
  try {
    return polygonClipping.intersection([ring], other)
  } catch {
    for (const eps of INTERSECT_EPSILONS) {
      try {
        return polygonClipping.intersection([ring.map(([x, y]) => [x + eps, y + eps] as [number, number])], other)
      } catch {
        continue
      }
    }
    return []
  }
}

/** intersection of one ring against another (single-ring) polygon */
function clipRingToRing(ring: Pt[], other: Pt[]): { pts: Pt[]; area: number } | null {
  return largestRing(safeIntersection(toRing(ring), [toRing(other)]))
}

/** angle of a polygon's longest edge — buildings inherit this orientation */
const longestEdgeAngle = (poly: Pt[]): number => {
  let best = 0
  let angle = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    if (d > best) { best = d; angle = Math.atan2(b.y - a.y, b.x - a.x) }
  }
  return angle
}

export function fillBuildings(
  districts: District[],
  blocksByDistrict: Pt[][][],
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

  // fast path only pays off away from the shore — clipping is exact but slow;
  // buildings always clip against the block footprint (below), so this fast
  // path is block-level only.
  const clipToLand = (ring: Pt[]): { pts: Pt[]; area: number } | null => {
    const bbox = bboxOf(ring)
    const farFromWater = waterBBoxes.every((b) => rectToBBoxDist(bbox, b) > SHORE_CLEAR)
    if (farFromWater && ring.every((p) => pointInRings(p, landRings))) {
      return { pts: ring, area: Math.abs(ringArea(ring)) }
    }
    return largestRing(safeIntersection(toRing(ring), terrain.land))
  }

  districts.forEach((district, di) => {
    const profile = ZONE_BUILD[district.zone]
    const shoreBonus = district.shore ? 1.15 : 1
    const fill = Math.min(1, profile.fill * (0.6 + 0.4 * params.density) * shoreBonus)
    const dd = district.id.slice(1)

    ;(blocksByDistrict[di] ?? []).forEach((poly, bi) => {
      const blockFp = clipToLand(poly)
      if (!blockFp || blockFp.area < MIN_BLOCK_AREA) return

      const blockId = `B${dd}${String(bi + 1).padStart(2, '0')}`
      blocks.push({ id: blockId, districtId: district.id, poly, footprint: blockFp.pts })

      const theta = longestEdgeAngle(poly)
      const c = ringCentroid(poly)
      const local = poly.map((p) => rotatePt(p, -theta, c))
      const lot = insetRect(bboxOf(local), SIDEWALK)
      if (!lot) return
      const { cells } = bspSplit(lot, { minCell: profile.minCell, gap: 3, jitter: 0.25, rng })
      let n = 0
      for (const cell of cells) {
        if (!rng.chance(fill)) continue
        const ring = rectCorners(cell).map((p) => rotatePt(p, theta, c))
        const clipped = clipRingToRing(ring, blockFp.pts)
        if (!clipped || clipped.area < MIN_BUILDING_AREA) continue
        n += 1
        buildings.push({
          id: `BLD${dd}${String(bi + 1).padStart(2, '0')}${String(n).padStart(2, '0')}`,
          blockId,
          districtId: district.id,
          footprint: clipped.pts,
        })
      }
    })
  })

  return { blocks, buildings }
}
