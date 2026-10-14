import { pointAtT, polylineLength, type Pt } from '../geometry'
import { nearestOnPolyline } from '../terrain/rivers'
import type { Road } from '../types'
import { RoadIndex } from './trace'

/** cheap reject: bounding boxes (each padded by `pad`) don't even overlap, so no point of `a` can be within `pad` of `b` */
export function bboxesFar(a: Pt[], b: Pt[], pad: number): boolean {
  const box = (pts: Pt[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    return { minX, minY, maxX, maxY }
  }
  const ba = box(a)
  const bb = box(b)
  return ba.maxX + pad < bb.minX || bb.maxX + pad < ba.minX || ba.maxY + pad < bb.minY || bb.maxY + pad < ba.minY
}

/** longest contiguous arc-length run (sampled along `a`, 10 m steps) where a's distance to `b` stays under `threshold` */
export function maxCloseRun(a: Pt[], b: Pt[], threshold: number): number {
  const lenA = polylineLength(a)
  const steps = Math.max(1, Math.round(lenA / 10))
  let run = 0
  let maxRun = 0
  for (let s = 0; s <= steps; s++) {
    const pt = pointAtT(a, s / steps)
    const { dist } = nearestOnPolyline(pt, b)
    if (dist < threshold) run += lenA / steps
    else { maxRun = Math.max(maxRun, run); run = 0 }
  }
  return Math.max(maxRun, run)
}

/** for each end (within 6 m of another arterial/highway) of each arterial: meeting line angle (deg) and arc distance of the foot from the target's ends */
export function endMeetings(roads: Road[], extra: Road[] = []): Array<{ id: string; deg: number; edge: number; end: Pt; cls: string; through: boolean }> {
  const idx = new RoadIndex(200)
  for (const r of [...roads, ...extra]) idx.add(r.id, r.points, r.class)
  const out: Array<{ id: string; deg: number; edge: number; end: Pt; cls: string; through: boolean }> = []
  for (const r of roads.filter((x) => x.class === 'arterial')) {
    const p = r.points
    for (const [e, prev] of [[p[0], p[1]], [p[p.length - 1], p[p.length - 2]]] as const) {
      if (!prev) continue
      const hit = idx.nearestMatching(e, 6, (h) => h.id !== r.id && (h.cls === 'arterial' || h.cls === 'highway'))
      if (!hit) continue
      let d = Math.abs(Math.atan2(e.y - prev.y, e.x - prev.x) - hit.segAngle) % Math.PI
      if (d > Math.PI / 2) d = Math.PI - d
      // through: the end lands on the TIP of another road and carries on in the same direction (two roads end to end, one bend), not a V or a side merge
      const tp = roads.concat(extra).find((x) => x.id === hit.id)?.points
      let through = false
      if (tp && hit.edge < 1 && tp.length > 1) {
        const atStart = Math.hypot(tp[0].x - e.x, tp[0].y - e.y) <= Math.hypot(tp[tp.length - 1].x - e.x, tp[tp.length - 1].y - e.y)
        const [t0, t1] = atStart ? [tp[0], tp[1]] : [tp[tp.length - 1], tp[tp.length - 2]]
        through = (e.x - prev.x) * (t1.x - t0.x) + (e.y - prev.y) * (t1.y - t0.y) > 0
      }
      out.push({ id: r.id, deg: (d * 180) / Math.PI, edge: hit.edge, end: e, cls: hit.cls, through })
    }
  }
  return out
}

/** largest direction change (degrees) at any interior vertex */
export function maxBendDeg(pts: Pt[]): number {
  let m = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
    let d = Math.abs(b - a)
    if (d > Math.PI) d = 2 * Math.PI - d
    m = Math.max(m, (d * 180) / Math.PI)
  }
  return m
}
