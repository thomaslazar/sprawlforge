import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { bboxOf, ringArea, type Pt } from '../geometry'
import { corridorPolygon, fromRing, partitionPolygon, toRing } from '../partition/twisted'
import { hashSeed, mulberry32 } from '../rng'
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

/**
 * Domain rings for district partitioning (spec §4.1): outer rings of
 * `union(land, riverCorridor)` — lakes fill in (roads cross them; the
 * polyline pipeline clips/bridges), sea stays out, and the river corridor
 * reconnects the banks so an arterial cut across it becomes a bridge
 * candidate. Rings under MIN_DISTRICT_AREA (tiny islets) get no districts.
 *
 * `terrain.riverSlice.course` is window-clipped with a margin (terrain's
 * RIVER_MARGIN), so the reconnect corridor can poke outside the sector
 * window — intersect with the [0,sizeM]² window ring before anything else
 * (outer-ring extraction, area filter, sort) so partitioning never sees
 * domain area beyond the map frame.
 */
export function districtDomains(terrain: Terrain, sizeM: number): Pt[][] {
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
  const window: [number, number][] = [[0, 0], [sizeM, 0], [sizeM, sizeM], [0, sizeM]]
  const clipped = polygonClipping.intersection(domain, [[window]])
  return clipped
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
  sizeM: number,
): { roads: Road[]; districtPolys: Pt[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []
  let domains = districtDomains(terrain, sizeM)

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
