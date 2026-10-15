import * as clip from '../clip'
import { pointInRings, simplifyPolyline, ringArea, ringCentroid, type Pt } from '../geometry'
import { simplifyFace } from './graph'
import { FRONTAGE_OFF, STRIP_HALF } from './highway'
import { distToPolyline } from '../terrain/rivers'
import type { Block, Road } from '../types'
import type { Landmarks } from '../landmarks/place'

export const SIDEWALK = 6
const MIN_BLOCK_AREA = 500

const toRing = (pts: Pt[]): [number, number][] => pts.map((p) => [p.x, p.y])

/** angle of a polygon's longest edge — the lot grid inherits this orientation */
export function longestEdgeAngle(poly: Pt[]): number {
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

/** true when two non-adjacent edges of the ring properly cross (O(n^2); rings here are < ~60 vertices) */
function selfIntersects(r: Pt[]): boolean {
  const n = r.length
  const o = (a: Pt, b: Pt, c: Pt) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = r[i], b = r[(i + 1) % n], c = r[j], d = r[(j + 1) % n]
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true
    }
  return false
}

/**
 * Edge-offset inset: push every edge inward by `d`, then re-intersect each
 * pair of consecutive offset lines for the new vertices. Works for either
 * ring winding (checks `ringArea`'s sign to pick the interior-facing side).
 * ponytail: no miter limit, so a very acute corner can spike far past `d` or
 * flip past the ring's center — caught below (NaN / area flip) and treated
 * as "no usable inset" rather than emitting a spike; switch to
 * a clipper offset if the streets toy shows spikes in practice.
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
  // a concave ring's offset can fold over itself with every vertex still inside: feeding that
  // to the clipper crawls (seed 4280430344 coastal+river+lakes corp 0.85, 4 km)
  if (selfIntersects(out)) return null
  return out
}

/**
 * Robust inset for the rings the edge-offset `insetRing` rejects (concave
 * blocks whose offset self-intersects): subtract a `d`-wide strip around
 * every edge with the clipper. One library call per block; may split
 * the block into several buildable pieces. Rings come back open.
 */
export function insetByClipping(full: Pt[], d: number): Pt[][] {
  // dense near-collinear vertices (curved streets) make the strip
  // difference slow; 0.5 m is far below the inset itself
  full = simplifyFace(full) // zero-area zig-zags (overlapping collinear edges): clipping them changes the result
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
  const out = clip.difference([toRing(ring)], ...strips)
  return out.map((poly) => {
    const r = poly[0].map(([x, y]) => ({ x, y }))
    if (r.length > 1 && r[0].x === r[r.length - 1].x && r[0].y === r[r.length - 1].y) r.pop()
    return r
  }).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) >= MIN_BLOCK_AREA)
}

/**
 * Sub-segments of a-b that lie inside `ring`: split a-b at every ring-edge
 * crossing and keep the pieces whose midpoint is inside. A BSP cut spans the
 * block's whole bbox, so without this an alley pokes out of a rotated or
 * concave block (and over the water next to it).
 */
export function clipSegmentToRing(a: Pt, b: Pt, ring: Pt[]): Array<[Pt, Pt]> {
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

/** a megablock's hive: the block footprint inset by the sidewalk, packed BSP cells clipped to it, and its three longest BSP cuts as alleys */

/** a block in the band between a frontage road and the highway; a kept frontage road must sit beside it (blocks beside a sunken stretch keep their normal style) */
export function isStripBlock(block: Block, highway: Road | undefined, frontage: Road[]): boolean {
  if (!highway || block.flags.arcology || block.flags.megablock) return false
  const cc = ringCentroid(block.footprint)
  // the 80th-percentile distance of the footprint resampled every 10 m, not the centroid (a face from the highway
  // centreline to its frontage road has its centroid right at STRIP_HALF, and on a bend it falls either side) and not
  // raw vertices (a dense near edge would outvote the far side); no vertex may stray past the frontage road by > 10 m
  const fp = block.footprint
  const ds: number[] = []
  let far = 0
  fp.forEach((p, i) => {
    const q = fp[(i + 1) % fp.length]
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 10))
    for (let k = 0; k < n; k++) ds.push(distToPolyline({ x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n }, highway.points))
    far = Math.max(far, ds[ds.length - n])
  })
  ds.sort((a, b) => a - b)
  const hwDist = ds[Math.floor(0.8 * (ds.length - 1))]
  return far <= FRONTAGE_OFF + 10 && hwDist <= FRONTAGE_OFF + 1 && hwDist > STRIP_HALF && frontage.some((f) => distToPolyline(cc, f.points) <= FRONTAGE_OFF + 10)
}

/** the landmark predicates fillLots branches on; selectCompounds uses isLandmarkBlock so it never picks a block fillLots would give to a landmark */
export const ringArcologyOf = (block: Block, landmarks?: Landmarks) => landmarks?.arcologies.find((a) => a.access === 'ring' && pointInRings(ringCentroid(block.footprint), [a.plaza]))
export const megablockOf = (block: Block, landmarks?: Landmarks) => landmarks?.megablocks.find((m) => pointInRings(m.center, [block.footprint]))
export const isLandmarkBlock = (block: Block, landmarks?: Landmarks): boolean => !!(ringArcologyOf(block, landmarks) ?? megablockOf(block, landmarks))

const largestPiece = (pieces: Pt[][]): Pt[] | null => pieces.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0] ?? null
export const insetOrLargest = (ring: Pt[], d: number): Pt[] | null => insetRing(ring, d) ?? largestPiece(insetByClipping(ring, d))

