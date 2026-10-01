import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { BOX_MARGIN, boxOf, bboxOf, bspSplit, makeNearTieCheck, pointInRings, segTouchesBox, simplifyPolyline, type Box, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { fractalNoise2D } from '../terrain/noise'
import { inWater } from '../sector/bridges'
import type { Block, BlockStyle, Building, District, SectorParams, Terrain, ZoneType } from '../types'

export const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }> = {
  corp: { minCell: 60, fill: 0.7 },
  residential: { minCell: 30, fill: 0.85 },
  slum: { minCell: 18, fill: 0.95 },
  industrial: { minCell: 80, fill: 0.8 },
  entertainment: { minCell: 35, fill: 0.85 },
  docks: { minCell: 70, fill: 0.75 },
}

export const SIDEWALK = 6
const BUCKET = 200
const MIN_BLOCK_AREA = 500
const MIN_BUILDING_AREA = 40

/**
 * Corridor of a polyline buffered by `half` each side: one small rectangle per
 * segment, extended `half` past both ends so bends leave no wedge gap. Small
 * rings keep each lot's polygon difference cheap (a km-long ring would not).
 */
export function corridorRects(line: Pt[], half: number): Pt[][] {
  const out: Pt[][] = []
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    if (l < 1e-6) continue
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l
    const [ax, ay, bx, by] = [a.x - ux * half, a.y - uy * half, b.x + ux * half, b.y + uy * half]
    out.push([
      { x: ax - uy * half, y: ay + ux * half }, { x: bx - uy * half, y: by + ux * half },
      { x: bx + uy * half, y: by - ux * half }, { x: ax + uy * half, y: ay - ux * half },
    ])
  }
  return out
}

const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])

/** largest-by-area outer ring of a clip result, or null if empty */
function largestRing(result: MultiPolygon): Pt[] | null {
  let best: Pt[] | null = null
  let bestArea = 0
  for (const poly of result) {
    for (const r of poly) {
      const pts = r.map(([x, y]) => ({ x, y }))
      // polygon-clipping rings are closed: drop the repeated first vertex
      if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop()
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

/** convex `poly` minus convex `rect`, as disjoint convex pieces (one half-plane cut per rect edge) */
function subtractConvex(poly: Pt[], rect: Pt[]): Pt[][] {
  const ccw = ringArea(rect) > 0
  const pieces: Pt[][] = []
  let cur = poly
  for (let i = 0; i < rect.length && cur.length >= 3; i++) {
    const a = rect[i], b = rect[(i + 1) % rect.length]
    const out = halfPlaneClip(cur, b, a, ccw)
    if (out.length >= 3) pieces.push(out)
    cur = halfPlaneClip(cur, a, b, ccw)
  }
  return pieces
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
  near: (box: Box) => number[], convexNb: boolean[],
  nearTie: (pts: Array<readonly [number, number]>) => boolean,
): MultiPolygon {
  if (clipped.length === 0) return clipped
  const coords = clipped.flatMap((poly) => poly.flat())
  const box = boxOf(coords.map(([x, y]) => ({ x, y })))
  const hit: number[] = []
  const cand = near(box)
  for (const k of cand) {
    const b = boxes[k]
    if (b.x0 > box.x1 + BOX_MARGIN || b.x1 < box.x0 - BOX_MARGIN || b.y0 > box.y1 + BOX_MARGIN || b.y1 < box.y0 - BOX_MARGIN) continue
    const ring = noBuild[k]
    if (ring.some((p, i) => segTouchesBox(p, ring[(i + 1) % ring.length], box))) hit.push(k)
    else if (pointInRings({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, [ring])) return []
  }
  // lot minus convex strips: exact half-plane cuts, no polygon-clipping call
  if (hit.length > 0 && clipped.length === 1 && clipped[0].length === 1 && hit.every((k) => convexNb[k])) {
    const r0 = clipped[0][0]
    const closed = r0.length > 1 && r0[0][0] === r0[r0.length - 1][0] && r0[0][1] === r0[r0.length - 1][1]
    const lot = (closed ? r0.slice(0, -1) : r0).map(([x, y]) => ({ x, y }))
    if (lot.length >= 3 && isConvex(lot)) {
      // only the largest piece survives (callers keep largestRing), so don't let pieces fragment
      let piece = lot
      for (const k of hit) {
        const next = subtractConvex(piece, noBuild[k])
        if (next.length === 0) return []
        piece = next.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a))
      }
      return [[toRing(piece)]]
    }
  }
  // near-ties would make polygon-clipping snap our coordinates to a strip's: do the real thing
  if (hit.length === 0 && !nearTie(coords)) return clipped
  // one strip at a time: a single n-ary difference over dozens of overlapping corridor rects can stall the clipper
  let cur = clipped
  for (const k of hit.length ? hit : cand) {
    if (cur.length === 0) break
    cur = polygonClipping.difference(cur, noBuildPolys[k])
  }
  return cur
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

const NOTCH_P: Record<BlockStyle, number> = { plaza: 0.5, courtyard: 0.35, rows: 0.1, sheds: 0 }

/**
 * Notch to cut from rect `r`: a corner square (L) or a side slot (U), 30-45 %
 * per side, overshooting the rect edge by 1 m so the cut never shares an edge.
 */
function notchOf(r: { x: number; y: number; w: number; h: number }, rng: { next(): number; chance(p: number): boolean }): Pt[] {
  const nw = r.w * (0.3 + 0.15 * rng.next())
  const nh = r.h * (0.3 + 0.15 * rng.next())
  const u = rng.chance(0.5)
  const flipX = rng.chance(0.5)
  const flipY = rng.chance(0.5)
  const x0 = u ? (r.w - nw) / 2 : -1
  const pts: Pt[] = [{ x: x0, y: -1 }, { x: x0 + nw + (u ? 0 : 1), y: -1 }, { x: x0 + nw + (u ? 0 : 1), y: nh }, { x: x0, y: nh }]
  return pts.map((p) => ({ x: r.x + (flipX ? r.w - p.x : p.x), y: r.y + (flipY ? r.h - p.y : p.y) }))
}

const boxesOverlap = (a: Box, b: Box) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const MIN_STYLED_AREA = 3000

/** block style from zone, sector density and ~500 m neighbourhood noise (0..1) */
export function chooseStyle(zone: ZoneType, density: number, neighbourhood: number): BlockStyle {
  const d = clamp01(density * 0.6 + neighbourhood * 0.6 - 0.1)
  if (zone === 'industrial') return 'sheds'
  if (zone === 'docks') return d < 0.5 ? 'sheds' : 'rows'
  if (zone === 'corp') return d < 0.6 ? 'plaza' : 'rows'
  // ponytail: thresholds 0.45/0.25 (design said 0.55/0.3) so rows hold 30-90 % at density 0.5
  if (d >= 0.45) return 'rows'
  if (d >= 0.25 || zone === 'slum') return 'courtyard'
  return 'plaza'
}

/**
 * Buildings plus the blocks annotated with their style and alley segments.
 * `forceStyle` overrides the style choice (tests).
 */

/**
 * Sub-segments of a-b that lie inside `ring`: split a-b at every ring-edge
 * crossing and keep the pieces whose midpoint is inside. A BSP cut spans the
 * block's whole bbox, so without this an alley pokes out of a rotated or
 * concave block (and over the water next to it).
 */
function clipSegmentToRing(a: Pt, b: Pt, ring: Pt[]): Array<[Pt, Pt]> {
  const ts = [0, 1]
  const dx = b.x - a.x, dy = b.y - a.y
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    const ex = q.x - p.x, ey = q.y - p.y
    const den = dx * ey - dy * ex
    if (Math.abs(den) < 1e-12) continue
    const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den
    const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
  }
  ts.sort((x, y) => x - y)
  const out: Array<[Pt, Pt]> = []
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1], t1 = ts[i]
    if (t1 - t0 < 1e-9) continue
    const mid = { x: a.x + dx * (t0 + t1) / 2, y: a.y + dy * (t0 + t1) / 2 }
    if (pointInRings(mid, [ring]))
      out.push([{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }])
  }
  return out
}

export function fillLots(
  districts: District[],
  blocks: Block[],
  params: SectorParams,
  terrain: Terrain,
  noBuild: Pt[][],
  forceStyle?: BlockStyle,
): { buildings: Building[]; blocks: Block[] } {
  const rng = mulberry32(hashSeed(params.seed, 'buildings'))
  // own stream: notches must not reshuffle the lots the main stream lays out
  const notchRng = mulberry32(hashSeed(params.seed, 'notches'))
  const neighbourhood = fractalNoise2D(hashSeed(params.seed, 'neighbourhood'), 2)
  const districtById = new Map(districts.map((d) => [d.id, d]))
  const noBuildPolys = noBuild.map((nb) => [toRing(nb)])
  const noBuildBoxes = noBuild.map(boxOf)
  const convexNb = noBuild.map(isConvex)
  // 200 m grid of strip indices: a lot only looks at strips whose bbox shares a cell with it
  const grid = new Map<string, number[]>()
  noBuildBoxes.forEach((b, k) => {
    for (let gx = Math.floor((b.x0 - BOX_MARGIN) / BUCKET); gx <= Math.floor((b.x1 + BOX_MARGIN) / BUCKET); gx++)
      for (let gy = Math.floor((b.y0 - BOX_MARGIN) / BUCKET); gy <= Math.floor((b.y1 + BOX_MARGIN) / BUCKET); gy++) {
        const key = gx + ',' + gy
        const l = grid.get(key)
        if (l) l.push(k); else grid.set(key, [k])
      }
  })
  const near = (box: Box): number[] => {
    const out = new Set<number>()
    for (let gx = Math.floor(box.x0 / BUCKET); gx <= Math.floor(box.x1 / BUCKET); gx++)
      for (let gy = Math.floor(box.y0 / BUCKET); gy <= Math.floor(box.y1 / BUCKET); gy++)
        for (const k of grid.get(gx + ',' + gy) ?? []) out.add(k)
    return [...out]
  }
  const nearTie = makeNearTieCheck(noBuild.flat().map((p) => [p.x, p.y] as const))
  const buildings: Building[] = []
  const outBlocks: Block[] = []
  let n = 0

  for (const block of blocks) {
    const district = districtById.get(block.districtId)
    if (!district) { outBlocks.push(block); continue }
    const cc = ringCentroid(block.footprint)
    const chosen = forceStyle ?? chooseStyle(district.zone, params.density, neighbourhood(cc.x / 500, cc.y / 500))
    let blockStyle: BlockStyle = 'rows'
    const alleys: Array<[Pt, Pt]> = []
    const fast = insetRing(block.footprint, SIDEWALK)
    // edge-offset inset for the common case; concave blocks whose offset
    // self-intersects fall back to the clipping inset (possibly several pieces)
    const insets = fast ? [fast] : insetByClipping(block.footprint, SIDEWALK)
    const profile = ZONE_BUILD[district.zone]
    const fill = Math.min(0.98, profile.fill * (0.55 + 0.5 * params.density))
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
    // blocks are ~100 m now (street separation), so a zone's minCell alone
    // (60-80 m for corp/industrial/docks) would leave most blocks as ONE
    // lot filling the whole block; cap the cell so a block splits into at
    // least ~2×2 lots, never below 18 m (the slum lot size)
    const zoneCell = profile.minCell * (1.3 - 0.6 * params.density)
    const cell = Math.min(zoneCell, Math.max(18, 0.45 * Math.min(bbox.w, bbox.h)))
    const style: BlockStyle = Math.abs(ringArea(inset)) < MIN_STYLED_AREA ? 'rows' : chosen
    if (style !== 'rows') blockStyle = style
    const short = Math.min(bbox.w, bbox.h)
    const st = {
      rows: { cell, gap: 3, fill },
      courtyard: { cell, gap: 3, fill: 0.9 },
      plaza: { cell: Math.max(profile.minCell * 1.6, 0.4 * short), gap: 12, fill: 0.6 },
      sheds: { cell: profile.minCell, gap: 10, fill: 0.65 },
    }[style]
    // courtyard: only the band between the inset and a deeper inset is buildable
    let inner: Pt[][] = []
    if (style === 'courtyard') {
      const depth = 18 + 8 * rng.next()
      const deep = insetRing(inset, depth)
      // a 3 m simplify keeps polygon-clipping from stalling on dense curved insets
      inner = deep ? [deep] : insetByClipping(simplifyPolyline([...inset, inset[0]], 3).slice(0, -1), depth)
    }
    const bsp = bspSplit(bbox, { minCell: st.cell, gap: st.gap, jitter: 0.25, rng })
    if (style === 'rows')
      for (const { axis, strip } of bsp.cuts) {
        const [a, b] = axis === 'x'
          ? [{ x: strip.x + strip.w / 2, y: strip.y }, { x: strip.x + strip.w / 2, y: strip.y + strip.h }]
          : [{ x: strip.x, y: strip.y + strip.h / 2 }, { x: strip.x + strip.w, y: strip.y + strip.h / 2 }]
        const [wa, wb] = [rotatePt(a, theta, c), rotatePt(b, theta, c)]
        for (const piece of clipSegmentToRing(wa, wb, inset)) alleys.push(piece)
      }
    // BSP leftovers too thin to be a building
    let cells = bsp.cells.filter((r) => r.w >= 0.5 * st.cell && r.h >= 0.5 * st.cell)
    if (style === 'plaza') {
      const max = district.zone === 'corp' ? rng.int(1, 2) : rng.int(1, 3)
      cells = cells.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, max)
    }

    for (const r of cells) {
        if (!rng.chance(st.fill)) continue
        const corners: Pt[] = [
          { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
        ]
        // the lot is clipped as a plain rect (fast paths intact), then notched
        const notch = notchRng.chance(NOTCH_P[style]) ? notchOf(r, notchRng).map((p) => rotatePt(p, theta, c)) : null
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
        const lotNear = clear ? near(lb) : []
        const inInset = clear && lot.every((p) => pointInRings(p, [inset]))
        // a strip can cross a lot without any corner inside it, so also demand no strip edge reaches the lot
        const allInside = inInset && lot.every((p) => lotNear.every((k) => !pointInRings(p, [noBuild[k]])))
          && lotNear.every((k) => !boxesOverlap(noBuildBoxes[k], lb) || !noBuild[k].some((p, i) => segTouchesBox(p, noBuild[k][(i + 1) % noBuild[k].length], lb)))

        let pts: Pt[] | null
        if (allInside) {
          pts = lot
        } else {
          const cut = touching === 1 ? halfPlaneClip(lot, inset[hit], inset[(hit + 1) % inset.length], insetCcw) : null
          pts = largestRing(safeClip(lot, (ring) => {
            const clipped: MultiPolygon = inInset ? [[ring]] : cut ? (cut.length >= 3 ? [[toRing(cut)]] : []) : polygonClipping.intersection([ring], [toRing(inset)])
            return noBuildPolys.length > 0 ? subtractNoBuild(clipped, noBuild, noBuildPolys, noBuildBoxes, near, convexNb, nearTie) : clipped
          }))
        }
        if (pts && notch) {
          const lp = pts
          pts = largestRing(safeClip(lp, (ring) => polygonClipping.difference([ring], [toRing(notch)])))
        }
        if (pts && inner.length) {
          // lot minus the courtyard: a lot clear of every courtyard edge is wholly in or out
          const lp = pts
          const pb = boxOf(lp)
          if (inner.some((r) => r.some((p, i) => segTouchesBox(p, r[(i + 1) % r.length], pb))))
            pts = largestRing(safeClip(lp, (ring) => polygonClipping.difference([ring], ...inner.map((r) => [toRing(r)]))))
          else if (inner.some((r) => pointInRings(lp[0], [r]))) pts = null
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
    outBlocks.push({ ...block, style: blockStyle, alleys })
  }

  return { buildings, blocks: outBlocks }
}
