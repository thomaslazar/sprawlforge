import { bspSplit, type Cut, type Pt, type Rect } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import type { Road, SectorParams, Terrain } from '../types'
import {
  clipRoadsToLand,
  planBridges,
  splitHostAtBridges,
  truncateOverSpanRoads,
  truncateUnlandableRoads,
} from './bridges'

// tolerance on the endpoint-to-highway-edge distance (float slop from BSP
// recursion, not a real search radius)
const OVERPASS_EDGE_TOL = 3
// how far apart (perpendicular to the highway) two facing endpoints may sit
// and still count as "facing" — genre-accurate highways have limited,
// roughly-aligned exits, not any two arterials on either side
const OVERPASS_PERP_TOL = 20

/**
 * Arterials dead-end on both sides of the highway strip (bspSplit lays out
 * each side's district grid independently) — that makes the highway an
 * uncrossable wall. Where a road on the left touches the strip's left edge
 * and a road on the right touches the right edge at roughly the same
 * position, merge them into one continuous arterial across the gap. These
 * are plain road continuity, not bridges — no deck, and highways keep their
 * "limited exits" feel since only arterials (not streets) get joined.
 */
function joinArterialsAcrossHighway(roads: Road[]): Road[] {
  const highways = roads.filter((r) => r.class === 'highway')
  if (highways.length === 0) return roads
  const merged = new Set<Road>()
  const replaced: Road[] = []
  const endInfo = (r: Road, x: number): { at: Pt; other: Pt } | null => {
    const [a, b] = r.points
    if (Math.abs(a.y - b.y) > 1) return null // only a horizontal road can face a vertical highway
    if (Math.abs(a.x - x) <= OVERPASS_EDGE_TOL) return { at: a, other: b }
    if (Math.abs(b.x - x) <= OVERPASS_EDGE_TOL) return { at: b, other: a }
    return null
  }
  // connectors are their own 2-point roads — every water-clipping/truncation
  // function assumes roads are straight 2-point segments, and merged 4-point
  // polylines slipped through unclipped (rendered as diagonal roads crossing
  // water). The originals stay untouched; only the short gap segment is new.
  let n = 0
  for (const hw of highways) {
    const hx = hw.points[0].x
    const halfW = hw.width / 2
    const arterials = roads.filter((r) => r.class === 'arterial' && !merged.has(r))
    for (const l of arterials) {
      if (merged.has(l)) continue
      const lHit = endInfo(l, hx - halfW)
      if (!lHit) continue
      for (const r of arterials) {
        if (r === l || merged.has(r)) continue
        const rHit = endInfo(r, hx + halfW)
        if (!rHit || Math.abs(lHit.at.y - rHit.at.y) > OVERPASS_PERP_TOL) continue
        merged.add(l)
        merged.add(r)
        n += 1
        replaced.push({
          ...l,
          id: `OP${String(n).padStart(2, '0')}`,
          points: [lHit.at, rHit.at],
          name: null,
        })
        break
      }
    }
  }
  return [...roads, ...replaced]
}

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
// into before roads, blocks and buildings each clip to the actual waterline.
function landSlabs(terrain: Terrain): Rect[] {
  const rings = terrain.land.flat()
  // no land at all (window entirely underwater) — nothing to lay roads on
  if (rings.length === 0) return []
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
  // no longer needed now that landSlabs reads bounds straight off
  // terrain.land, but kept in the public signature — callers pass it
  // positionally and future waterline-aware slab logic will want it back
  void sizeM
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []

  const slabs = splitByHighway(landSlabs(terrain), params, rng, roads)

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

  const overpassed = joinArterialsAcrossHighway(roads)

  const grounded = clipRoadsToLand(overpassed, terrain)
  const spanTruncated = truncateOverSpanRoads(grounded, terrain)
  const truncated = truncateUnlandableRoads(spanTruncated, terrain)
  const bridges = planBridges(truncated, terrain)
  // only the bridge deck may span the water — the host road stops at the banks
  const hostSplit = splitHostAtBridges(truncated, terrain)
  return { roads: [...hostSplit, ...bridges], districtRects, blocksByDistrict }
}
