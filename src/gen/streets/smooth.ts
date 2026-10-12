import type { Pt } from '../geometry'

const BEND_MIN = (15 * Math.PI) / 180
const SMOOTH_STEP = 10

/**
 * Replace every polyline bend sharper than BEND_MIN by a circular fillet of
 * radius `minRadius` (shrunk so each arc takes at most half of either leg),
 * sampled every SMOOTH_STEP m. Legs are measured on the original polyline, so
 * neighbouring arcs never overlap. Endpoints and `pinned` vertices stay sharp;
 * `pinned` gets the tangent length t the fillet would use, since an arc starts t before its vertex.
 */
export function smoothBends(points: Pt[], minRadius: number, pinned?: (v: Pt, t: number) => boolean): Pt[] {
  if (points.length < 3) return points
  const out: Pt[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], v = points[i], b = points[i + 1]
    const l1 = Math.hypot(v.x - a.x, v.y - a.y), l2 = Math.hypot(b.x - v.x, b.y - v.y)
    if (l1 === 0 || l2 === 0) { out.push(v); continue }
    const d1 = { x: (v.x - a.x) / l1, y: (v.y - a.y) / l1 }
    const d2 = { x: (b.x - v.x) / l2, y: (b.y - v.y) / l2 }
    const cross = d1.x * d2.y - d1.y * d2.x
    const theta = Math.atan2(Math.abs(cross), d1.x * d2.x + d1.y * d2.y)
    if (theta <= BEND_MIN) { out.push(v); continue }
    const tan = Math.tan(theta / 2)
    const t = Math.min(minRadius * tan, Math.min(l1, l2) / 2)
    if (pinned?.(v, t)) { out.push(v); continue }
    const r = t / tan
    const s = { x: v.x - t * d1.x, y: v.y - t * d1.y }
    const sign = cross > 0 ? 1 : -1
    const c = { x: s.x - sign * r * d1.y, y: s.y + sign * r * d1.x }
    const n = Math.max(2, Math.ceil((r * theta) / SMOOTH_STEP))
    const a0 = Math.atan2(s.y - c.y, s.x - c.x)
    for (let k = 0; k <= n; k++) {
      const ang = a0 + (sign * theta * k) / n
      const q = { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) }
      const last = out[out.length - 1]
      if (Math.hypot(q.x - last.x, q.y - last.y) >= 0.5) out.push(q)
    }
  }
  out.push(points[points.length - 1])
  return out
}
