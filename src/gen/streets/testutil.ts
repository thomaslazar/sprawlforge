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
export function endMeetings(roads: Road[], extra: Road[] = []): Array<{ id: string; deg: number; edge: number; end: Pt; cls: string }> {
  const idx = new RoadIndex(200)
  for (const r of [...roads, ...extra]) idx.add(r.id, r.points, r.class)
  const out: Array<{ id: string; deg: number; edge: number; end: Pt; cls: string }> = []
  for (const r of roads.filter((x) => x.class === 'arterial')) {
    const p = r.points
    for (const [e, prev] of [[p[0], p[1]], [p[p.length - 1], p[p.length - 2]]] as const) {
      if (!prev) continue
      const hit = idx.nearestMatching(e, 6, (h) => h.id !== r.id && (h.cls === 'arterial' || h.cls === 'highway'))
      if (!hit) continue
      let d = Math.abs(Math.atan2(e.y - prev.y, e.x - prev.x) - hit.segAngle) % Math.PI
      if (d > Math.PI / 2) d = Math.PI - d
      out.push({ id: r.id, deg: (d * 180) / Math.PI, edge: hit.edge, end: e, cls: hit.cls })
    }
  }
  return out
}
