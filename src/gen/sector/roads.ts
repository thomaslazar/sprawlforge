import { bspSplit, type Cut, type Rect } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import type { Road, SectorParams, Terrain } from '../types'

const HIGHWAY_W = 32
const ARTERIAL_W = 18
const STREET_W = 9

function cutToRoad(cut: Cut, id: string, cls: Road['class'], width: number): Road {
  const s = cut.strip
  const points =
    cut.axis === 'x'
      ? [{ x: s.x + s.w / 2, y: s.y }, { x: s.x + s.w / 2, y: s.y + s.h }]
      : [{ x: s.x, y: s.y + s.h / 2 }, { x: s.x + s.w, y: s.y + s.h / 2 }]
  return { id, class: cls, points, width, name: null }
}

// Bounding box of the land multipolygon — the one slab districts lay out
// into. Precise waterline clipping of streets/blocks/buildings is Task 7+.
function landSlabs(terrain: Terrain, sizeM: number): Rect[] {
  const sector: Rect = { x: 0, y: 0, w: sizeM, h: sizeM }
  const rings = terrain.land.flat()
  if (rings.length === 0) return [sector]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return [{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }]
}

function splitByHighway(slabs: Rect[], params: SectorParams, rng: Rng, roads: Road[]): Rect[] {
  if (params.size < 3) return slabs
  const out: Rect[] = []
  const landW = Math.max(...slabs.map((s) => s.x + s.w))
  const hx = landW * (1 / 3 + rng.next() / 3)
  let n = 0
  for (const slab of slabs) {
    if (hx > slab.x + 200 && hx < slab.x + slab.w - 200) {
      n += 1
      roads.push({
        id: `H${n}`,
        class: 'highway',
        points: [{ x: hx, y: slab.y }, { x: hx, y: slab.y + slab.h }],
        width: HIGHWAY_W,
        name: null,
      })
      out.push({ ...slab, w: hx - HIGHWAY_W / 2 - slab.x })
      out.push({ ...slab, x: hx + HIGHWAY_W / 2, w: slab.x + slab.w - hx - HIGHWAY_W / 2 })
    } else {
      out.push(slab)
    }
  }
  return out
}

export function layoutRoads(
  params: SectorParams,
  terrain: Terrain,
  sizeM: number,
): { roads: Road[]; districtRects: Rect[]; blocksByDistrict: Rect[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []

  const slabs = splitByHighway(landSlabs(terrain, sizeM), params, rng, roads)

  const districtRects: Rect[] = []
  let a = 0
  for (const slab of slabs) {
    const { cells, cuts } = bspSplit(slab, { minCell: 500, gap: ARTERIAL_W, jitter: 0.18, rng })
    for (const cut of cuts) {
      a += 1
      roads.push(cutToRoad(cut, `A${String(a).padStart(2, '0')}`, 'arterial', ARTERIAL_W))
    }
    districtRects.push(...cells)
  }

  const streetCell = 160 - params.density * 70
  const blocksByDistrict: Rect[][] = []
  let s = 0
  for (const district of districtRects) {
    const { cells, cuts } = bspSplit(district, { minCell: streetCell, gap: STREET_W, jitter: 0.2, rng })
    for (const cut of cuts) {
      s += 1
      roads.push(cutToRoad(cut, `S${String(s).padStart(3, '0')}`, 'street', STREET_W))
    }
    blocksByDistrict.push(cells)
  }

  return { roads, districtRects, blocksByDistrict }
}
