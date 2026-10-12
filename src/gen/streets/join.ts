import { angleGapLines, PARALLEL_ANGLE, pointAtT, pointInRings, polylineLength, type Pt } from '../geometry'
import { RING_ID_PREFIX } from '../landmarks/place'
import { inWater, nearWater } from '../sector/bridges'
import type { Road, Terrain } from '../types'
import { smoothBends } from './smooth'
import type { RoadIndex } from './trace'

/** how far along the target road (fraction of separation) a join aims past the foot */
export const JOIN_AHEAD = 0.5
/** end pass: how far (fraction of separation) a dangling end may reach for a road to join */
const JOIN_REACH = 1.5
/** end pass: widest angle from the end's heading to a join target */
const JOIN_CONE = Math.PI / 2

/** a join this short (m) is a straight connector, not a cubic */
const JOIN_SNAP = 40

/** angle at which a join curve meets the target road */
const JOIN_ARRIVE = (60 * Math.PI) / 180

/**
 * Cubic Bezier from p, leaving along dir, ending exactly on target at JOIN_ARRIVE to the target road
 * (`tangent`: that road's unit direction at target, sign irrelevant), arriving from p's side. The first
 * sample is excluded (p is already on the road); null when `reject` is true for any sample.
 */
export function joinCurve(p: Pt, dir: Pt, target: Pt, tangent: Pt, reject: (q: Pt, dirAt: Pt) => boolean): Pt[] | null {
  const len = Math.hypot(target.x - p.x, target.y - p.y)
  if (len <= JOIN_SNAP) {
    const dl = len || 1, d = { x: (target.x - p.x) / dl, y: (target.y - p.y) / dl }
    const k = Math.max(3, Math.ceil(len / 10)) // every 10 m, at least 2 interior samples
    for (let i = 1; i <= k; i++) {
      const q = i === k ? target : { x: p.x + ((target.x - p.x) * i) / k, y: p.y + ((target.y - p.y) * i) / k }
      if (reject(q, d)) return null
    }
    return [{ x: target.x, y: target.y }]
  }
  const f = tangent.x * dir.x + tangent.y * dir.y < 0 ? -1 : 1
  const t = { x: f * tangent.x, y: f * tangent.y }
  let n = { x: -t.y, y: t.x }
  if (n.x * (p.x - target.x) + n.y * (p.y - target.y) < 0) n = { x: -n.x, y: -n.y }
  // a walker already heading into the road more steeply than JOIN_ARRIVE keeps its own heading (a grid T stays straight)
  const a = -(n.x * dir.x + n.y * dir.y) > Math.sin(JOIN_ARRIVE) ? dir
    : { x: t.x * Math.cos(JOIN_ARRIVE) - n.x * Math.sin(JOIN_ARRIVE), y: t.y * Math.cos(JOIN_ARRIVE) - n.y * Math.sin(JOIN_ARRIVE) }
  const c1 = { x: p.x + dir.x * (len / 3), y: p.y + dir.y * (len / 3) }
  const c2 = { x: target.x - a.x * (len / 3), y: target.y - a.y * (len / 3) }
  const m = Math.max(4, Math.ceil(len / 10))
  const out: Pt[] = []
  let prev = p
  for (let i = 1; i <= m; i++) {
    const s = i / m, u = 1 - s
    const q = i === m ? { x: target.x, y: target.y } : {
      x: u * u * u * p.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * target.x,
      y: u * u * u * p.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * target.y,
    }
    const dl = Math.hypot(q.x - prev.x, q.y - prev.y) || 1
    if (reject(q, { x: (q.x - prev.x) / dl, y: (q.y - prev.y) / dl })) return null
    prev = q
    out.push(q)
  }
  return out
}

const END_TRY = 8

/**
 * End pass: a non-ring arterial end that is still free (not on a road, the window edge or water)
 * curves into the nearest arterial ahead of it, instead of being pruned later.
 */
export function joinFreeEnds(
  roads: Road[], terrain: Terrain, sizeM: number, index: RoadIndex, obstacles: Pt[][], separation: number,
): { roads: Road[]; joined: number } {
  const out = roads.slice()
  let joined = 0
  const inWindow = (q: Pt) => q.x >= 0 && q.y >= 0 && q.x <= sizeM && q.y <= sizeM
  const onEdge = (q: Pt) => q.x < 1 || q.y < 1 || q.x > sizeM - 1 || q.y > sizeM - 1
  // order-dependent: an end rejected early can succeed once a neighbour has joined
  for (let pass = 0, before = -1; pass < 3 && joined !== before; pass++) {
    before = joined
    for (let ri = 0; ri < out.length; ri++) {
      const road = out[ri]
      if (road.class !== 'arterial' || road.id.startsWith(RING_ID_PREFIX)) continue
      let pts = road.points
      for (const atStart of [true, false]) {
        if (pts.length < 2) break
        const fwd = atStart ? pts.slice().reverse() : pts
        const end = fwd[fwd.length - 1]
        const other = fwd[0]
        if (onEdge(end) || nearWater(terrain, end, 15) || index.nearestMatching(end, 6, (h) => h.id !== road.id && h.cls === 'arterial')) continue
        const back = pointAtT(fwd, Math.max(0, 1 - 20 / polylineLength(fwd)))
        const hl = Math.hypot(end.x - back.x, end.y - back.y)
        if (hl === 0) continue
        const dir = { x: (end.x - back.x) / hl, y: (end.y - back.y) / hl }
        const byRoad = new Map<string, { id: string; at: Pt; dist: number; ang: number }>()
        index.forEachInRadius(end, JOIN_REACH * separation, (seg, at, dist, edge) => {
          if (seg.cls !== 'arterial' || seg.id === road.id || edge < 30) return
          const vx = at.x - end.x, vy = at.y - end.y
          const vl = Math.hypot(vx, vy)
          if (vl > 0 && Math.acos(Math.max(-1, Math.min(1, (vx * dir.x + vy * dir.y) / vl))) > JOIN_CONE) return
          // nearest segment per road, so one road cannot eat the whole END_TRY budget
          if (!((byRoad.get(seg.id)?.dist ?? Infinity) <= dist)) byRoad.set(seg.id, { id: seg.id, at, dist, ang: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x) })
        })
        const cands = [...byRoad.values()].sort((a, b) => a.dist - b.dist)
        for (const c of cands.slice(0, END_TRY)) {
          // a road with both ends on one road is a hairpin
          if (index.nearestMatching(other, 6, (h) => h.id === c.id)) continue
          const reject = (q: Pt, dirAt: Pt) => inWater(terrain, q) || !inWindow(q)
            || obstacles.some((r) => pointInRings(q, [r]))
            || !!index.nearestMatching(q, 0.15 * separation, (h) => h.id !== road.id && h.id !== c.id && h.cls === 'arterial' && angleGapLines(Math.atan2(dirAt.y, dirAt.x), h.segAngle) < PARALLEL_ANGLE)
          const curve = joinCurve(end, dir, c.at, { x: Math.cos(c.ang), y: Math.sin(c.ang) }, reject)
          if (!curve) continue
          const pinned = (v: Pt, t: number) => !!index.nearestMatching(v, t + 6, (h) => h.id !== road.id && h.edge < 1)
          const grown = smoothBends([...fwd, ...curve], 60, pinned)
          pts = atStart ? grown.reverse() : grown
          index.remove(road.id)
          index.add(road.id, pts, 'arterial')
          out[ri] = { ...road, points: pts }
          joined++
          break
        }
      }
    }
  }
  return { roads: out, joined }
}
