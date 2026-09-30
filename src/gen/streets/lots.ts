import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { BOX_MARGIN, boxOf, bboxOf, bspSplit, makeNearTieCheck, pointInRings, segTouchesBox, simplifyPolyline, type Box, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
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
// the old sector building filler: nudge the lot by a tiny epsilon and retry; if every
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

/** Sutherland-Hodgman: convex `poly` clipped to the inside of edge a-b of a ring of the given winding */
function halfPlaneClip(poly: Pt[], a: Pt, b: Pt, ccw: boolean): Pt[] {
  const sgn = ccw ? 1 : -1
  const side = (p: Pt) => sgn * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const sp = side(p)
    const sq = side(q)
    if (sp >= 0) out.push(p)
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq)
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
    }
  }
  return out
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
  // a ring thinner than 2d inverts through a point reflection, keeping its area sign
  if (out.some((v) => !pointInRings(v, [ring]))) return null
  return out
}

/**
 * clipped minus the no-build strips. A strip none of whose edges touch the
 * clipped shape's bbox is either wholly away from it (no-op) or wholly
 * around it (result empty), so the real polygon difference (km-long strips:
 * the expensive call) is only needed when some strip edge is near the shape.
 */
function subtractNoBuild(
  clipped: MultiPolygon, noBuild: Pt[][], noBuildPolys: MultiPolygon[number][], boxes: Box[],
  nearTie: (pts: Array<readonly [number, number]>) => boolean,
): MultiPolygon {
  if (clipped.length === 0) return clipped
  const coords = clipped.flatMap((poly) => poly.flat())
  const box = boxOf(coords.map(([x, y]) => ({ x, y })))
  let touching = false
  for (let k = 0; k < noBuild.length; k++) {
    const b = boxes[k]
    if (b.x0 > box.x1 + BOX_MARGIN || b.x1 < box.x0 - BOX_MARGIN || b.y0 > box.y1 + BOX_MARGIN || b.y1 < box.y0 - BOX_MARGIN) continue
    const ring = noBuild[k]
    if (ring.some((p, i) => segTouchesBox(p, ring[(i + 1) % ring.length], box))) touching = true
    else if (pointInRings({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, [ring])) return []
  }
  // near-ties would make polygon-clipping snap our coordinates to a strip's: do the real thing
  return touching || nearTie(coords) ? polygonClipping.difference(clipped, ...noBuildPolys) : clipped
}

/**
 * Fill each block's buildable inset with a rotated grid of lots. A lot fully
 * inside a convex inset and outside every no-build ring is kept as-is; a
 * straddling lot is clipped to the inset (and, if any no-build rings exist,
 * to their complement) and kept only if what's left is >= 40 m².
 */

/**
 * Robust inset for the rings the edge-offset `insetRing` rejects (concave
 * blocks whose offset self-intersects): subtract a `d`-wide strip around
 * every edge with polygon-clipping. One library call per block; may split
 * the block into several buildable pieces. Rings come back open.
 */
export function insetByClipping(full: Pt[], d: number): Pt[][] {
  // dense near-collinear vertices (curved streets) make polygon-clipping crawl
  // or hang on the overlapping strips; 0.5 m is far below the inset itself
  const ring = simplifyPolyline([...full, full[0]], 0.5).slice(0, -1)
  const strips: [number, number][][][] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len
    const nx = -uy * d, ny = ux * d
    const ax = a.x - ux * d, ay = a.y - uy * d
    const bx = b.x + ux * d, by = b.y + uy * d
    strips.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]])
  }
  // same nudge ladder as safeClip: translate everything, shift the result back
  let out: MultiPolygon | null = null
  for (const eps of CLIP_NUDGES) {
    try {
      const sh = ([x, y]: [number, number]): [number, number] => [x + eps, y + eps]
      const res = polygonClipping.difference(
        [toRing(ring).map(sh)],
        ...strips.map((s) => s.map((r) => r.map(sh))),
      )
      out = res.map((poly) => poly.map((r) => r.map(([x, y]) => [x - eps, y - eps] as [number, number])))
      break
    } catch {
      continue
    }
  }
  if (!out) return []
  return out.map((poly) => {
    const r = poly[0].map(([x, y]) => ({ x, y }))
    if (r.length > 1 && r[0].x === r[r.length - 1].x && r[0].y === r[r.length - 1].y) r.pop()
    return r
  }).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) >= MIN_BLOCK_AREA)
}

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
  const noBuildBoxes = noBuild.map(boxOf)
  const nearTie = makeNearTieCheck(noBuild.flat().map((p) => [p.x, p.y] as const))
  const buildings: Building[] = []
  let n = 0

  for (const block of blocks) {
    const district = districtById.get(block.districtId)
    if (!district) continue
    const fast = insetRing(block.footprint, SIDEWALK)
    // edge-offset inset for the common case; concave blocks whose offset
    // self-intersects fall back to the clipping inset (possibly several pieces)
    const insets = fast ? [fast] : insetByClipping(block.footprint, SIDEWALK)
    const profile = ZONE_BUILD[district.zone]
    const fill = Math.min(0.98, profile.fill * (0.75 + 0.5 * params.density))
    const theta = longestEdgeAngle(block.footprint)
    for (const inset of insets) {
    if (Math.abs(ringArea(inset)) < MIN_BLOCK_AREA) continue
    // corner tests miss a notch narrower than a lot, so only a convex inset
    // may skip clipping
    const convex = isConvex(inset)
    const insetCcw = ringArea(inset) > 0
    const c = ringCentroid(inset)
    const local = inset.map((p) => rotatePt(p, -theta, c))
    const bbox = bboxOf(local)
    const cell = profile.minCell * (1.25 - 0.5 * params.density)
    const { cells } = bspSplit(bbox, { minCell: cell, gap: 3, jitter: 0.25, rng })

    for (const r of cells) {
        if (!rng.chance(fill)) continue
        // BSP leftovers too thin to be a building
        if (r.w < 0.5 * cell || r.h < 0.5 * cell) continue
        const corners: Pt[] = [
          { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
        ]
        const lot = corners.map((p) => rotatePt(p, theta, c))

        // convex: corner tests suffice. Otherwise count the inset edges touching
        // the lot's bounding box: none = lot wholly in or out, exactly one = a
        // straight cut (half-plane clip of the convex lot), more = real clipper.
        const lb = boxOf(lot)
        let touching = 0
        let hit = 0
        if (!convex) {
          for (let i = 0; i < inset.length && touching < 2; i++)
            if (segTouchesBox(inset[i], inset[(i + 1) % inset.length], lb)) { touching++; hit = i }
          if (touching === 0 && !pointInRings(lot[0], [inset])) continue
        }
        const clear = convex || touching === 0
        const allInside = clear && lot.every((p) =>
          pointInRings(p, [inset]) && noBuild.every((nb) => !pointInRings(p, [nb])))

        let pts: Pt[] | null
        if (allInside) {
          pts = lot
        } else {
          const cut = touching === 1 ? halfPlaneClip(lot, inset[hit], inset[(hit + 1) % inset.length], insetCcw) : null
          pts = largestRing(safeClip(lot, (ring) => {
            const clipped: MultiPolygon = cut ? (cut.length >= 3 ? [[toRing(cut)]] : []) : polygonClipping.intersection([ring], [toRing(inset)])
            return noBuildPolys.length > 0 ? subtractNoBuild(clipped, noBuild, noBuildPolys, noBuildBoxes, nearTie) : clipped
          }))
        }
        if (!pts || Math.abs(ringArea(pts)) < MIN_BUILDING_AREA) continue
        const cen = ringCentroid(pts)
    if (inWater(terrain, cen) || !pointInRings(cen, [block.footprint])) continue

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
