import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { bboxOf, pointInRings, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { inWater } from '../sector/bridges'
import type { Block, Building, District, SectorParams, Terrain, ZoneType } from '../types'

export const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }> = {
  corp: { minCell: 60, fill: 0.7 },
  residential: { minCell: 30, fill: 0.85 },
  slum: { minCell: 18, fill: 0.95 },
  industrial: { minCell: 80, fill: 0.8 },
  entertainment: { minCell: 35, fill: 0.85 },
  docks: { minCell: 70, fill: 0.75 },
}

const SIDEWALK = 6
const MIN_BLOCK_AREA = 500
const MIN_BUILDING_AREA = 40

const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])

/** largest-by-area outer ring of a clip result, or null if empty */
function largestRing(result: MultiPolygon): Pt[] | null {
  let best: Pt[] | null = null
  let bestArea = 0
  for (const poly of result) {
    for (const r of poly) {
      const pts = r.map(([x, y]) => ({ x, y }))
      const area = Math.abs(ringArea(pts))
      if (area > bestArea) { bestArea = area; best = pts }
    }
  }
  return best
}

// polygon-clipping can throw "Unable to complete output ring" on simple but
// numerically hard input (near-tangential crossings). Same workaround as
// sector/buildings.ts: nudge the lot by a tiny epsilon and retry; if every
// attempt throws, drop the lot rather than crash the sector.
// ponytail: a dropped lot is silent; finer epsilon ladder if it ever shows.
const CLIP_NUDGES = [0, 1e-6, -1e-6, 3e-6]

function safeClip(lot: Pt[], run: (ring: [number, number][]) => MultiPolygon): MultiPolygon {
  for (const eps of CLIP_NUDGES) {
    try {
      return run(toRing(lot).map(([x, y]) => [x + eps, y + eps] as [number, number]))
    } catch {
      continue
    }
  }
  return []
}

/** true when every consecutive edge turn has the same sign (zero turns ignored) */
function isConvex(ring: Pt[]): boolean {
  let pos = false
  let neg = false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const c = ring[(i + 2) % ring.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross > 1e-9) pos = true
    else if (cross < -1e-9) neg = true
  }
  return !(pos && neg)
}

/** angle of a polygon's longest edge — the lot grid inherits this orientation */
function longestEdgeAngle(poly: Pt[]): number {
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

/** intersection of two lines given as point + direction; NaN point if parallel */
function lineIntersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt {
  const denom = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(denom) < 1e-9) return { x: NaN, y: NaN }
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t }
}

/**
 * Edge-offset inset: push every edge inward by `d`, then re-intersect each
 * pair of consecutive offset lines for the new vertices. Works for either
 * ring winding (checks `ringArea`'s sign to pick the interior-facing side).
 * ponytail: no miter limit, so a very acute corner can spike far past `d` or
 * flip past the ring's center — caught below (NaN / area flip) and treated
 * as "no usable inset" rather than emitting a spike; switch to
 * polygon-clipping's own offset if the streets toy shows spikes in practice.
 */
export function insetRing(ring: Pt[], d: number): Pt[] | null {
  const n = ring.length
  if (n < 3) return null
  const area = ringArea(ring)
  if (area === 0) return null
  const sign = area > 0 ? 1 : -1

  const lines: Array<{ p: Pt; dir: Pt }> = []
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    // inward normal: rotate the edge direction 90°, sign picks the side
    // facing the ring's interior for either winding order
    const nx = -dir.y * sign
    const ny = dir.x * sign
    lines.push({ p: { x: a.x + nx * d, y: a.y + ny * d }, dir })
  }

  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n]
    const cur = lines[i]
    const v = lineIntersect(prev.p, prev.dir, cur.p, cur.dir)
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null
    out.push(v)
  }
  if (out.length < 3) return null

  const outArea = ringArea(out)
  if (Math.abs(outArea) < 1e-6) return null
  if (Math.sign(outArea) !== sign) return null
  return out
}

/**
 * Fill each block's buildable inset with a rotated grid of lots. A lot fully
 * inside a convex inset and outside every no-build ring is kept as-is; a
 * straddling lot is clipped to the inset (and, if any no-build rings exist,
 * to their complement) and kept only if what's left is >= 40 m².
 */
export function fillLots(
  districts: District[],
  blocks: Block[],
  params: SectorParams,
  terrain: Terrain,
  noBuild: Pt[][],
): Building[] {
  const rng = mulberry32(hashSeed(params.seed, 'buildings'))
  const districtById = new Map(districts.map((d) => [d.id, d]))
  const noBuildPolys = noBuild.map((nb) => [toRing(nb)])
  const buildings: Building[] = []
  let n = 0

  for (const block of blocks) {
    const district = districtById.get(block.districtId)
    if (!district) continue
    const inset = insetRing(block.footprint, SIDEWALK)
    if (!inset || Math.abs(ringArea(inset)) < MIN_BLOCK_AREA) continue

    // corner tests miss a notch narrower than a lot, so only a convex inset
    // may skip clipping
    const convex = isConvex(inset)
    const profile = ZONE_BUILD[district.zone]
    const theta = longestEdgeAngle(block.footprint)
    const c = ringCentroid(inset)
    const local = inset.map((p) => rotatePt(p, -theta, c))
    const bbox = bboxOf(local)
    const cell = profile.minCell
    const cols = Math.max(1, Math.ceil(bbox.w / cell))
    const rows = Math.max(1, Math.ceil(bbox.h / cell))

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!rng.chance(profile.fill)) continue
        const lx = bbox.x + col * cell
        const ly = bbox.y + row * cell
        const corners: Pt[] = [
          { x: lx, y: ly }, { x: lx + cell, y: ly },
          { x: lx + cell, y: ly + cell }, { x: lx, y: ly + cell },
        ]
        const lot = corners.map((p) => rotatePt(p, theta, c))

        const allInside = convex && lot.every((p) =>
          pointInRings(p, [inset]) && noBuild.every((nb) => !pointInRings(p, [nb])))

        let pts: Pt[] | null
        if (allInside) {
          pts = lot
        } else {
          pts = largestRing(safeClip(lot, (ring) => {
            const clipped = polygonClipping.intersection([ring], [toRing(inset)])
            return noBuildPolys.length > 0 ? polygonClipping.difference(clipped, ...noBuildPolys) : clipped
          }))
        }
        if (!pts || Math.abs(ringArea(pts)) < MIN_BUILDING_AREA) continue
        if (inWater(terrain, ringCentroid(pts))) continue

        n += 1
        buildings.push({
          id: `BLD${String(n).padStart(4, '0')}`,
          blockId: block.id,
          districtId: district.id,
          footprint: pts,
        })
      }
    }
  }

  return buildings
}
