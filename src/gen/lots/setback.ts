import { ringArea, type Pt } from '../geometry'
import { unionPositive } from '../clip'
import { inWater } from '../sector/bridges'
import { STRIP_HALF, levelAt, nearestT } from '../streets/highway'
import type { RoadIndex } from '../streets/trace'
import { distToPolyline } from '../terrain/rivers'
import type { Road, RoadClass, Terrain } from '../types'

export const SETBACK = { street: 7.5, ramp: 7.0, arterial: 12.0, sunken: 19.0, highway: STRIP_HALF, water: 5.0, window: 0, ground: 6.0, other: 7.5 }

export interface SetbackCtx { index: RoadIndex; highway?: Road; terrain: Terrain; sizeM: number; grounds: Pt[][] }

const BY_CLASS: Record<RoadClass, number> = { street: SETBACK.street, ramp: SETBACK.ramp, arterial: SETBACK.arterial, highway: SETBACK.highway }
const REACH = 2

const dirOf = (a: Pt, b: Pt): Pt => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l } }
/** unit inward normal of a counter-clockwise (ringArea > 0) edge */
const inward = (d: Pt): Pt => ({ x: -d.y, y: d.x })

/** one setback per edge i -> i+1 (R2): the largest of everything within 2 m of the edge midpoint, else 'other' */
export function edgeSetbacks(footprint: Pt[], ctx: SetbackCtx): number[] {
  const sign = ringArea(footprint) >= 0 ? 1 : -1
  return footprint.map((a, i) => {
    const b = footprint[(i + 1) % footprint.length]
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    let s = -1
    ctx.index.forEachInRadius(m, REACH, (seg) => { s = Math.max(s, BY_CLASS[seg.cls]) })
    if (ctx.highway) {
      const { dist, t } = nearestT(m, ctx.highway.points)
      if (dist <= REACH) s = Math.max(s, ctx.highway.segments && levelAt(ctx.highway.segments, t) === 'sunken' ? SETBACK.sunken : SETBACK.highway)
    }
    const n = inward(dirOf(a, b))
    if (inWater(ctx.terrain, { x: m.x - sign * n.x * 3, y: m.y - sign * n.y * 3 })) s = Math.max(s, SETBACK.water)
    if (Math.min(m.x, m.y, ctx.sizeM - m.x, ctx.sizeM - m.y) <= REACH) s = Math.max(s, SETBACK.window)
    if (ctx.grounds.some((g) => distToPolyline(m, [...g, g[0]]) <= REACH)) s = Math.max(s, SETBACK.ground)
    return s < 0 ? SETBACK.other : s
  })
}

/** counter-clockwise ring with its per-edge values (reversal re-maps the edges) */
const ccw = (ring: Pt[], vals: number[]): { ring: Pt[]; vals: number[] } => {
  if (ringArea(ring) >= 0) return { ring, vals }
  const n = ring.length
  return { ring: [...ring].reverse(), vals: ring.map((_, j) => vals[(n - 2 - j + 2 * n) % n]) }
}

const MIN_PIECE = 200
const SMALL_TURN = (10 * Math.PI) / 180
const SIDE_TURN = (25 * Math.PI) / 180

/** R3: inward offset by per-edge setbacks, bisector joins, positive-fill union; CCW pieces >= 200 m². Holes are dropped (ponytail: a pinched ring that closes on itself loses its courtyard). */
export function buildable(footprint: Pt[], setbacks: number[]): Pt[][] {
  const { ring, vals } = ccw(footprint, setbacks)
  const n = ring.length
  const d = ring.map((a, i) => dirOf(a, ring[(i + 1) % n]))
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n
    const v = ring[i]
    const [dp, dc, np, nc] = [d[p], d[i], inward(d[p]), inward(d[i])]
    const [sp, sc] = [vals[p], vals[i]]
    const cross = dp.x * dc.y - dp.y * dc.x
    const turn = Math.atan2(cross, dp.x * dc.x + dp.y * dc.y)
    if (cross > 0 && Math.abs(turn) >= SMALL_TURN) {
      // convex and sharp: lines meet; fall back to the bisector when the meeting point is too far out
      const p1 = { x: v.x + np.x * sp, y: v.y + np.y * sp }
      const p2 = { x: v.x + nc.x * sc, y: v.y + nc.y * sc }
      const t = ((p2.x - p1.x) * dc.y - (p2.y - p1.y) * dc.x) / cross
      const x = { x: p1.x + dp.x * t, y: p1.y + dp.y * t }
      if (Math.hypot(x.x - v.x, x.y - v.y) <= 2 * Math.max(sp, sc)) { out.push(x); continue }
    }
    const l = Math.hypot(np.x + nc.x, np.y + nc.y) || 1
    const b = { x: (np.x + nc.x) / l, y: (np.y + nc.y) / l }
    const ka = sp / Math.max(0.1, b.x * np.x + b.y * np.y)
    const kb = sc / Math.max(0.1, b.x * nc.x + b.y * nc.y)
    out.push({ x: v.x + b.x * ka, y: v.y + b.y * ka }, { x: v.x + b.x * kb, y: v.y + b.y * kb })
  }
  return unionPositive(out.map((q) => [q.x, q.y]))
    .map((poly) => poly[0].slice(0, -1).map(([x, y]) => ({ x, y })))
    .filter((r) => ringArea(r) >= MIN_PIECE)
}

export interface Side { pts: Pt[]; chord: [Pt, Pt]; setback: number }

/** R4: maximal chains of edges turning < 25° between consecutive edges with one setback class */
export function sidesOf(piece: Pt[], edgeSetback?: number[]): Side[] {
  const n = piece.length
  const sb = (i: number) => edgeSetback?.[i] ?? 0
  const d = piece.map((a, i) => dirOf(a, piece[(i + 1) % n]))
  const brk = (i: number) => { // break between edge i-1 and edge i
    const p = (i + n - 1) % n
    return sb(p) !== sb(i) || Math.abs(Math.atan2(d[p].x * d[i].y - d[p].y * d[i].x, d[p].x * d[i].x + d[p].y * d[i].y)) >= SIDE_TURN
  }
  const start = Array.from({ length: n }, (_, i) => i).find(brk)
  if (start === undefined) return [{ pts: [...piece, piece[0]], chord: [piece[0], piece[n >> 1]], setback: sb(0) }] // ponytail: closed smooth ring, chord = diameter
  const sides: Side[] = []
  let pts: Pt[] = []
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (k > 0 && brk(i)) { pts.push(piece[i]); sides.push({ pts, chord: [pts[0], piece[i]], setback: sb((i + n - 1) % n) }); pts = [] }
    pts.push(piece[i])
  }
  pts.push(piece[start])
  sides.push({ pts, chord: [pts[0], piece[start]], setback: sb((start + n - 1) % n) })
  return sides
}

/** setback of each piece edge: the footprint edge whose offset line holds its midpoint (±0.05 m); bisector joins take the previous edge's */
export function pieceSetbacks(piece: Pt[], footprint: Pt[], setbacks: number[]): number[] {
  const f = ccw(footprint, setbacks)
  const fn = f.ring.length
  const res: (number | undefined)[] = piece.map((a, j) => {
    const b = piece[(j + 1) % piece.length]
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    // an offset line runs past its edge's span where a bisector join extends it: by the larger adjacent setback at each end
    let best = -1, bestGap = Infinity
    f.ring.forEach((p, k) => {
      const q = f.ring[(k + 1) % fn]
      const dk = dirOf(p, q), nk = inward(dk), len = Math.hypot(q.x - p.x, q.y - p.y)
      if (Math.abs((m.x - p.x) * nk.x + (m.y - p.y) * nk.y - f.vals[k]) > 0.05) return
      const along = (m.x - p.x) * dk.x + (m.y - p.y) * dk.y
      const lo = -Math.max(f.vals[k], f.vals[(k + fn - 1) % fn]) - 0.05
      const hi = len + Math.max(f.vals[k], f.vals[(k + 1) % fn]) + 0.05
      if (along < lo || along > hi) return
      const gap = Math.max(0, -along, along - len) // distance to the un-extended span; ties keep the first
      if (gap < bestGap) { best = k; bestGap = gap }
    })
    return best < 0 ? undefined : f.vals[best]
  })
  const n = res.length
  for (let pass = 0; pass < 2; pass++) for (let j = 0; j < n; j++) if (res[j] === undefined) res[j] = res[(j + n - 1) % n]
  return res.map((v) => v ?? SETBACK.other)
}
