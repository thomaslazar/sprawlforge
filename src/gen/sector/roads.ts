import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { bboxOf, bspSplit, ringArea, type Cut, type Pt, type Rect } from '../geometry'
import { corridorPolygon, fromRing, partitionPolygon, toRing } from '../partition/twisted'
import { hashSeed, mulberry32, type Rng } from '../rng'
import type { District, Road, SectorParams, Terrain } from '../types'
import {
  clipRoadsToLand,
  planBridges,
  splitHostAtBridges,
  truncateOverSpanRoads,
  truncateUnlandableRoads,
} from './bridges'

// islets below this get no district (ROADMAP defers islet settlement)
const MIN_DISTRICT_AREA = 250_000

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
  // polyline cuts are no longer axis-aligned (twisted bisection), so a road
  // "faces" the highway edge if either endpoint of its polyline sits on it —
  // no horizontality check.
  const endInfo = (r: Road, x: number): { at: Pt } | null => {
    const first = r.points[0]
    const last = r.points[r.points.length - 1]
    if (Math.abs(first.x - x) <= OVERPASS_EDGE_TOL) return { at: first }
    if (Math.abs(last.x - x) <= OVERPASS_EDGE_TOL) return { at: last }
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

  return { roads: finalizeRoads(roads, terrain), districtRects, blocksByDistrict }
}

/**
 * Domain rings for district partitioning (spec §4.1): outer rings of
 * `union(land, riverCorridor)` — lakes fill in (roads cross them; the
 * polyline pipeline clips/bridges), sea stays out, and the river corridor
 * reconnects the banks so an arterial cut across it becomes a bridge
 * candidate. Rings under MIN_DISTRICT_AREA (tiny islets) get no districts.
 */
export function districtDomains(terrain: Terrain): Pt[][] {
  const land: MultiPolygon = terrain.land.map((poly) => [poly[0]])
  if (land.length === 0) return []
  const river = terrain.riverSlice
  // ponytail: riverSlice.width is a metro-wide constant, but the actually
  // carved channel can run several times wider locally (envelope taper ×
  // multiplier × near-sea-level spread) — a tight ×2 corridor can miss one
  // bank and leave the domain split with no arterial crossing. ×6 is
  // generous on purpose: over-coverage here is harmless (only feeds the
  // union; near-bank fabric still clips to land downstream). Pass a
  // locally-sampled carve width instead if river-heavy maps ever show
  // disconnected banks.
  const domain = river
    ? polygonClipping.union(land, [[toRing(corridorPolygon(river.course, river.width * 6))]])
    : polygonClipping.union(land)
  return domain
    .map((p) => fromRing(p[0]))
    .filter((r) => Math.abs(ringArea(r)) >= MIN_DISTRICT_AREA)
    .sort((a, b) => bboxOf(a).y - bboxOf(b).y || bboxOf(a).x - bboxOf(b).x)
}

/**
 * Highway corridor split (planned infrastructure, spec §4.1) plus arterial
 * twisted-bisection cuts (spec §4.2) — domain polygons in, district polygons
 * and their bounding roads out.
 */
export function partitionDistricts(
  params: SectorParams,
  terrain: Terrain,
): { roads: Road[]; districtPolys: Pt[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []
  let domains = districtDomains(terrain)

  // highway: straight vertical corridor, planned infrastructure (spec §4.1)
  if (params.size >= 3 && domains.length > 0) {
    const maxX = Math.max(...domains.flat().map((p) => p.x))
    const hx = maxX * (1 / 3 + rng.next() / 3)
    const next: Pt[][] = []
    let n = 0
    for (const domain of domains) {
      const bb = bboxOf(domain)
      if (hx > bb.x + 200 && hx < bb.x + bb.w - 200) {
        n += 1
        roads.push({
          id: `H${n}`, class: 'highway', width: HIGHWAY_W, name: null,
          points: [{ x: hx, y: bb.y }, { x: hx, y: bb.y + bb.h }],
        })
        const corridor = corridorPolygon(
          [{ x: hx, y: bb.y - HIGHWAY_W }, { x: hx, y: bb.y + bb.h + HIGHWAY_W }], HIGHWAY_W)
        const pieces = polygonClipping.difference([toRing(domain)], [toRing(corridor)])
        next.push(...pieces.map((p) => fromRing(p[0])).filter((r) => Math.abs(ringArea(r)) >= MIN_DISTRICT_AREA))
      } else {
        next.push(domain)
      }
    }
    domains = next
  }

  // arterials bend gently — planned infrastructure keeps a low ceiling (spec §4.2)
  const arterialIrr = 0.1 + 0.25 * params.irregularity
  const districtPolys: Pt[][] = []
  let a = 0
  for (const domain of domains) {
    const { cells, cuts } = partitionPolygon(domain, {
      minCell: 500, gap: ARTERIAL_W, irregularity: arterialIrr, rng,
    })
    for (const cut of cuts) {
      a += 1
      roads.push({ id: `A${String(a).padStart(2, '0')}`, class: 'arterial',
        points: cut.points, width: ARTERIAL_W, name: null })
    }
    districtPolys.push(...cells)
  }
  return { roads, districtPolys }
}

/** Street-level twisted bisection, per district, each at its own irregularity. */
export function layoutStreets(
  districts: District[],
  params: SectorParams,
): { streets: Road[]; blocksByDistrict: Pt[][][] } {
  const rng = mulberry32(hashSeed(params.seed, 'streets'))
  const streetCell = 160 - params.density * 70
  const streets: Road[] = []
  const blocksByDistrict: Pt[][][] = []
  let s = 0
  for (const district of districts) {
    const { cells, cuts } = partitionPolygon(district.poly, {
      minCell: streetCell, gap: STREET_W, irregularity: district.irregularity, rng,
    })
    for (const cut of cuts) {
      s += 1
      streets.push({ id: `S${String(s).padStart(3, '0')}`, class: 'street',
        points: cut.points, width: STREET_W, name: null })
    }
    blocksByDistrict.push(cells)
  }
  return { streets, blocksByDistrict }
}

/** Overpass join + clip/truncate/bridge chain shared by every road-layout path. */
export function finalizeRoads(roads: Road[], terrain: Terrain): Road[] {
  const overpassed = joinArterialsAcrossHighway(roads)
  const grounded = clipRoadsToLand(overpassed, terrain)
  const spanTruncated = truncateOverSpanRoads(grounded, terrain)
  const truncated = truncateUnlandableRoads(spanTruncated, terrain)
  const bridges = planBridges(truncated, terrain)
  // only the bridge deck may span the water — the host road stops at the banks
  const hostSplit = splitHostAtBridges(truncated, terrain)
  return [...hostSplit, ...bridges]
}
